/**
 * Detector engine: Trace -> ranked Finding[].
 *
 * Each detector is a pure `(trace) => Finding[]` that reads only the attribute
 * keys the Claude Code / Codex parsers emit (see `ATTR`). The engine runs all of
 * them, flattens, and ranks by severity tier then magnitude. Adding a signal is
 * adding one function to `ALL_DETECTORS` — no other file changes.
 *
 * Thresholds live in `THRESHOLDS` so the diagnostic posture is tunable in one
 * place rather than scattered as magic numbers across detectors.
 */

import { ATTR, type Step, type Trace } from "../types.ts";
import {
	type Detector,
	type Finding,
	SEVERITY_RANK,
	type Severity,
} from "./types.ts";

export const THRESHOLDS = {
	/** Distinct guard tripped >= this many times is a cluster (agent vs. a wall). */
	guardCluster: 3,
	guardCritical: 5,
	/** A subagent burning >= this many total tokens is a cost runaway. */
	subagentWarnTokens: 150_000,
	subagentCriticalTokens: 400_000,
	/** Non-guard tool failures >= this is an error spike. */
	toolErrorSpike: 8,
	toolErrorCritical: 20,
	/** Compaction boundaries >= this signals context thrash. */
	compactionThrash: 2,
	compactionCritical: 4,
	/** Contiguous tool-call streak confined to <=2 distinct tools, within one
	 * execution lane (main context or a single subagent), reads as a grind loop.
	 * Codex tier calibrated against S3 transcript mining: real grind loops ran
	 * 2,228-2,372 calls of exec_command/write_stdin; legitimate build-test loops
	 * stay well under 100. CC tier is set much higher because a long two-tool
	 * cadence (Bash/Edit across a big sweep) is normal CC working style. */
	grindStreak: 120,
	grindStreakCritical: 400,
	grindStreakCc: 300,
	grindStreakCcCritical: 900,
} as const;

function numAttr(s: Step, key: string): number {
	const v = s.attributes[key];
	return typeof v === "number" ? v : 0;
}
function strAttr(s: Step, key: string): string | undefined {
	const v = s.attributes[key];
	return typeof v === "string" ? v : undefined;
}
function tier(value: number, warnAt: number, critAt: number): Severity {
	return value >= critAt ? "critical" : value >= warnAt ? "warning" : "info";
}

/** Distinct guards that tripped enough times to count as the agent fighting a wall. */
const guardTripCluster: Detector = (trace) => {
	const byName = new Map<string, Step[]>();
	for (const s of trace.steps) {
		if (!s.attributes[ATTR.GUARD_TRIPPED]) continue;
		const name = strAttr(s, ATTR.GUARD_NAME) ?? "unknown";
		const bucket = byName.get(name);
		if (bucket) bucket.push(s);
		else byName.set(name, [s]);
	}
	const out: Finding[] = [];
	for (const [name, steps] of byName) {
		const [first] = steps;
		if (!first || steps.length < THRESHOLDS.guardCluster) continue;
		const reason = strAttr(first, ATTR.GUARD_REASON);
		out.push({
			id: `guard_trip_cluster:${name}`,
			kind: "guard_trip_cluster",
			severity: tier(
				steps.length,
				THRESHOLDS.guardCluster,
				THRESHOLDS.guardCritical,
			),
			title: `Guard '${name}' tripped ${steps.length}×`,
			detail: `The agent hit the '${name}' guard ${steps.length} times${
				reason ? ` (e.g. "${reason}")` : ""
			} — repeated denials on the same wall usually mean it never found a legal path.`,
			step_ids: steps.map((s) => s.step_id),
			score: steps.length,
		});
	}
	return out;
};

/** Any stale-read hint is a Read-to-Edit race: the file moved under the edit. */
const staleReadRace: Detector = (trace) => {
	const steps = trace.steps.filter((s) => s.attributes[ATTR.STALE_READ]);
	if (steps.length === 0) return [];
	return [
		{
			id: "stale_read_race",
			kind: "stale_read_race",
			severity: "warning",
			title: `Read-to-Edit race on ${steps.length} edit${steps.length === 1 ? "" : "s"}`,
			detail:
				"An edit fired against a file whose on-disk state had changed since it was read " +
				"(staleReadFileStateHint). The edit may have clobbered or missed concurrent changes.",
			step_ids: steps.map((s) => s.step_id),
			score: steps.length,
		},
	];
};

