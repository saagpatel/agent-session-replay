import { Fragment, useEffect, useMemo, useState } from "react";

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

export function RunDiffView({
	diff,
	leftFile,
	rightFile,
}: {
	diff: RunDiff;
	leftFile: string;
	rightFile: string;
}) {
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
		</main>
	);
}
