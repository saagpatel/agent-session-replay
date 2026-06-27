import assert from "node:assert/strict";
import { test } from "node:test";

import type { Finding } from "../detect/types.ts";
import { ATTR, type Step, type Trace } from "../types.ts";
import { buildTimeline } from "./timeline.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T100 = "2026-01-01T00:01:40.000Z"; // +100s

function trace(steps: Step[], over: Partial<Trace["run"]> = {}): Trace {
	return {
		plumbline_version: "0.1.0",
		run: {
			run_id: "r",
			harness: { name: "claude-code" },
			started_at: T0,
			ended_at: T100,
			...over,
		},
		steps,
	};
}
function step(
	over: Partial<Step> & Pick<Step, "step_id" | "kind" | "started_at">,
): Step {
	return { subagent_id: null, attributes: {}, ...over };
}

test("positions a step proportionally within the run window", () => {
	const view = buildTimeline(
		trace([
			step({
				step_id: "a",
				kind: "tool_call",
				started_at: "2026-01-01T00:00:25.000Z",
				ended_at: "2026-01-01T00:00:50.000Z",
			}),
		]),
	);
	const bar = view.lanes[0].bars[0];
	assert.equal(view.durationMs, 100_000);
	assert.ok(Math.abs(bar.offset - 0.25) < 1e-9);
	assert.ok(Math.abs(bar.width - 0.25) < 1e-9);
});

test("an instantaneous step (no ended_at) still gets a minimum visible width", () => {
	const view = buildTimeline(
		trace([
			step({
				step_id: "a",
				kind: "llm",
				started_at: "2026-01-01T00:00:50.000Z",
			}),
		]),
	);
	const bar = view.lanes[0].bars[0];
	assert.ok(bar.width > 0);
	assert.ok(Math.abs(bar.offset - 0.5) < 1e-9);
});

test("subagent steps land in their own lane; main steps stay in lane 0", () => {
	const view = buildTimeline(
		trace([
			step({
				step_id: "m",
				kind: "llm",
				started_at: "2026-01-01T00:00:10.000Z",
			}),
			step({
				step_id: "s",
				kind: "tool_call",
				started_at: "2026-01-01T00:00:20.000Z",
				subagent_id: "sub-1",
			}),
		]),
	);
	assert.equal(view.lanes.length, 2);
	assert.equal(view.lanes[0].id, null);
	assert.equal(view.lanes[0].bars.length, 1);
	assert.equal(view.lanes[1].id, "sub-1");
	assert.equal(view.lanes[1].bars[0].step_id, "s");
});

test("a step cited by a finding carries that finding's severity", () => {
	const findings: Finding[] = [
		{
			id: "f1",
			kind: "guard_trip_cluster",
			severity: "critical",
			title: "Guard tripped",
			detail: "",
			step_ids: ["a"],
			score: 5,
		},
	];
	const view = buildTimeline(
		trace([
			step({
				step_id: "a",
				kind: "tool_call",
				started_at: "2026-01-01T00:00:30.000Z",
			}),
			step({
				step_id: "b",
				kind: "tool_call",
				started_at: "2026-01-01T00:00:40.000Z",
			}),
		]),
		findings,
	);
	const a = view.lanes[0].bars.find((x) => x.step_id === "a");
	const b = view.lanes[0].bars.find((x) => x.step_id === "b");
	assert.equal(a?.severity, "critical");
	assert.equal(b?.severity, undefined);
});

test("each finding becomes a marker positioned at its first evidence step", () => {
	const findings: Finding[] = [
		{
			id: "f1",
			kind: "guard_trip_cluster",
			severity: "critical",
			title: "Guard tripped 5x",
			detail: "",
			step_ids: ["a"],
			score: 5,
		},
	];
	const view = buildTimeline(
		trace([
			step({
				step_id: "a",
				kind: "tool_call",
				started_at: "2026-01-01T00:00:50.000Z",
			}),
		]),
		findings,
	);
	assert.equal(view.markers.length, 1);
	assert.equal(view.markers[0].finding_id, "f1");
	assert.equal(view.markers[0].severity, "critical");
	assert.ok(Math.abs(view.markers[0].offset - 0.5) < 1e-9);
});

test("a higher-severity finding wins when a step is cited by several", () => {
	const findings: Finding[] = [
		{
			id: "w",
			kind: "tool_error_spike",
			severity: "warning",
			title: "",
			detail: "",
			step_ids: ["a"],
			score: 1,
		},
		{
			id: "c",
			kind: "guard_trip_cluster",
			severity: "critical",
			title: "",
			detail: "",
			step_ids: ["a"],
			score: 1,
		},
	];
	const view = buildTimeline(
		trace([
			step({
				step_id: "a",
				kind: "tool_call",
				started_at: "2026-01-01T00:00:10.000Z",
			}),
		]),
		findings,
	);
	assert.equal(view.lanes[0].bars[0].severity, "critical");
});

test("labels each bar from its kind and attributes", () => {
	const view = buildTimeline(
		trace([
			step({
				step_id: "t",
				kind: "tool_call",
				started_at: "2026-01-01T00:00:10.000Z",
				attributes: { [ATTR.TOOL_NAME]: "Bash" },
			}),
			step({
				step_id: "g",
				kind: "agent",
				started_at: "2026-01-01T00:00:20.000Z",
				attributes: { [ATTR.AGENT_TYPE]: "Explore" },
				subagent_id: "sub-1",
			}),
		]),
	);
	assert.equal(view.lanes[0].bars[0].label, "Bash");
	assert.equal(view.lanes[1].bars[0].label, "Explore");
});

test("a zero-duration run does not divide by zero", () => {
	const view = buildTimeline(
		trace([step({ step_id: "a", kind: "llm", started_at: T0 })], {
			ended_at: T0,
		}),
	);
	assert.equal(view.durationMs, 1); // floored to 1ms
	assert.ok(Number.isFinite(view.lanes[0].bars[0].offset));
	assert.ok(Number.isFinite(view.lanes[0].bars[0].width));
});

test("clamps a bar so it never overflows the right edge", () => {
	const view = buildTimeline(
		trace([
			step({
				step_id: "a",
				kind: "tool_call",
				started_at: "2026-01-01T00:00:90.000Z",
				ended_at: "2026-01-01T00:05:00.000Z", // ends well past run end
			}),
		]),
	);
	const bar = view.lanes[0].bars[0];
	assert.ok(bar.offset + bar.width <= 1 + 1e-9);
});