/** Subagents whose total token burn crossed the runaway threshold. */
const subagentCostRunaway: Detector = (trace) => {
	const out: Finding[] = [];
	for (const s of trace.steps) {
		if (s.kind !== "agent") continue;
		const tokens = numAttr(s, ATTR.AGENT_TOTAL_TOKENS);
		if (tokens < THRESHOLDS.subagentWarnTokens) continue;
		const type = strAttr(s, ATTR.AGENT_TYPE) ?? "subagent";
		out.push({
			id: `subagent_cost_runaway:${s.step_id}`,
			kind: "subagent_cost_runaway",
			severity: tier(
				tokens,
				THRESHOLDS.subagentWarnTokens,
				THRESHOLDS.subagentCriticalTokens,
			),
			title: `Subagent '${type}' burned ${tokens.toLocaleString()} tokens`,
			detail: `A single '${type}' dispatch consumed ${tokens.toLocaleString()} tokens — a likely cost runaway worth checking against the value it returned.`,
			step_ids: [s.step_id],
			score: tokens,
		});
	}
	return out;
};

/** Tool failures that are NOT guard trips or stale-read races (those have their own findings). */
const toolErrorSpike: Detector = (trace) => {
	const steps = trace.steps.filter(
		(s) =>
			s.kind === "tool_call" &&
			s.status === "error" &&
			!s.attributes[ATTR.GUARD_TRIPPED] &&
			!s.attributes[ATTR.STALE_READ],
	);
	if (steps.length < THRESHOLDS.toolErrorSpike) return [];
	return [
		{
			id: "tool_error_spike",
			kind: "tool_error_spike",
			severity: tier(
				steps.length,
				THRESHOLDS.toolErrorSpike,
				THRESHOLDS.toolErrorCritical,
			),
			title: `${steps.length} tool calls failed`,
			detail: `${steps.length} tool calls returned errors (excluding guard trips and stale-read races) — a high failure rate often marks where the agent lost the thread.`,
			step_ids: steps.map((s) => s.step_id),
			score: steps.length,
		},
	];
};

/** Repeated compaction boundaries: the session kept overflowing its context window. */
const compactionThrash: Detector = (trace) => {
	const steps = trace.steps.filter((s) => s.kind === "compaction");
	if (steps.length < THRESHOLDS.compactionThrash) return [];
	return [
		{
			id: "compaction_thrash",
			kind: "compaction_thrash",
			severity: tier(
				steps.length,
				THRESHOLDS.compactionThrash,
				THRESHOLDS.compactionCritical,
			),
			title: `${steps.length} compactions — context thrash`,
			detail: `The session compacted ${steps.length} times; repeated compaction means context kept overflowing, which degrades the agent's working memory.`,
			step_ids: steps.map((s) => s.step_id),
			score: steps.length,
		},
	];
};

/** A hook that denied / prevented continuation halted the run. */
const hookDenial: Detector = (trace) => {
	const steps = trace.steps.filter(
		(s) =>
			s.kind === "hook" &&
			(s.attributes[ATTR.HOOK_VERDICT] === "deny" ||
				Boolean(s.attributes[ATTR.HOOK_PREVENTED])),
	);
	if (steps.length === 0) return [];
	return [
		{
			id: "hook_denial",
			kind: "hook_denial",
			severity: "warning",
			title:
				steps.length === 1
					? "A hook prevented continuation"
					: `${steps.length} hooks prevented continuation`,
			detail:
				"A control hook (e.g. a Stop hook) denied continuation. The run may have been halted before finishing its work.",
			step_ids: steps.map((s) => s.step_id),
			score: steps.length,
		},
	];
};

/** The run never reached a clean end_turn completion. */
const incompleteRun: Detector = (trace) => {
	const status = trace.run.outcome?.status;
	if (!status || status === "completed" || trace.steps.length === 0) return [];
	return [
		{
			id: "incomplete_run",
			kind: "incomplete_run",
			severity: "info",
			title: `Run did not reach a clean completion (${status})`,
			detail: `The final turn ended with outcome '${status}' rather than a clean end_turn — the session may have been interrupted, errored out, or stopped mid-task.`,
			step_ids: [],
			score: 0,
		},
	];
};

