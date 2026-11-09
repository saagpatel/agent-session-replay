import { Fragment, useEffect, useMemo, useState } from "react";

import type { ArtifactCheck } from "../../core/diff/branch/artifact-check.ts";
import { buildBranchGraph } from "../../core/diff/branch/model.ts";
import { branchReport, type BranchReport } from "../../core/diff/branch/report.ts";
import type { BranchGraph } from "../../core/diff/branch/types.ts";
import { expand } from "../../core/diff/equiv/expand.ts";
import { RULES } from "../../core/diff/equiv/rules.ts";
import type { CanonicalEvent, EquivalentAlignment } from "../../core/diff/equiv/types.ts";
import { diffRunsEquivalent } from "../../core/diff/run-diff.ts";
import type {
	DiffAction,
	DiffRow,
	DiffStep,
	RunDiff,
	RunSide,
	RunVerdict,
} from "../../core/diff/types.ts";
import { foldRows } from "../../core/diff/fold.ts";
import { provenlyDifferent } from "../../core/diff/rank.ts";
import { isFailure } from "../../core/diff/types.ts";
import type { Trace } from "../../core/types.ts";

export type RunDiffMode = "linear" | "equivalence" | "preservation";

const ACTION_VAR: Record<DiffAction, string> = {
	read: "--rd-read",
	search: "--rd-read",
	edit: "--kind-agent",
	write: "--kind-agent",
	test: "--kind-tool",
	run: "--kind-llm",
	plan: "--accent",
	delegate: "--kind-agent",
	web: "--faint",
	compaction: "--kind-compaction",
	blocked: "--sev-critical",
	other: "--faint",
};

/** What Run Diff marks unknown and why; mirrored in the README. */
const KNOWN_LIMITS = [
	"A run passed only when its last test run exited cleanly and printed the runner's passing summary. Piped or chained tests (`npm test | tail`, `npm test; git diff`) are unclear: the exit status belongs to another command.",
	"Codex `exec` cells are read only when they are straight-line, with each tool call printing its own result once. Branches, `Promise.all`, unprinted calls or extra prints make every call in the cell unknown.",
	"A piped command's own result is unknown (`npm run build | grep x` exits with grep's status), as is anything before the end of a `;` chain or in a directory a dynamic `cd` hides. Commands built by joining strings show as unparsed.",
	"A patch counts as applied only when its own output confirms it. A tool call whose result never arrived, such as a cut-off run or a yielded command never polled, is unknown.",
];

const VERDICT_TEXT: Record<RunVerdict, string> = {
	passed: "tests passed",
	failed: "tests failed",
	unclear: "result unclear",
	completed: "completed",
	unfinished: "unfinished",
};

/** Render `code` spans inside the plain-text explanation. */
function withCode(text: string) {
	return text.split("`").map((part, i) =>
		i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>,
	);
}

function LaneHead({ side, fileName }: { side: RunSide; fileName: string }) {
	return (
		<div className="rd-lane-head">
			<div className="rd-lane-head__top">
				<strong>{side.label}</strong>
				<span className={`rd-verdict rd-verdict--${side.verdict}`}>
					{VERDICT_TEXT[side.verdict]}
				</span>
			</div>
			<div className="rd-lane-head__meta">
				<span>{side.model ?? "model unknown"}</span>
				<span>{side.steps.length} steps</span>
				<span className="rd-lane-head__file" title={fileName}>
					{fileName}
				</span>
			</div>
			<div className="rd-lane-head__why">ended: {side.verdictReason}</div>
		</div>
	);
}

function Cell({ step, side }: { step: DiffStep | null; side: "left" | "right" }) {
	if (!step) return <div className={`rd-cell rd-cell--${side} rd-cell--empty`} aria-hidden="true" />;
	const failed = isFailure(step.status);
	// Missing results only matter for commands and tests, not reads.
	// Never guess: every step without a recorded result says so.
	const unknown = step.status === "unknown";
	return (
		<div
			className={`rd-cell rd-cell--${side}${failed ? " rd-cell--err" : ""}`}
			title={step.error ?? step.label}
		>
			<span
				className="rd-act"
				style={{ ["--c" as string]: `var(${ACTION_VAR[step.action]})` }}
			>
				{step.action}
			</span>
			<span className="rd-cell__target">{step.target ?? step.note ?? ""}</span>
			{failed ? <span className="rd-cell__fail">✕ {step.status === "interrupted" ? "interrupted" : "failed"}</span> : null}
			{unknown ? (
				<span className="rd-cell__unknown" title="No result recorded for this step on its own">
					? unclear
				</span>
			) : null}
		</div>
	);
}

