import assert from "node:assert/strict";
import { test } from "node:test";

import { ATTR, type Step, type Trace } from "../types.ts";
import { detect } from "./engine.ts";

let seq = 0;
function step(
	kind: Step["kind"],
	attributes: Step["attributes"],
	over: Partial<Step> = {},
): Step {
	seq += 1;
	return {
		step_id: over.step_id ?? `s${seq}`,
		subagent_id: over.subagent_id ?? null,
		kind,
		started_at:
			over.started_at ??
			`2026-06-20T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
		status: over.status,
		attributes,
	};
}

function trace(steps: Step[], outcomeStatus = "completed"): Trace {
	return {
		plumbline_version: "0.1.0",
		run: {
			run_id: "test-run",
			harness: { name: "claude-code" },
			started_at: "2026-06-20T00:00:00.000Z",
			ended_at: "2026-06-20T00:01:00.000Z",
			outcome: { status: outcomeStatus, summary: null },
		},
		steps,
	};
}

function guardStep(name: string): Step {
	return step(
		"tool_call",
		{
			[ATTR.TOOL_NAME]: "Bash",
			[ATTR.GUARD_TRIPPED]: true,
			[ATTR.GUARD_NAME]: name,
			[ATTR.GUARD_REASON]: "denied by policy",
		},
		{ status: "error" },
	);
}

test("a guard tripped >=5x is a critical guard_trip_cluster citing every offending step", () => {
	const steps = Array.from({ length: 5 }, () => guardStep("mcp-guard egress"));
	const f = detect(trace(steps)).filter((x) => x.kind === "guard_trip_cluster");
	assert.equal(f.length, 1);
	assert.equal(f[0].severity, "critical");
	assert.equal(f[0].step_ids.length, 5);
	assert.match(f[0].title, /mcp-guard egress/);
	assert.match(f[0].title, /5/);
});

test("a guard tripped 3-4x is a warning; one finding per distinct guard name", () => {
	const steps = [
		guardStep("bash-egress"),
		guardStep("bash-egress"),
		guardStep("bash-egress"),
		guardStep("mcp-guard"),
		guardStep("mcp-guard"),
		guardStep("mcp-guard"),
		guardStep("mcp-guard"),
	];
	const f = detect(trace(steps)).filter((x) => x.kind === "guard_trip_cluster");
	assert.equal(f.length, 2);
	const bash = f.find((x) => x.title.includes("bash-egress"));
	const mcp = f.find((x) => x.title.includes("mcp-guard"));
	assert.equal(bash?.severity, "warning");
	assert.equal(mcp?.severity, "warning");
	// mcp tripped more, so it must outrank bash within the warning tier.
	assert.ok((mcp?.score ?? 0) > (bash?.score ?? 0));
});

test("a guard tripping below the cluster threshold raises no guard finding", () => {
	const steps = [guardStep("bash-egress"), guardStep("bash-egress")];
	const f = detect(trace(steps)).filter((x) => x.kind === "guard_trip_cluster");
	assert.equal(f.length, 0);
});

test("any stale-read hint becomes a single Read-to-Edit race finding listing all offenders", () => {
	const steps = [
		step(
			"tool_call",
			{ [ATTR.TOOL_NAME]: "Edit", [ATTR.STALE_READ]: true },
			{ status: "error" },
		),
		step(
			"tool_call",
			{ [ATTR.TOOL_NAME]: "Edit", [ATTR.STALE_READ]: true },
			{ status: "error" },
		),
	];
	const f = detect(trace(steps)).filter((x) => x.kind === "stale_read_race");
	assert.equal(f.length, 1);
	assert.equal(f[0].severity, "warning");
	assert.equal(f[0].step_ids.length, 2);
});

test("a subagent burning past the runaway threshold is a cost-runaway finding", () => {
	const steps = [
		step("agent", {
			[ATTR.AGENT_TYPE]: "Explore",
			[ATTR.AGENT_TOTAL_TOKENS]: 450_000,
		}),
		step("agent", {
			[ATTR.AGENT_TYPE]: "code-reviewer",
			[ATTR.AGENT_TOTAL_TOKENS]: 5_000,
		}),
	];
	const f = detect(trace(steps)).filter(
		(x) => x.kind === "subagent_cost_runaway",
	);
	assert.equal(f.length, 1);
	assert.equal(f[0].severity, "critical");
	assert.match(f[0].title, /Explore/);
});

test("tool-error spikes count only non-guard errors so the two findings never double-count", () => {
	const steps = [
		...Array.from({ length: 5 }, () => guardStep("mcp-guard")), // guard errors, excluded
		...Array.from({ length: 10 }, () =>
			step("tool_call", { [ATTR.TOOL_NAME]: "Bash" }, { status: "error" }),
		),
	];
	const all = detect(trace(steps));
	const spike = all.filter((x) => x.kind === "tool_error_spike");
	assert.equal(spike.length, 1);
	assert.equal(spike[0].step_ids.length, 10); // not 15
});

test("tool-error spike counts only tool_call failures, not llm/agent errors", () => {
	const steps = [
		// non-tool errors that must NOT be counted as "tool calls failed":
		step("llm", { [ATTR.OUTPUT_TOKENS]: 5 }, { status: "error" }),
		step("agent", { [ATTR.AGENT_TYPE]: "Explore" }, { status: "error" }),
		...Array.from({ length: 8 }, () =>
			step("tool_call", { [ATTR.TOOL_NAME]: "Bash" }, { status: "error" }),
		),
	];
	const spike = detect(trace(steps)).filter(
		(x) => x.kind === "tool_error_spike",
	);
	assert.equal(spike.length, 1);
	assert.equal(spike[0].step_ids.length, 8); // not 10
});

test("repeated compaction boundaries are a context-thrash finding", () => {
	const steps = Array.from({ length: 3 }, () =>
		step("compaction", { [ATTR.COMPACT_REASON]: "auto" }),
	);
	const f = detect(trace(steps)).filter((x) => x.kind === "compaction_thrash");
	assert.equal(f.length, 1);
	assert.equal(f[0].step_ids.length, 3);
});

test("a hook that prevented continuation is a hook_denial finding", () => {
	const steps = [
		step("hook", {
			[ATTR.HOOK_EVENT]: "Stop",
			[ATTR.HOOK_VERDICT]: "deny",
			[ATTR.HOOK_PREVENTED]: true,
		}),
	];
	const f = detect(trace(steps)).filter((x) => x.kind === "hook_denial");
	assert.equal(f.length, 1);
	assert.equal(f[0].severity, "warning");
});

test("a run that never reached a clean completion is flagged incomplete", () => {
	const steps = [step("llm", { [ATTR.OUTPUT_TOKENS]: 10 }, { status: "ok" })];
	const f = detect(trace(steps, "unknown")).filter(
		(x) => x.kind === "incomplete_run",
	);
	assert.equal(f.length, 1);
	const completed = detect(trace(steps, "completed")).filter(
		(x) => x.kind === "incomplete_run",
	);
	assert.equal(completed.length, 0);
});

test("findings are ranked critical-first, then by magnitude within a tier", () => {
	const steps = [
		...Array.from({ length: 5 }, () => guardStep("mcp-guard egress")), // critical
		step("hook", { [ATTR.HOOK_VERDICT]: "deny", [ATTR.HOOK_PREVENTED]: true }), // warning
	];
	const f = detect(trace(steps));
	assert.ok(f.length >= 2);
	assert.equal(f[0].severity, "critical");
	// non-increasing severity rank across the whole list
	for (let i = 1; i < f.length; i++) {
		assert.ok(
			rank(f[i - 1].severity) >= rank(f[i].severity),
			"severity must be non-increasing",
		);
	}
});

test("a clean run produces no findings and never throws on an empty trace", () => {
	assert.deepEqual(detect(trace([])), []);
	const clean = detect(
		trace([step("llm", { [ATTR.OUTPUT_TOKENS]: 10 }, { status: "ok" })]),
	);
	assert.deepEqual(clean, []);
});

test("finding ids are deterministic across repeated runs on the same trace", () => {
	const t = trace(
		Array.from({ length: 5 }, () => guardStep("mcp-guard egress")),
	);
	const a = detect(t).map((x) => x.id);
	const b = detect(t).map((x) => x.id);
	assert.deepEqual(a, b);
});

function toolCall(name: string, status: Step["status"] = "ok"): Step {
	return step("tool_call", { [ATTR.TOOL_NAME]: name }, { status });
}

function codexTrace(steps: Step[], over: Partial<Trace["run"]> = {}): Trace {
	const t = trace(steps);
	t.run.harness = { name: "codex" };
	Object.assign(t.run, over);
	return t;
}

test("a long call streak confined to <=2 tools is a grind loop naming both tools", () => {
	const steps = Array.from({ length: 150 }, (_, i) =>
		toolCall(i % 2 === 0 ? "bash" : "write_stdin"),
	);
	const f = detect(trace(steps)).filter((x) => x.kind === "grind_loop");
	assert.equal(f.length, 1);
	assert.equal(f[0].severity, "warning");
	assert.equal(f[0].score, 150);
	assert.equal(f[0].step_ids.length, 150);
	assert.match(f[0].title, /bash/);
	assert.match(f[0].title, /write_stdin/);
});

test("a grind streak past the critical threshold is critical", () => {
	const steps = Array.from({ length: 450 }, (_, i) =>
		toolCall(i % 2 === 0 ? "bash" : "write_stdin"),
	);
	const f = detect(trace(steps)).filter((x) => x.kind === "grind_loop");
	assert.equal(f.length, 1);
	assert.equal(f[0].severity, "critical");
});

test("varied tool usage never reads as a grind loop, however long the session", () => {
	const tools = ["Bash", "Read", "Edit", "Grep", "Write"];
	const steps = Array.from({ length: 300 }, (_, i) =>
		toolCall(tools[i % tools.length]),
	);
	const f = detect(trace(steps)).filter((x) => x.kind === "grind_loop");
	assert.equal(f.length, 0);
});

test("a two-tool streak below the grind threshold stays quiet", () => {
	const steps = Array.from({ length: 60 }, (_, i) =>
		toolCall(i % 2 === 0 ? "bash" : "write_stdin"),
	);
	const f = detect(trace(steps)).filter((x) => x.kind === "grind_loop");
	assert.equal(f.length, 0);
});

test("a grind streak buried mid-session is still found", () => {
	const tools = ["Bash", "Read", "Edit", "Grep", "Write"];
	const steps = [
		...Array.from({ length: 20 }, (_, i) => toolCall(tools[i % tools.length])),
		...Array.from({ length: 130 }, (_, i) =>
			toolCall(i % 2 === 0 ? "exec" : "stdin"),
		),
		...Array.from({ length: 20 }, (_, i) => toolCall(tools[i % tools.length])),
	];
	const f = detect(trace(steps)).filter((x) => x.kind === "grind_loop");
	assert.equal(f.length, 1);
	assert.ok(f[0].score >= 130);
});

test("a finished codex run with zero tool calls is a silent stall", () => {
	const steps = [step("llm", { [ATTR.OUTPUT_TOKENS]: 20 }, { status: "ok" })];
	const f = detect(codexTrace(steps)).filter((x) => x.kind === "silent_stall");
	assert.equal(f.length, 1);
	assert.equal(f[0].severity, "warning");
});

test("silent stall requires codex + a finished run + zero tool calls", () => {
	const llmOnly = [step("llm", { [ATTR.OUTPUT_TOKENS]: 20 }, { status: "ok" })];
	// claude-code harness: chat-only sessions are legitimate
	assert.equal(
		detect(trace(llmOnly)).filter((x) => x.kind === "silent_stall").length,
		0,
	);
	// codex but still running (no end marker, no outcome)
	const live = codexTrace(llmOnly, { ended_at: null });
	live.run.outcome = undefined;
	assert.equal(detect(live).filter((x) => x.kind === "silent_stall").length, 0);
	// codex, finished, but it actually did work
	const worked = codexTrace([...llmOnly, toolCall("bash")]);
	assert.equal(
		detect(worked).filter((x) => x.kind === "silent_stall").length,
		0,
	);
	// codex, finished, but the transcript parsed to nothing at all
	assert.equal(
		detect(codexTrace([])).filter((x) => x.kind === "silent_stall").length,
		0,
	);
});

function rank(s: "critical" | "warning" | "info"): number {
	return { critical: 3, warning: 2, info: 1 }[s];
}
