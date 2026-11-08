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
	const firstDiff = diff.firstDifferenceRow;
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
			document.getElementById(`rd-row-${flagged.pivotRow}`)?.scrollIntoView({ block: "nearest" });
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
								? `Only cosmetic differences · first at row ${flagged.pivotRow + 1}`
								: `Divergence that mattered · row ${flagged.pivotRow + 1}`}
					</span>
					{flagged ? (
						<button type="button" className="rd-btn rd-btn--small" onClick={() => jump(flagged.pivotRow)}>
							{flagged.cosmetic ? "jump to it" : "jump to fork"}
						</button>
					) : null}
				</div>
				<p className="rd-callout__text">{withCode(diff.explanation)}</p>
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
						const isPivot = flagged?.pivotRow === r.row;
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