const MARK: Record<DiffRow["relation"], string> = {
	same: "",
	changed: "~",
	"left-only": "◂",
	"right-only": "▸",
};

const MODES: ReadonlyArray<{ id: RunDiffMode; label: string }> = [
	{ id: "linear", label: "Linear" },
	{ id: "equivalence", label: "Work Equivalence" },
	{ id: "preservation", label: "Branch Preservation" },
];

const TRACE_TOOLTIP = "Load both transcripts to use this mode.";

/** Display the evidence encoded by equivalence normalization, not inferred tool output. */
function eventEvidence(event: CanonicalEvent | null): string | null {
	if (!event) return null;
	if (event.action === "read") {
		return event.range ? `lines ${event.range.start}–${event.range.end}` : "whole file or unknown range";
	}
	let parts: unknown;
	try { parts = JSON.parse(event.key); } catch {
		return (event.action === "test" || event.action === "run") && event.target ? `command ${event.target}` : null;
	}
	if (!Array.isArray(parts)) return null;
	if (parts[0] === "search" && typeof parts[2] === "string" && parts[3] && typeof parts[3] === "object") {
		const { pattern, ...options } = parts[3] as Record<string, unknown>;
		return `pattern ${JSON.stringify(pattern)} · path ${parts[2]}${Object.keys(options).length ? ` · options ${JSON.stringify(options)}` : ""}`;
	}
	if (parts[0] === "search-shell" && Array.isArray(parts[2]) && typeof parts[3] === "string" && Array.isArray(parts[4])) {
		return `pattern ${JSON.stringify(parts[3])} · path ${parts[4].join(", ")} · options ${parts[1]} ${parts[2].join(" ")}`;
	}
	if (parts[0] === "edit" && Array.isArray(parts[2])) {
		const clip = (text: string) => {
			const line = text.split(/\r?\n/, 1)[0] ?? "";
			return JSON.stringify(line.length > 80 ? `${line.slice(0, 80)}…` : line);
		};
		return parts[2].map((edit: { old?: unknown; next?: unknown }) =>
			typeof edit.old === "string" && typeof edit.next === "string" ? `${clip(edit.old)} → ${clip(edit.next)}` : "unknown edit",
		).join("; ");
	}
	if (parts[0] === "write-content" && typeof parts[2] === "string" && typeof parts[3] === "string") {
		return `content fingerprint ${parts[2].slice(0, 8)}`;
	}
	if (parts[0] === "execution") return `command ${typeof parts[1] === "string" ? parts[1] : JSON.stringify(parts[1])}`;
	if ((event.action === "test" || event.action === "run") && event.target) return `command ${event.target}`;
	return null;
}

function writePreview(event: CanonicalEvent): string | null {
	try {
		const parts: unknown = JSON.parse(event.key);
		if (!Array.isArray(parts) || parts[0] !== "write-content" || typeof parts[3] !== "string") return null;
		const lines = parts[3].split(/\r?\n/);
		const preview = lines.slice(0, 3).map((line: string) => line.length > 120 ? `${line.slice(0, 120)}…` : line).join("\n");
		return lines.length > 3 ? `${preview}\n…` : preview;
	} catch {
		return null;
	}
}

/** Plain wording for Work Equivalence incomplete-reason codes. */
const INCOMPLETE_PLAIN: Record<string, string> = {
	"normalizer-cap-or-unsupported-shape":
		"A command was too large, or shaped in a way the comparison cannot read in full.",
	"unsupported-source": "A step comes from a tool or command the equivalence rules do not cover.",
	"missing-source": "A normalized step has no source record to check.",
	"unclassified-step": "A read, edit, or write could not be tied to a file.",
	"unknown-mutator-status": "An edit, write, test, run, or similar step has no recorded result.",
	"alignment-truncated": "The runs are long enough that alignment stopped before the end.",
	"malformed-transcript": "The transcript has lines that could not be parsed.",
	"exec-source-coverage-unknown": "A Codex exec cell may hide steps, so coverage is not proven.",
};

