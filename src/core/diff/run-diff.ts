/**
 * Run Diff entry point: two parsed Traces of the same task in, an aligned,
 * ranked, explained diff out. Works across harnesses (Claude Code vs Codex) and
 * within one (two Claude Code attempts).
 */

import type { Trace } from "../types.ts";
import { alignSteps } from "./align.ts";
import { normalizeTrace } from "./normalize.ts";
import { explainDivergence, rankDivergences } from "./rank.ts";
import { type DiffStep, isFailure, type RunDiff, type RunSide, type RunVerdict } from "./types.ts";

const HARNESS_LABEL: Record<string, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
};

/**
 * Coarse end state, from evidence only. A run passed when its last test run
 * both exited successfully and printed the runner's passing summary; it failed
 * when that run failed by exit status or by its summary; anything in between is
 * unclear. Runs without tests fall back to the harness completion signal.
 */
export function runVerdict(
	trace: Trace,
	steps: DiffStep[],
): { verdict: RunVerdict; reason: string } {
	for (let i = steps.length - 1; i >= 0; i--) {
		const s = steps[i] as DiffStep;
		if (s.action !== "test") continue;
		const name = `\`${s.target ?? "tests"}\``;
		if (isFailure(s.status))
			return {
				verdict: "failed",
				reason: `last test run ${name} ${s.summary === "fail" ? "reported failing tests" : "exited with a failure"}`,
			};
		if (s.status === "ok" && s.summary === "pass")
			return { verdict: "passed", reason: `last test run ${name} exited cleanly and reported passing tests` };
		if (s.status === "ok")
			return { verdict: "unclear", reason: `last test run ${name} exited cleanly but printed no passing summary` };
		if (s.summary === "pass")
			return { verdict: "unclear", reason: `last test run ${name} reported passing tests but its exit status is unknown` };
		return { verdict: "unclear", reason: `last test run ${name} has no clear result` };
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