/** Longest window of `calls` drawing on at most 2 distinct tool names. */
function longestTwoToolStreak(calls: readonly Step[]): Step[] {
	let bestStart = 0;
	let bestLen = 0;
	let start = 0;
	const counts = new Map<string, number>();
	for (const [end, call] of calls.entries()) {
		const name = strAttr(call, ATTR.TOOL_NAME) ?? "unknown";
		counts.set(name, (counts.get(name) ?? 0) + 1);
		while (counts.size > 2) {
			// start <= end here, so the index is always in-bounds.
			const drop = strAttr(calls[start] as Step, ATTR.TOOL_NAME) ?? "unknown";
			start++;
			const n = (counts.get(drop) ?? 0) - 1;
			if (n === 0) counts.delete(drop);
			else counts.set(drop, n);
		}
		if (end - start + 1 > bestLen) {
			bestLen = end - start + 1;
			bestStart = start;
		}
	}
	return calls.slice(bestStart, bestStart + bestLen);
}

/** Longest contiguous tool-call streak drawing on at most 2 distinct tools.
 * Catches the exec/stdin alternation of a Codex grind loop, which a
 * same-tool-only streak would miss. Partitioned by execution lane: the parsers
 * merge main + subagent sidechains into one timestamp-sorted stream, and
 * parallel healthy subagents interleaving Read/Grep must not add up to one
 * fake streak. Sliding window, O(n). */
const grindLoop: Detector = (trace) => {
	const lanes = new Map<string | null, Step[]>();
	for (const s of trace.steps) {
		if (s.kind !== "tool_call") continue;
		const lane = s.subagent_id ?? null;
		const bucket = lanes.get(lane);
		if (bucket) bucket.push(s);
		else lanes.set(lane, [s]);
	}
	let streak: Step[] = [];
	for (const calls of lanes.values()) {
		const candidate = longestTwoToolStreak(calls);
		if (candidate.length > streak.length) streak = candidate;
	}
	const isCodex = trace.run.harness.name === "codex";
	const warnAt = isCodex ? THRESHOLDS.grindStreak : THRESHOLDS.grindStreakCc;
	const critAt = isCodex
		? THRESHOLDS.grindStreakCritical
		: THRESHOLDS.grindStreakCcCritical;
	if (streak.length < warnAt) return [];
	const names = [
		...new Set(streak.map((s) => strAttr(s, ATTR.TOOL_NAME) ?? "unknown")),
	];
	return [
		{
			id: "grind_loop",
			kind: "grind_loop",
			severity: tier(streak.length, warnAt, critAt),
			title: `Grind loop: ${streak.length} consecutive calls cycling ${names.join(" / ")}`,
			detail:
				`One execution lane ran ${streak.length} tool calls in a row using only ${names.join(" and ")} — ` +
				"the churn signature of a grind loop: tools keep firing, tokens keep burning, but the work isn't converging.",
			step_ids: streak.map((s) => s.step_id),
			score: streak.length,
		},
	];
};

/** A completed Codex run with zero tool activity: the silent exit-0 no-op.
 * Gated on a real completion signal (task_complete -> outcome), NOT ended_at:
 * the Codex parser stamps ended_at from the last event seen, so ended_at is
 * set on any non-empty trace including one captured mid-run. */
const silentStall: Detector = (trace) => {
	if (trace.run.harness.name !== "codex") return [];
	if (trace.run.outcome?.status !== "completed") return [];
	if (trace.steps.length === 0) return [];
	if (trace.steps.some((s) => s.kind === "tool_call")) return [];
	return [
		{
			id: "silent_stall",
			kind: "silent_stall",
			severity: "warning",
			title: "Codex run ended with zero tool activity",
			detail:
				"The run terminated without making a single tool call — the silent exit-0 no-op signature: " +
				"it reads as success (clean exit, maybe even a confident summary) while having done no work.",
			step_ids: [],
			score: 0,
		},
	];
};

export const ALL_DETECTORS: readonly Detector[] = [
	guardTripCluster,
	subagentCostRunaway,
	toolErrorSpike,
	staleReadRace,
	compactionThrash,
	hookDenial,
	incompleteRun,
	grindLoop,
	silentStall,
];

/** Run every detector and rank: severity tier first, magnitude next, id last (stable). */
export function detect(trace: Trace): Finding[] {
	const findings = ALL_DETECTORS.flatMap((d) => d(trace));
	return findings.sort(
		(a, b) =>
			SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
			b.score - a.score ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
}
