import { ATTR, type Trace } from "../types.ts";

export interface WaitSpan {
	id: string; parent_id: string | null; name: string;
	category: "execution" | "tool_wait" | "nested_call";
	start_ns: number; end_ns: number;
}
export interface WaitTrace {
	format: "traceglass-wait/0.1"; origin: "agent-session-replay"; trace_id: string;
	window_ns: [number, number]; spans: WaitSpan[]; declared_gaps: []; notes: string[];
}
export function toWaitTrace(trace: Trace): { waitTrace: WaitTrace; notes: string[] } {
	const notes: string[] = [];
	const valid = trace.steps.flatMap((step) => {
		const start = Date.parse(step.started_at);
		const end = step.ended_at ? Date.parse(step.ended_at) : NaN;
		if (!step.ended_at || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
			notes.push(`Step ${step.step_id} has missing or invalid times; skipped.`);
			return [];
		}
		return [{ step, start, end }];
	});
	const runStart = Date.parse(trace.run.started_at);
	const runEnd = trace.run.ended_at ? Date.parse(trace.run.ended_at) : NaN;
	if (!trace.run.ended_at) notes.push("Run end is missing; window ends at the latest recorded step.");
	else if (!Number.isFinite(runEnd)) notes.push("Run end is invalid; window ends at the latest recorded step.");
	const starts = valid.map((item) => item.start);
	if (Number.isFinite(runStart)) starts.push(runStart);
	if (!starts.length) throw new Error("Trace has no valid start time");
	const earliest = starts.reduce((a, b) => Math.min(a, b));
	const latest = valid.reduce((end, item) => Math.max(end, item.end), Number.isFinite(runEnd) ? Math.max(earliest, runEnd) : earliest);
	const offset = (time: number) => {
		const ns = (time - earliest) * 1_000_000;
		if (!Number.isSafeInteger(ns)) throw new Error("Trace duration exceeds safe integer precision");
		return ns;
	};
	const byId = new Map(valid.map((item) => [item.step.step_id, item]));
	const parents = new Map<string, string | null>();
	for (const { step, start, end } of valid) {
		const parent = step.parent_step_id ? byId.get(step.parent_step_id) : undefined;
		if (step.parent_step_id && (!parent || start < parent.start || end > parent.end)) {
			notes.push(parent ? `Step ${step.step_id} starts/ends outside parent ${step.parent_step_id}; shown at top level.` : `Step ${step.step_id} has unexported parent ${step.parent_step_id}; shown at top level.`);
		}
		parents.set(step.step_id, parent && start >= parent.start && end <= parent.end ? parent.step.step_id : null);
	}
	for (const { step } of valid) {
		const seen = new Set([step.step_id]);
		let parent = parents.get(step.step_id) ?? null;
		let depth = 0;
		while (parent) {
			if (seen.has(parent) || ++depth > 64) {
				parents.set(step.step_id, null);
				notes.push(`Step ${step.step_id} has a cyclic or too-deep parent chain; shown at top level.`);
				break;
			}
			seen.add(parent);
			parent = parents.get(parent) ?? null;
		}
	}
	const spans: WaitSpan[] = valid.map(({ step, start, end }) => {
		const candidate = step.kind === "tool_call" ? step.attributes[ATTR.TOOL_NAME] : step.kind === "agent" ? step.attributes[ATTR.AGENT_NAME] ?? step.attributes[ATTR.AGENT_TYPE] ?? step.attribution?.agent : undefined;
		const name = typeof candidate === "string" && candidate.trim() ? candidate.replace(/\s+/g, " ").trim().slice(0, 120) : step.kind;
		return { id: step.step_id, parent_id: parents.get(step.step_id) ?? null, name, category: step.kind === "tool_call" ? "tool_wait" : step.kind === "agent" ? "nested_call" : "execution", start_ns: offset(start), end_ns: offset(end) };
	});
	return { waitTrace: { format: "traceglass-wait/0.1", origin: "agent-session-replay", trace_id: trace.run.run_id, window_ns: [0, offset(latest)], spans, declared_gaps: [], notes }, notes };
}

