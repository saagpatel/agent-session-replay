import assert from "node:assert/strict";
import { test } from "node:test";

import { ATTR, type Step } from "../types.ts";
import { parseCodexEvents } from "./codex.ts";

/** Build a Codex rollout envelope { timestamp, type, payload }. */
let clock = 0;
function ev(type: string, payload: unknown, ts?: string): unknown {
	clock += 1;
	return {
		timestamp:
			ts ?? `2026-02-17T11:00:${String(clock % 60).padStart(2, "0")}.000Z`,
		type,
		payload,
	};
}
const sessionMeta = (over: Record<string, unknown> = {}) =>
	ev("session_meta", {
		id: "019c6b51-run",
		cwd: "/workspace/project",
		originator: "Codex Desktop",
		cli_version: "0.100.0",
		...over,
	});
const turnContext = (over: Record<string, unknown> = {}) =>
	ev("turn_context", {
		turn_id: "t1",
		cwd: "/workspace/project",
		approval_policy: "never",
		sandbox_policy: { type: "danger-full-access" },
		model: "gpt-5.3-codex",
		collaboration_mode: { mode: "plan" },
		...over,
	});
const msg = (role: string, text: string) =>
	ev("response_item", {
		type: "message",
		role,
		content: [{ type: role === "user" ? "input_text" : "output_text", text }],
	});
const responseItem = (payload: Record<string, unknown>) =>
	ev("response_item", payload);
const eventMsg = (payload: Record<string, unknown>) => ev("event_msg", payload);

const byKind = (steps: Step[], kind: string) =>
	steps.filter((s) => s.kind === kind);

test("builds run metadata from session_meta + turn_context", () => {
	const { run } = parseCodexEvents([
		sessionMeta(),
		turnContext(),
		msg("assistant", "hi"),
	]);
	assert.equal(run.run_id, "019c6b51-run");
	assert.equal(run.harness.name, "codex");
	assert.equal(run.harness.version, "0.100.0");
	assert.equal(run.model, "gpt-5.3-codex");
	assert.equal(run.workspace?.cwd, "/workspace/project");
});

test("an assistant message becomes an llm step; the first user message seeds the plan", () => {
	const { run, steps } = parseCodexEvents([
		sessionMeta(),
		msg("user", "do the thing"),
		msg("assistant", "on it"),
	]);
	const llm = byKind(steps, "llm");
	assert.equal(llm.length, 1);
	assert.equal(run.plan?.statement, "do the thing");
});

test("a reasoning item flags the following llm step as reasoning", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		responseItem({ type: "reasoning", summary: [], content: [] }),
		msg("assistant", "answer"),
	]);
	const llm = byKind(steps, "llm");
	assert.equal(llm.length, 1);
	assert.equal(llm[0].attributes[ATTR.REASONING], true);
});

test("function_call + function_call_output merge into one ok tool_call by call_id", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "function_call",
			name: "exec_command",
			arguments: '{"cmd":"ls"}',
			call_id: "c1",
		}),
		responseItem({
			type: "function_call_output",
			call_id: "c1",
			output: "Process exited with code 0\nOutput:\nok",
		}),
	]);
	const tools = byKind(steps, "tool_call");
	assert.equal(tools.length, 1);
	assert.equal(tools[0].attributes[ATTR.TOOL_NAME], "exec_command");
	assert.equal(tools[0].status, "ok");
	assert.deepEqual(tools[0].attributes[ATTR.TOOL_ARGS], { cmd: "ls" });
	assert.equal(tools[0].attributes[ATTR.TOOL_RESULT_KIND], "bash");
});

test("a non-zero exit code in the output marks the tool_call as an error", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "function_call",
			name: "exec_command",
			arguments: "{}",
			call_id: "c2",
		}),
		responseItem({
			type: "function_call_output",
			call_id: "c2",
			output: "Process exited with code 2\nOutput:\nboom",
		}),
	]);
	const tool = byKind(steps, "tool_call")[0];
	assert.equal(tool.status, "error");
	assert.ok(typeof tool.attributes[ATTR.TOOL_ERROR] === "string");
});

test("custom_tool_call (apply_patch) merges with its output as an edit tool_call", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "custom_tool_call",
			status: "completed",
			call_id: "p1",
			name: "apply_patch",
			input: "*** Begin Patch",
		}),
		responseItem({
			type: "custom_tool_call_output",
			call_id: "p1",
			output: "Success",
		}),
	]);
	const tool = byKind(steps, "tool_call")[0];
	assert.equal(tool.attributes[ATTR.TOOL_NAME], "apply_patch");
	assert.equal(tool.attributes[ATTR.TOOL_RESULT_KIND], "edit");
	assert.equal(tool.status, "ok");
});

test("a standalone web_search_call is a tool_call; a non-completed status is an error", () => {
	const ok = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "web_search_call",
			status: "completed",
			action: { type: "search", query: "q" },
		}),
	]);
	assert.equal(byKind(ok.steps, "tool_call")[0].status, "ok");
	assert.equal(
		byKind(ok.steps, "tool_call")[0].attributes[ATTR.TOOL_NAME],
		"web_search",
	);

	const bad = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "web_search_call",
			status: "failed",
			action: { type: "search", query: "q" },
		}),
	]);
	assert.equal(byKind(bad.steps, "tool_call")[0].status, "error");
});

