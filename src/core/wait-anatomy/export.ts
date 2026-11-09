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
	const diagnostics = new Map<string, { count: number; examples: string[] }>();
	const diagnose = (kind: string, id: string) => {
		const entry = diagnostics.get(kind) ?? { count: 0, examples: [] };
		entry.count++;
		if (entry.examples.length < 5) entry.examples.push(id.slice(0, 200));
		diagnostics.set(kind, entry);
	};
	const valid = trace.steps.flatMap((step) => {
		const start = Date.parse(step.started_at);
		const end = step.ended_at ? Date.parse(step.ended_at) : NaN;
		if (!step.ended_at || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
			diagnose("have missing or invalid times; skipped", step.step_id);
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
	if (latest <= earliest) notes.push("No measurable time in this session (window is zero-length); nothing to analyze.");
	const offset = (time: number) => {
		const ns = (time - earliest) * 1_000_000;
		if (!Number.isSafeInteger(ns)) throw new Error("Trace duration exceeds safe integer precision");
		return ns;
	};
	const byId = new Map(valid.map((item) => [item.step.step_id, item]));
	const agents = new Map<string, typeof valid>();
	for (const item of valid) {
		const spawned = item.step.attributes[ATTR.AGENT_SPAWNS];
		if (item.step.kind === "agent" && typeof spawned === "string") {
			const matches = agents.get(spawned) ?? [];
			matches.push(item);
			agents.set(spawned, matches);
		}
	}
	const parents = new Map<string, string | null>();
	for (const { step, start, end } of valid) {
		const direct = step.parent_step_id ? byId.get(step.parent_step_id) : undefined;
		const contains = (candidate: typeof valid[number]) => start >= candidate.start && end <= candidate.end;
		// Trace contains steps only, so non-exported transcript events cannot be traversed.
		const parent = direct && contains(direct) ? direct : step.subagent_id
			? agents.get(step.subagent_id)?.find((candidate) => candidate.step.step_id !== step.step_id && contains(candidate))
			: undefined;
		if (!parent && (step.parent_step_id || step.subagent_id)) {
			diagnose(direct ? "start/end outside their parent; shown at top level" : "reference a parent that was not exported or resolved; shown at top level", step.step_id);
		}
		parents.set(step.step_id, parent?.step.step_id ?? null);
	}
	for (const { step } of valid) {
		const seen = new Set([step.step_id]);
		let parent = parents.get(step.step_id) ?? null;
		let depth = 0;
		while (parent) {
			if (seen.has(parent) || ++depth > 64) {
				parents.set(step.step_id, null);
				diagnose("have a cyclic or too-deep parent chain; shown at top level", step.step_id);
				break;
			}
			seen.add(parent);
			parent = parents.get(parent) ?? null;
		}
	}
	for (const [kind, { count, examples }] of diagnostics) {
		notes.push(`${count} steps ${kind}. Examples: ${examples.join(", ")}.`);
	}
	if (notes.length > 256) {
		const omitted = notes.length - 255;
		notes.splice(255, omitted, `... and ${omitted} more diagnostics (not listed).`);
	}
	for (let i = 0; i < notes.length; i++) notes[i] = notes[i]!.slice(0, 2048);
	const spans: WaitSpan[] = valid.map(({ step, start, end }) => {
		const candidate = step.kind === "tool_call" ? step.attributes[ATTR.TOOL_NAME] : step.kind === "agent" ? step.attributes[ATTR.AGENT_NAME] ?? step.attributes[ATTR.AGENT_TYPE] ?? step.attribution?.agent : undefined;
		const name = typeof candidate === "string" && candidate.trim() ? candidate.replace(/\s+/g, " ").trim().slice(0, 120) : step.kind;
		return { id: step.step_id, parent_id: parents.get(step.step_id) ?? null, name, category: step.kind === "tool_call" ? "tool_wait" : step.kind === "agent" ? "nested_call" : "execution", start_ns: offset(start), end_ns: offset(end) };
	});
	return { waitTrace: { format: "traceglass-wait/0.1", origin: "agent-session-replay", trace_id: trace.run.run_id, window_ns: [0, offset(latest)], spans, declared_gaps: [], notes }, notes };
}