function plainReason(code: string): string {
	return INCOMPLETE_PLAIN[code] ?? code.replaceAll("-", " ");
}

function ModeSwitch({
	mode,
	tracesReady,
	onChange,
}: {
	mode: RunDiffMode;
	tracesReady: boolean;
	onChange: (mode: RunDiffMode) => void;
}) {
	return (
		<div className="rd-modes" role="radiogroup" aria-label="Comparison mode">
			{MODES.map((option) => {
				const disabled = option.id !== "linear" && !tracesReady;
				const button = (
					<button
						type="button"
						role="radio"
						aria-checked={mode === option.id}
						className={`rd-modes__btn${mode === option.id ? " rd-modes__btn--on" : ""}`}
						disabled={disabled}
						onClick={() => onChange(option.id)}
					>
						{option.label}
					</button>
				);
				// A disabled control does not show its own title, so the wrapper carries the tooltip.
				return disabled ? (
					<span key={option.id} className="rd-modes__tip" title={TRACE_TOOLTIP}>
						{button}
					</span>
				) : (
					<Fragment key={option.id}>{button}</Fragment>
				);
			})}
		</div>
	);
}

function EquivCell({
	event,
	steps,
	side,
	evidence,
	evidenceDiffers,
}: {
	event: CanonicalEvent | null;
	steps: DiffStep[];
	side: "left" | "right";
	evidence: string | null;
	evidenceDiffers: boolean;
}) {
	if (!event) return <div className={`rd-cell rd-cell--${side} rd-cell--empty`} aria-hidden="true" />;
	const failed = isFailure(event.status);
	const unknown = event.status === "unknown";
	const originals = expand(event, steps);
	const unsupported = event.action === "other" || event.target === null;
	const preview = writePreview(event);
	return (
		<div className={`rd-cell rd-cell--eq rd-cell--${side}${failed ? " rd-cell--err" : ""}`}>
			<div className="rd-eq-main">
				<span className="rd-act" style={{ ["--c" as string]: `var(${ACTION_VAR[event.action]})` }}>
					{unsupported ? originals[0]?.label : event.action}
				</span>
				{unsupported ? <span className="rd-rule">unsupported</span> : <span className="rd-cell__target">{event.target}</span>}
				{event.rule ? (
					<span className="rd-rule">
						{event.rule}
						<span className="rd-rule__count">{event.members.length}</span>
					</span>
				) : null}
				{failed ? (
					<span className="rd-cell__fail">✕ {event.status === "interrupted" ? "interrupted" : "failed"}</span>
				) : null}
				{unknown ? (
					<span className="rd-cell__unknown" title="No result recorded for this step on its own">
						? unclear
					</span>
				) : null}
			</div>
			<span className="rd-eq-evidence">{originals.map((step) => step.label).join(" · ")}</span>
			{evidence ? <span className={`rd-eq-evidence${evidenceDiffers ? " rd-eq-evidence--changed" : ""}`}>{evidence}</span> : null}
			{preview !== null ? (
				<details className={`rd-eq-originals${evidenceDiffers ? " rd-eq-evidence--changed" : ""}`}>
					<summary>Content preview (first 3 lines)</summary>
					<pre>{preview}</pre>
				</details>
			) : null}
			<details className="rd-eq-originals">
				<summary>
					{event.members.length} original {event.members.length === 1 ? "step" : "steps"}
				</summary>
				<ul>
					{originals.map((step, index) => (
						<li key={`${step.stepId}:${step.index}:${index}`}>
							<span className="rd-eq-original__label">{step.label}</span>
							<code className="rd-eq-original__id">{step.stepId}</code>
							<span className="rd-eq-original__status">{step.status}</span>
						</li>
					))}
				</ul>
			</details>
		</div>
	);
}

