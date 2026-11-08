/**
 * Run Diff entry point: two parsed Traces of the same task in, an aligned,
 * ranked, explained diff out. Works across harnesses (Claude Code vs Codex) and
 * within one (two Claude Code attempts).
 */

import type { Trace } from "../types.ts";
import { alignSteps } from "./align.ts";
import { normalizeTrace } from "./normalize.ts";
import { explainDivergence, rankDivergences } from "./rank.ts";
import type { DiffStep, RunDiff, RunSide, RunVerdict } from "./types.ts";

const HARNESS_LABEL: Record<string, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
};

/** Coarse end state: the last test run wins, else the harness completion signal. */
export function runVerdict(
	trace: Trace,
	steps: DiffStep[],
): { verdict: RunVerdict; reason: string } {
	for (let i = steps.length - 1; i >= 0; i--) {
		const s = steps[i] as DiffStep;
		if (s.action !== "test") continue;
		const ok = s.status === "ok";
		return {
			verdict: ok ? "passed" : "failed",
			reason: `last test run \`${s.target ?? "tests"}\` ${ok ? "passed" : "failed"}`,
		};
	}
	if (trace.run.outcome?.status === "completed")
		return { verdict: "completed", reason: "the agent reported the task complete" };
	return { verdict: "unfinished", reason: "the run ended without a completion signal" };
}

export function harnessLabel(trace: Trace): string {
	const name = trace.run.harness.name;
	return HARNESS_LABEL[name] ?? name;
}

function side(trace: Trace, label: string): RunSide {
	const steps = normalizeTrace(trace);
	const { verdict, reason } = runVerdict(trace, steps);
	return {
		label,
		harness: trace.run.harness.name,
		model: trace.run.model ?? null,
		steps,
		verdict,
		verdictReason: reason,
	};
}

/**
 * Diff two runs. Lane labels default to the harness names; when both runs come
 * from the same harness they become "<harness> A" / "<harness> B".
 */
export function diffRuns(
	leftTrace: Trace,
	rightTrace: Trace,
	labels?: { left?: string; right?: string },
): RunDiff {
	let lLabel = labels?.left ?? harnessLabel(leftTrace);
	let rLabel = labels?.right ?? harnessLabel(rightTrace);
	if (lLabel === rLabel) {
		lLabel = `${lLabel} A`;
		rLabel = `${rLabel} B`;
	}
	const left = side(leftTrace, lLabel);
	const right = side(rightTrace, rLabel);
	const { rows, truncated } = alignSteps(left.steps, right.steps);
	const blocks = rankDivergences(rows, left, right);
	const flagged = blocks[0] ?? null;
	const first = rows.find((r) => r.relation !== "same" || r.statusDiffers);
	return {
		left,
		right,
		rows,
		blocks,
		flagged,
		firstDifferenceRow: first ? first.row : null,
		explanation: explainDivergence(flagged, rows, left, right),
		truncated,
	};
}
