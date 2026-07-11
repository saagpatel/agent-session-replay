/**
 * Findings model — the diagnostic layer that turns a parsed Trace into ranked
 * "here is where the run went wrong" evidence. This is the product: the timeline
 * is the evidence panel, the findings are the answer.
 *
 * A `Detector` is a pure `(trace) => Finding[]`. The engine runs every detector,
 * flattens the output, and ranks it (severity tier first, magnitude second), so
 * each detector stays small, independent, and unit-testable in isolation.
 */

import type { Trace } from "../types.ts";

export type Severity = "critical" | "warning" | "info";

/** Higher tier sorts first. Centralized so ranking never drifts. */
export const SEVERITY_RANK: Record<Severity, number> = {
	critical: 3,
	warning: 2,
	info: 1,
};

export type FindingKind =
	| "guard_trip_cluster"
	| "stale_read_race"
	| "subagent_cost_runaway"
	| "tool_error_spike"
	| "compaction_thrash"
	| "hook_denial"
	| "incomplete_run"
	| "grind_loop"
	| "silent_stall";

export interface Finding {
	/** Deterministic, stable across re-parses of the same trace. */
	id: string;
	kind: FindingKind;
	severity: Severity;
	/** One-line headline, e.g. "Guard 'mcp-guard egress' tripped 5×". */
	title: string;
	/** Human-readable elaboration with the forensic "so what". */
	detail: string;
	/** Evidence: the step_ids this finding points the timeline at. */
	step_ids: string[];
	/** Within-severity ordering magnitude (trip count, token burn, …). */
	score: number;
}

export type Detector = (trace: Trace) => Finding[];