function equivalenceVerdict(alignment: EquivalentAlignment): "equivalent" | "divergent" | "incomplete" {
	if (alignment.equivalent) return "equivalent";
	if (alignment.incomplete) return "incomplete";
	return "divergent";
}

const VERDICT_LABEL = {
	equivalent: "Equivalent",
	divergent: "Divergent",
	incomplete: "Incomplete",
} as const;

function WorkEquivalence({
	diff,
	leftFile,
	rightFile,
	leftTrace,
	rightTrace,
}: {
	diff: RunDiff;
	leftFile: string;
	rightFile: string;
	leftTrace: Trace;
	rightTrace: Trace;
}) {
	const alignment = useMemo(() => diffRunsEquivalent(leftTrace, rightTrace), [leftTrace, rightTrace]);
	const verdict = equivalenceVerdict(alignment);
	return (
		<>
			<section className={`rd-verdict-banner rd-verdict-banner--${verdict}`} aria-label="Work equivalence verdict">
				<h2 className="rd-verdict-banner__title">{VERDICT_LABEL[verdict]}</h2>
				{verdict === "equivalent" ? (
					<p className="rd-verdict-banner__text">These runs do the same work under the equivalence rules.</p>
				) : null}
				{verdict === "divergent" ? (
					<p className="rd-verdict-banner__text">
						{alignment.divergences.length} aligned {alignment.divergences.length === 1 ? "event differs" : "events differ"}.
					</p>
				) : null}
				{verdict === "incomplete" ? (
					<>
						<p className="rd-verdict-banner__text">Equivalence is not proven.</p>
						<ul className="rd-verdict-banner__reasons">
							{alignment.incompleteReasons.map((reason) => (
								<li key={reason}>{plainReason(reason)}</li>
							))}
						</ul>
						{alignment.divergences.length > 0 ? (
							<p className="rd-verdict-banner__text">Some aligned events also differ.</p>
						) : null}
					</>
				) : null}
			</section>
			<section
				className="rd-grid"
				aria-label={`${diff.left.label} versus ${diff.right.label}, aligned by equivalent work`}
			>
				<div className="rd-grid__head">
					<div className="rd-gutter">
						<span className="label">row</span>
					</div>
					<div>
						<LaneHead side={diff.left} fileName={leftFile} />
					</div>
					<div className="rd-mark" aria-label="relation" />
					<div>
						<LaneHead side={diff.right} fileName={rightFile} />
					</div>
				</div>
				<div className="rd-grid__body">
					{alignment.rows.map((row) => {
						const leftEvidence = eventEvidence(row.left);
						const rightEvidence = eventEvidence(row.right);
						const evidenceDiffers = row.relation !== "same" && (leftEvidence !== rightEvidence || row.left?.key !== row.right?.key);
						const highlightSame = row.relation === "same" && row.statusDiffers;
						const cls = [
							"rd-row",
							`rd-row--${row.relation}`,
							highlightSame ? "rd-row--changed" : "",
							row.statusDiffers ? "rd-row--status" : "",
						]
							.filter(Boolean)
							.join(" ");
						return (
							<div className={cls} key={row.row}>
								<div className="rd-gutter">
									<span className="rd-gutter__n">{row.row + 1}</span>
								</div>
								<div>
									<EquivCell event={row.left} steps={alignment.left.steps} side="left" evidence={leftEvidence} evidenceDiffers={evidenceDiffers} />
								</div>
								<div className="rd-mark" aria-label={row.relation}>
									{row.statusDiffers ? "!" : MARK[row.relation]}
								</div>
								<div>
									<EquivCell event={row.right} steps={alignment.right.steps} side="right" evidence={rightEvidence} evidenceDiffers={evidenceDiffers} />
								</div>
							</div>
						);
					})}
				</div>
			</section>
			<footer className="rd-rules">
				<p className="label">Rules</p>
				<ul>
					{RULES.map((rule) => (
						<li key={rule.id}>
							<code>{rule.id}</code> {rule.description}
						</li>
					))}
				</ul>
			</footer>
		</>
	);
}

/**
 * Feed branchReport the structural status buildBranchGraph already stored.
 * The app has no repository snapshot, so the commit linker is not called.
 */
