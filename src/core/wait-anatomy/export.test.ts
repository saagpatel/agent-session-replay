import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTR, type Step, type Trace } from "../types.ts";
import { toWaitTrace } from "./export.ts";

const time = (ms: number) => new Date(Date.UTC(2025, 0, 1) + ms).toISOString();
const step = (id: string, kind: Step["kind"], start: number, end: number | null, parent?: string): Step => ({
	step_id: id, kind, started_at: time(start), ended_at: end === null ? null : time(end),
	parent_step_id: parent, attributes: {},
});
test("exports categories, containment, times, notes and ordered keys", () => {
	const agent = step("agent", "agent", 1, 9);
	agent.attributes[ATTR.AGENT_NAME] = "helper";
	const tool = step("tool", "tool_call", 2, 5, "agent");
	tool.attributes[ATTR.TOOL_NAME] = "read";
	const outside = step("outside", "hook", 0, 3, "agent");
	const kinds: Step["kind"][] = ["llm", "decision", "memory", "compaction", "mode_change"];
	const trace: Trace = { plumbline_version: "1", run: { run_id: "test", harness: { name: "test" }, started_at: time(0), ended_at: time(8) }, steps: [agent, tool, outside, step("missing", "llm", 0, null), ...kinds.map((kind) => step(kind, kind, 0, 1))] };
	const { waitTrace, notes } = toWaitTrace(trace);
	assert.deepEqual(Object.keys(waitTrace), ["format", "origin", "trace_id", "window_ns", "spans", "declared_gaps", "notes"]);
	assert.deepEqual(Object.keys(waitTrace.spans[0]!), ["id", "parent_id", "name", "category", "start_ns", "end_ns"]);
	assert.deepEqual(waitTrace.window_ns, [0, 9_000_000]);
	assert.deepEqual(waitTrace.spans.slice(0, 3).map((s) => [s.name, s.category, s.parent_id]), [["helper", "nested_call", null], ["read", "tool_wait", "agent"], ["hook", "execution", null]]);
	assert.ok(waitTrace.spans.slice(3).every((s) => s.category === "execution" && Number.isSafeInteger(s.start_ns) && Number.isSafeInteger(s.end_ns)));
	assert.ok(notes.some((n) => n.includes("outside parent agent")));
	assert.ok(notes.some((n) => n.includes("missing") && n.includes("skipped")));
});
test("missing run end and deep links are noted", () => {
	const steps = Array.from({ length: 67 }, (_, i) => step(String(i), "agent", 0, 1, i ? String(i - 1) : undefined));
	const { waitTrace, notes } = toWaitTrace({ plumbline_version: "1", run: { run_id: "test", harness: { name: "test" }, started_at: time(0) }, steps });
	assert.equal(waitTrace.spans[65]?.parent_id, null);
	assert.ok(notes.some((n) => n.includes("Run end is missing")));
	assert.ok(notes.some((n) => n.includes("too-deep")));
});
