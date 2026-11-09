import { ATTR, type Trace } from "../../types.ts";
import { alignSteps } from "../align.ts";
import { normalizeTrace } from "../normalize.ts";
import type { DiffStep } from "../types.ts";
import { normalizeEquivalent } from "./normalize.ts";
import type { CanonicalEvent, EquivalentAlignment, EquivalentNormalization } from "./types.ts";

/** Adapt enriched signatures to the existing aligner without changing it. */
function alignmentSteps(normalized: EquivalentNormalization): DiffStep[] {
	return normalized.events.map((event, index) => ({
		...(normalized.steps[event.members[0] as number] as DiffStep),
		index,
		action: event.action,
		target: event.target,
		status: event.status,
		signature: event.key,
	}));
}

/** Pure local comparison. Incomplete evidence is reported independently of forks. */
export function alignEquivalent(leftTrace: Trace, rightTrace: Trace): EquivalentAlignment {
	const prepare = (trace: Trace) => ({
		steps: normalizeTrace(trace),
		sources: new Map(trace.steps.map((step) => [step.step_id, step])),
		cwd: trace.run.workspace?.cwd,
	});
	const l = prepare(leftTrace);
	const r = prepare(rightTrace);
	const candidateLeft = normalizeEquivalent(l.steps, l.sources, l.cwd);
	const candidateRight = normalizeEquivalent(r.steps, r.sources, r.cwd);
	const left = normalizeEquivalent(l.steps, l.sources, l.cwd, new Set(candidateRight.events.map((e) => e.key)));
	const right = normalizeEquivalent(r.steps, r.sources, r.cwd, new Set(candidateLeft.events.map((e) => e.key)));
	const aligned = alignSteps(alignmentSteps(left), alignmentSteps(right));
	const rows = aligned.rows.map((row) => ({
		...row,
		// Work Equivalence preserves each outcome, including missing evidence.
		// Run Diff's failure-only comparison intentionally remains unchanged.
		statusDiffers: row.left !== null && row.right !== null && row.left.status !== row.right.status,
		left: row.left ? left.events[row.left.index] as CanonicalEvent : null,
		right: row.right ? right.events[row.right.index] as CanonicalEvent : null,
	}));
	const reasons = new Set([...left.incompleteReasons, ...right.incompleteReasons]);
	if (aligned.truncated.left || aligned.truncated.right) reasons.add("alignment-truncated");
	if (leftTrace.malformed_lines || rightTrace.malformed_lines) reasons.add("malformed-transcript");
	// Unknown command steps are already marked by normalization. Exec cells can
	// also omit capped inner stages, whose raw source cannot safely be re-parsed
	// here; keep this comparison incomplete rather than assume coverage.
	for (const trace of [leftTrace, rightTrace]) {
		if (trace.steps.some((s) => !s.subagent_id && s.attributes[ATTR.TOOL_NAME] === "exec")) reasons.add("exec-source-coverage-unknown");
	}
	const divergences = rows.filter((row) => row.relation !== "same" || row.statusDiffers);
	return {
		left,
		right,
		rows,
		divergences,
		truncated: aligned.truncated,
		incomplete: reasons.size > 0,
		incompleteReasons: [...reasons],
		equivalent: reasons.size === 0 && divergences.length === 0,
	};
}
