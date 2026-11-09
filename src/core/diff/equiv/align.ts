import { ATTR, type Trace } from "../../types.ts";
import { alignSteps } from "../align.ts";
import { normalizeTrace } from "../normalize.ts";
import type { DiffStep } from "../types.ts";
import { normalizeEquivalent } from "./normalize.ts";
import type { CanonicalEvent, EquivalentAlignment, EquivalentNormalization } from "./types.ts";

/** Adapt enriched signatures to the existing aligner without changing it. */
function comparisonEvents(normalized: EquivalentNormalization): CanonicalEvent[] {
	const events = [...normalized.events];
	const observation = (event: CanonicalEvent) => event.status === "ok" && (event.action === "read" || event.action === "search");
	for (let start = 0; start < events.length;) {
		const first = events[start] as CanonicalEvent;
		if (!observation(first)) { start++; continue; }
		let end = start + 1;
		while (end < events.length && observation(events[end] as CanonicalEvent) &&
			normalized.sourceSegments.get(first.memberStepIds[0] as string) ===
			normalized.sourceSegments.get((events[end] as CanonicalEvent).memberStepIds[0] as string)) end++;
		const run = events.slice(start, end).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
		for (let i = 0; i < run.length; i++) events[start + i] = run[i] as CanonicalEvent;
		start = end;
	}
	return events;
}

function alignmentSteps(normalized: EquivalentNormalization, events: CanonicalEvent[]): DiffStep[] {
	return events.map((event, index) => ({
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
	const leftEvents = comparisonEvents(left);
	const rightEvents = comparisonEvents(right);
	const aligned = alignSteps(alignmentSteps(left, leftEvents), alignmentSteps(right, rightEvents));
	const rows = aligned.rows.map((row) => ({
		...row,
		// Work Equivalence preserves each outcome, including missing evidence.
		// Run Diff's failure-only comparison intentionally remains unchanged.
		statusDiffers: row.left !== null && row.right !== null && row.left.status !== row.right.status,
		left: row.left ? leftEvents[row.left.index] as CanonicalEvent : null,
		right: row.right ? rightEvents[row.right.index] as CanonicalEvent : null,
	}));
	// Candidate discovery must not hide an exhausted normalization budget.
	const reasons = new Set([...candidateLeft.incompleteReasons, ...candidateRight.incompleteReasons,
		...left.incompleteReasons, ...right.incompleteReasons]);
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