function structuralCheck(graph: BranchGraph): ArtifactCheck {
	const branches = new Map(graph.branches.map((branch) => [branch.id, branch]));
	return {
		claim: { status: "no-claim", sha: null },
		effects: [],
		claimedButUnchanged: [],
		steps: graph.nodes.map((node) => {
			const branch = branches.get(node.branchId);
			if (node.action === "edit" || node.action === "write") {
				const effects = graph.editEffects.filter((effect) => effect.node.stepId === node.stepId && effect.node.part === node.part);
				const incomplete = !graph.endStateComplete || effects.some((effect) => graph.endState[effect.file] === null);
				const statuses = new Set(effects.map((effect) => effect.lineage));
				const status = incomplete || effects.length === 0 ? "unknown" : statuses.size === 1 ? effects[0]!.lineage : "partial";
				return {
					node, status, source: "structure" as const,
					reason: incomplete ? "The file's end state is incomplete." : effects.length === 0 ? "No edit or write lineage was proven." : status === "unknown" ? "The edit or write lineage could not be reconstructed." : "Run end-state lineage; commit link not checked.",
				};
			}
			return {
				node,
				status: branch?.structuralStatus ?? "unknown",
				source: "structure",
				reason: branch?.reasons.join(" ") ?? "",
			};
		}),
	};
}

function droppedFile(group: BranchReport["abandoned"][number]): string {
	const targets = [
		...new Set(
			group.steps
				.flatMap((step) => step.nodes.map((node) => node.target))
				.filter((target): target is string => Boolean(target)),
		),
	];
	if (targets.length === 0) return "no file";
	if (targets.length === 1) return targets[0] ?? "no file";
	return `${targets.length} files`;
}

function ReportStepList({ steps, showReason = false }: { steps: BranchReport["retained"]; showReason?: boolean }) {
	if (steps.length === 0) return <p className="rd-branch__empty">None</p>;
	return (
		<ol className="rd-branch__list">
			{steps.map((step) => (
				<li key={step.id}>
					{step.nodes.map((node) => (
						<span key={`${node.stepId}:${node.part}`} className="rd-branch__step">
							<span
								className="rd-act"
								style={{ ["--c" as string]: `var(${ACTION_VAR[node.action]})` }}
							>
								{node.action}
							</span>
							<span className="rd-branch__target">{node.target ?? ""}</span>
							<code>{node.stepId}</code>
							<span className="rd-branch__status">{node.status}</span>
						</span>
					))}
					{showReason && step.reason ? <span className="rd-branch__reason">{step.reason}</span> : null}
				</li>
			))}
		</ol>
	);
}

function BranchLane({
	label,
	fileName,
	trace,
}: {
	label: string;
	fileName: string;
	trace: Trace;
}) {
	const report = useMemo(() => {
		const graph = buildBranchGraph(trace, {});
		return branchReport(graph, structuralCheck(graph), trace);
	}, [trace]);
	const collapseDropped = report.abandoned.length > 6;
	return (
		<section className="rd-branch__lane" aria-label={`${label} branch preservation`}>
			<header className="rd-branch__head">
				<strong>{label}</strong>
				<span className="rd-branch__file" title={fileName}>
					{fileName}
				</span>
			</header>
			<h3>Retained</h3>
			<ReportStepList steps={report.retained} />
			<h3>Attempted and dropped</h3>
			{report.abandoned.length === 0 ? (
				<p className="rd-branch__empty">None</p>
			) : (
				<div className="rd-branch__drops">
					{report.abandoned.map((group) => (
						<details key={group.branchId} className="rd-branch-drop" open={!collapseDropped}>
							<summary>
								<span className="rd-branch-drop__summary">
									<span className="rd-branch-drop__kind">{group.kind}</span>
									<span className="rd-branch-drop__file">{droppedFile(group)}</span>
									<span className="rd-branch-drop__count">
										{group.steps.length} {group.steps.length === 1 ? "step" : "steps"}
									</span>
									<span className="rd-branch-drop__why" title={group.reason}>
										{group.reason}
									</span>
								</span>
							</summary>
							<ReportStepList steps={group.steps} />
						</details>
					))}
				</div>
			)}
			{report.unknown.length > 0 ? (
				<>
					<h3>Unknown</h3>
					<ReportStepList steps={report.unknown} showReason />
				</>
			) : null}
		</section>
	);
}