test("token_count usage deltas attach to the current llm step (cumulative -> per-turn)", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		msg("assistant", "turn one"),
		eventMsg({
			type: "token_count",
			info: {
				total_token_usage: {
					input_tokens: 100,
					output_tokens: 50,
					cached_input_tokens: 10,
					total_tokens: 150,
				},
			},
		}),
		msg("assistant", "turn two"),
		eventMsg({
			type: "token_count",
			info: {
				total_token_usage: {
					input_tokens: 160,
					output_tokens: 90,
					cached_input_tokens: 30,
					total_tokens: 250,
				},
			},
		}),
	]);
	const llm = byKind(steps, "llm");
	assert.equal(llm.length, 2);
	assert.equal(llm[0].attributes[ATTR.INPUT_TOKENS], 100);
	assert.equal(llm[0].attributes[ATTR.OUTPUT_TOKENS], 50);
	assert.equal(llm[1].attributes[ATTR.INPUT_TOKENS], 60); // delta 160-100
	assert.equal(llm[1].attributes[ATTR.OUTPUT_TOKENS], 40); // delta 90-50
	assert.equal(llm[1].attributes[ATTR.CACHE_READ_TOKENS], 20); // delta 30-10
});

test("a token_count before any llm step does not inflate the first llm step", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		eventMsg({
			type: "token_count",
			info: {
				total_token_usage: {
					input_tokens: 2000,
					output_tokens: 0,
					cached_input_tokens: 0,
					total_tokens: 2000,
				},
			},
		}),
		msg("assistant", "first turn"),
		eventMsg({
			type: "token_count",
			info: {
				total_token_usage: {
					input_tokens: 2500,
					output_tokens: 40,
					cached_input_tokens: 0,
					total_tokens: 2540,
				},
			},
		}),
	]);
	const llm = byKind(steps, "llm");
	assert.equal(llm[0].attributes[ATTR.INPUT_TOKENS], 500); // 2500-2000, not 2500
	assert.equal(llm[0].attributes[ATTR.OUTPUT_TOKENS], 40);
});

test("multiple token_count events in one turn credit the full turn delta to its llm step", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		msg("assistant", "turn one"),
		eventMsg({
			type: "token_count",
			info: {
				total_token_usage: {
					input_tokens: 100,
					output_tokens: 20,
					cached_input_tokens: 0,
					total_tokens: 120,
				},
			},
		}),
		eventMsg({
			type: "token_count",
			info: {
				total_token_usage: {
					input_tokens: 160,
					output_tokens: 50,
					cached_input_tokens: 0,
					total_tokens: 210,
				},
			},
		}),
		msg("assistant", "turn two"),
		eventMsg({
			type: "token_count",
			info: {
				total_token_usage: {
					input_tokens: 200,
					output_tokens: 70,
					cached_input_tokens: 0,
					total_tokens: 270,
				},
			},
		}),
	]);
	const llm = byKind(steps, "llm");
	assert.equal(llm[0].attributes[ATTR.INPUT_TOKENS], 160); // full turn, not just the last 60
	assert.equal(llm[0].attributes[ATTR.OUTPUT_TOKENS], 50);
	assert.equal(llm[1].attributes[ATTR.INPUT_TOKENS], 40); // 200-160
});

test("llm steps report the model active at the time, across a mid-session switch", () => {
	const { run, steps } = parseCodexEvents([
		sessionMeta(),
		turnContext({ model: "gpt-5.3-codex" }),
		msg("assistant", "a"),
		turnContext({ model: "gpt-5.3-codex-mini" }),
		msg("assistant", "b"),
	]);
	const llm = byKind(steps, "llm");
	assert.equal(llm[0].attributes[ATTR.MODEL], "gpt-5.3-codex");
	assert.equal(llm[1].attributes[ATTR.MODEL], "gpt-5.3-codex-mini");
	assert.equal(run.model, "gpt-5.3-codex"); // first-seen stays the run's model
});

test("compaction is detected from both the compacted envelope and context_compacted event", () => {
	const a = parseCodexEvents([
		sessionMeta(),
		ev("compacted", { message: "", replacement_history: [] }),
	]);
	assert.equal(byKind(a.steps, "compaction").length, 1);
	const b = parseCodexEvents([
		sessionMeta(),
		eventMsg({ type: "context_compacted" }),
	]);
	assert.equal(byKind(b.steps, "compaction").length, 1);
});

test("turn_context changes emit a mode_change; an unchanged turn_context repeats none", () => {
	const same = parseCodexEvents([sessionMeta(), turnContext(), turnContext()]);
	assert.equal(byKind(same.steps, "mode_change").length, 0);
	const changed = parseCodexEvents([
		sessionMeta(),
		turnContext({ model: "gpt-5.3-codex" }),
		turnContext({ model: "gpt-5.3-codex-mini" }),
	]);
	const modes = byKind(changed.steps, "mode_change");
	assert.equal(modes.length, 1);
	assert.equal(modes[0].attributes[ATTR.MODE_FROM], "gpt-5.3-codex");
	assert.equal(modes[0].attributes[ATTR.MODE_TO], "gpt-5.3-codex-mini");
});

test("task_complete sets the run outcome to completed", () => {
	const { run } = parseCodexEvents([
		sessionMeta(),
		msg("assistant", "done"),
		eventMsg({
			type: "task_complete",
			turn_id: "t1",
			last_agent_message: "all done",
		}),
	]);
	assert.equal(run.outcome?.status, "completed");
});

test("noise events and malformed entries produce no steps and never throw", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		eventMsg({ type: "task_started" }),
		eventMsg({ type: "agent_reasoning", text: "thinking" }),
		eventMsg({ type: "agent_message", message: "dup" }),
		null,
		42,
		{ type: "response_item" }, // missing payload
		{ type: "weird_type", payload: { type: "nope" } },
	]);
	assert.deepEqual(steps, []);
});