function BranchPreservation({
	diff,
	leftFile,
	rightFile,
	leftTrace,
	rightTrace,
}: {
	diff: RunDiff;
	leftFile: string;
	rightFile: string;
	leftTrace: Trace;
	rightTrace: Trace;
}) {
	return (
		<section className="rd-branch" aria-label="Branch preservation">
			<p className="rd-branch__note">Commit link not checked: no repository snapshot loaded</p>
			<div className="rd-branch__lanes">
				<BranchLane label={diff.left.label} fileName={leftFile} trace={leftTrace} />
				<BranchLane label={diff.right.label} fileName={rightFile} trace={rightTrace} />
			</div>
		</section>
	);
}

export function RunDiffView({
	diff,
	leftFile,
	rightFile,
	leftTrace,
	rightTrace,
	mode: initialMode = "linear",
}: {
	diff: RunDiff;
	leftFile: string;
	rightFile: string;
	leftTrace?: Trace;
	rightTrace?: Trace;
	mode?: RunDiffMode;
}) {
	const [mode, setMode] = useState<RunDiffMode>(initialMode);
	const tracesReady = leftTrace != null && rightTrace != null;
	const shown: RunDiffMode = mode === "linear" || tracesReady ? mode : "linear";
	const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
	const items = useMemo(() => foldRows(diff.rows, expanded), [diff.rows, expanded]);
	const flagged = diff.flagged;
	// The row the callout points at: a real fork's pivot, a cosmetic block's start.
	const markRow = flagged ? (flagged.cosmetic ? flagged.startRow : flagged.pivotRow) : -1;
	const firstDiff = diff.firstDifferenceRow;
	// Only call a fork "the divergence that mattered" when the outcomes provably differ.
	const provenOutcome = provenlyDifferent(diff.left, diff.right);
	const firstIsElsewhere =
		firstDiff !== null && flagged !== null && (firstDiff < flagged.startRow || firstDiff > flagged.endRow);
	const counts = useMemo(() => {
		const c = { same: 0, changed: 0, "left-only": 0, "right-only": 0 };
		for (const r of diff.rows) c[r.relation]++;
		return c;
	}, [diff.rows]);

	const jump = (row: number) => {
		// Unfold whatever hides the row, then scroll once it renders.
		setExpanded((prev) => {
			const next = new Set(prev);
			for (const it of foldRows(diff.rows, prev))
				if (it.type === "fold" && row >= it.from && row <= it.to) next.add(it.from);
			return next;
		});
		requestAnimationFrame(() =>
			document.getElementById(`rd-row-${row}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
		);
	};

	useEffect(() => {
		if (flagged)
			document.getElementById(`rd-row-${markRow}`)?.scrollIntoView({ block: "nearest" });
	}, [flagged]);

	return (
		<main className="rd">
			<ModeSwitch mode={shown} tracesReady={tracesReady} onChange={setMode} />
			{shown === "equivalence" && leftTrace && rightTrace ? (
				<WorkEquivalence
					diff={diff}
					leftFile={leftFile}
					rightFile={rightFile}
					leftTrace={leftTrace}
					rightTrace={rightTrace}
				/>
			) : shown === "preservation" && leftTrace && rightTrace ? (
				<BranchPreservation
					diff={diff}
					leftFile={leftFile}
					rightFile={rightFile}
					leftTrace={leftTrace}
					rightTrace={rightTrace}
				/>
			) : (
			<>
			<section
				className={`rd-callout${!flagged || flagged.cosmetic ? " rd-callout--calm" : ""}`}
				aria-labelledby="rd-callout-title"
			>
				<div className="rd-callout__head">
					<span className="label" id="rd-callout-title">
						{!flagged
							? "No divergence"
							: flagged.cosmetic
								? `Only cosmetic differences · first at row ${markRow + 1}`
								: provenOutcome
									? `Divergence that mattered · row ${markRow + 1}`
									: `Biggest change in approach · row ${markRow + 1}`}
					</span>
					{flagged ? (
						<button type="button" className="rd-btn rd-btn--small" onClick={() => jump(markRow)}>
							{flagged.cosmetic ? "jump to it" : "jump to fork"}
						</button>
					) : null}
				</div>
				<p className="rd-callout__text">{withCode(diff.explanation)}</p>
				<details className="rd-limits">
					<summary>
						<span className="rd-experimental">experimental</span> known limits
					</summary>
					<ul>
						{KNOWN_LIMITS.map((l) => (
							<li key={l}>{withCode(l)}</li>
						))}
					</ul>
				</details>
				<div className="rd-callout__foot">
					{(flagged && !flagged.cosmetic ? flagged.reasons : []).map((r) => (
						<span key={r} className="rd-reason">
							{r}
						</span>
					))}
					{firstIsElsewhere && firstDiff !== null ? (
						<button type="button" className="linklike rd-first" onClick={() => jump(firstDiff)}>
							first difference at row {firstDiff + 1} was {diff.blocks.find((b) => firstDiff >= b.startRow && firstDiff <= b.endRow)?.cosmetic ? "cosmetic" : "ranked lower"} →
						</button>
					) : null}
				</div>
				{diff.truncated.left || diff.truncated.right ? (
					<p className="rd-callout__trunc">
						Long runs: aligned the first {diff.left.steps.length - diff.truncated.left} and{" "}
						{diff.right.steps.length - diff.truncated.right} steps; the rest were left out.
					</p>
				) : null}
			</section>

			<section className={`rd-grid${flagged?.cosmetic ? " rd-grid--calm" : ""}`} aria-label={`${diff.left.label} versus ${diff.right.label}, aligned step by step`}>
				<div className="rd-grid__head">
					<div className="rd-gutter">
						<span className="label">row</span>
					</div>
					<div>
						<LaneHead side={diff.left} fileName={leftFile} />
					</div>
					<div className="rd-mark" aria-label="relation" />
					<div>
						<LaneHead side={diff.right} fileName={rightFile} />
					</div>
				</div>
				<div className="rd-legend">
					<span>{counts.same} same</span>
					<span>~ {counts.changed} changed</span>
					<span>◂ {counts["left-only"]} only {diff.left.label}</span>
					<span>▸ {counts["right-only"]} only {diff.right.label}</span>
				</div>
				<div className="rd-grid__body">
					{items.map((it) => {
						if (it.type === "fold") {
							const n = it.to - it.from + 1;
							return (
								<div className="rd-fold" key={`f${it.from}`}>
									<button
										type="button"
										onClick={() => setExpanded((prev) => new Set(prev).add(it.from))}
									>
										⋯ {n} identical steps (rows {it.from + 1}–{it.to + 1}) · show
									</button>
								</div>
							);
						}
						const r = it.row;
						const inFlag = flagged !== null && r.row >= flagged.startRow && r.row <= flagged.endRow;
						const isPivot = markRow === r.row;
						const isFirst = firstIsElsewhere && firstDiff === r.row;
						const cls = [
							"rd-row",
							`rd-row--${r.relation}`,
							r.statusDiffers ? "rd-row--status" : "",
							inFlag ? "rd-row--flag" : "",
							isPivot ? "rd-row--pivot" : "",
						]
							.filter(Boolean)
							.join(" ");
						return (
							<div className={cls} id={`rd-row-${r.row}`} key={r.row}>
								<div className="rd-gutter">
									<span className="rd-gutter__n">{r.row + 1}</span>
									{isPivot ? (
										<span className="rd-tag rd-tag--pivot">
											{flagged?.cosmetic ? "first" : "◆ fork"}
										</span>
									) : null}
									{isFirst ? <span className="rd-tag">first</span> : null}
								</div>
								<div>
									<Cell step={r.left} side="left" />
								</div>
								<div className="rd-mark" aria-label={r.relation}>
									{r.statusDiffers ? "!" : MARK[r.relation]}
								</div>
								<div>
									<Cell step={r.right} side="right" />
								</div>
							</div>
						);
					})}
				</div>
			</section>
			</>
			)}
		</main>
	);
}
