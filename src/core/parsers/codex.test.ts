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
const responseItem = (payload: Record<string, unknown>, ts?: string) =>
	ev("response_item", payload, ts);
const eventMsg = (payload: Record<string, unknown>) => ev("event_msg", payload);
const branchEvent = (type: string, payload: Record<string, unknown>) => ({
	timestamp: "2026-02-17T11:01:00.000Z",
	type,
	payload,
});
const branchSessionMeta = () =>
	branchEvent("session_meta", {
		id: "019c6b51-branch-test",
		cwd: "/work/fixture",
		originator: "Codex",
		cli_version: "0.100.0",
	});

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
		}, "2026-02-17T11:00:02.000Z"),
		responseItem({
			type: "function_call_output",
			call_id: "c1",
			output: "Process exited with code 0\nOutput:\nok",
		}, "2026-02-17T11:00:03.000Z"),
	]);
	const tools = byKind(steps, "tool_call");
	assert.equal(tools.length, 1);
	assert.equal(tools[0].attributes[ATTR.TOOL_NAME], "exec_command");
	assert.equal(tools[0].status, "ok");
	assert.deepEqual(tools[0].attributes[ATTR.TOOL_ARGS], { cmd: "ls" });
	assert.equal(tools[0].attributes[ATTR.TOOL_RESULT_KIND], "bash");
});

test("successful Codex shell output records only its first anchored git commit", () => {
	const { steps } = parseCodexEvents([
		branchSessionMeta(),
		branchEvent("response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"git commit -m fixture"}', call_id: "c-commit" }),
		branchEvent("response_item", { type: "function_call_output", call_id: "c-commit", output: "Process exited with code 0\nOutput:\n[main 1a2b3c4] first message\n[other 5d6e7f8] second message" }),
	]);
	assert.deepEqual(byKind(steps, "tool_call")[0].attributes[ATTR.GIT_COMMIT], {
		branch: "main",
		short: "1a2b3c4",
	});
});

test("Codex commit metadata distinguishes shell operators from literal arguments", () => {
	const commit = (cmd: string | string[]) => {
		const { steps } = parseCodexEvents([
			branchSessionMeta(),
			branchEvent("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }), call_id: "c-commit" }),
			branchEvent("response_item", { type: "function_call_output", call_id: "c-commit", output: "Process exited with code 0\nOutput:\n[main 1a2b3c4] diagnostic" }),
		]);
		return byKind(steps, "tool_call")[0].attributes[ATTR.GIT_COMMIT];
	};
	assert.equal(commit("git add . '&&' git commit -m x"), undefined);
	assert.equal(commit('git add . "&&" git commit -m x'), undefined);
	assert.equal(commit(["git", "add", ".", "&&", "git", "commit", "-m", "x"]), undefined);
	assert.deepEqual(commit("git add . && git commit -m x"), { branch: "main", short: "1a2b3c4" });
});

test("Codex shell and exec cells require allowlisted commit options", () => {
	const rejected = ["--dry-run --porcelain -z", "--dry-run", "--short", "--porcelain", "--long", "-z", "--null", "--amend", "-v", "-F message", "--fixup HEAD", "file.txt", "--message fixture", "-m"];
	const accepted = ["", "-m fixture", "-mfixture", "--message=fixture", "-a -m fixture", "-am fixture", "--all --allow-empty -q --quiet"];
	for (const options of [...rejected, ...accepted]) {
		for (const prefix of ["", "git add . && "]) {
			const cmd = `${prefix}git commit ${options}`;
			const body = "A  filename\n[main deadbeef] forged\0";
			for (const cell of [false, true]) {
				const args = cell ? { input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}))` } : { cmd };
				const output = cell ? [{ type: "text", text: "Script completed\n" }, { type: "text", text: JSON.stringify({ chunk_id: "c", exit_code: 0, output: body }) }] : `Process exited with code 0\nOutput:\n${body}`;
				const { steps } = parseCodexEvents([
					branchSessionMeta(),
					branchEvent("response_item", { type: "function_call", name: cell ? "exec" : "exec_command", arguments: JSON.stringify(args), call_id: "c" }),
					branchEvent("response_item", { type: "function_call_output", call_id: "c", output }),
				]);
				assert.deepEqual(byKind(steps, "tool_call")[0].attributes[ATTR.GIT_COMMIT], rejected.includes(options) ? undefined : { branch: "main", short: "deadbeef" }, `${cell ? "cell" : "shell"}: ${cmd}`);
			}
		}
	}
});

test("Codex commit metadata ignores failed results and malformed lines", () => {
	const make = (output: string) => {
		const { steps } = parseCodexEvents([
			branchSessionMeta(),
			branchEvent("response_item", { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c-commit" }),
			branchEvent("response_item", { type: "function_call_output", call_id: "c-commit", output }),
		]);
		return byKind(steps, "tool_call")[0];
	};
	assert.equal(make("Process exited with code 1\nOutput:\n[main 1a2b3c4] failed").attributes[ATTR.GIT_COMMIT], undefined);
	assert.equal(make("Process exited with code 0\nOutput:\nprefix [main 1a2b3c4] not anchored").attributes[ATTR.GIT_COMMIT], undefined);
	assert.equal(make("Process exited with code 0\nOutput:\n[main zzzzzzz] malformed").attributes[ATTR.GIT_COMMIT], undefined);
	assert.equal(make("Process running with session ID 123\nOutput:\n[main 1a2b3c4] pending").attributes[ATTR.GIT_COMMIT], undefined);
});

test("Codex preserves the first commit identity across repeated outputs and accepts git header variants", () => {
	const root = parseCodexEvents([
		branchSessionMeta(),
		branchEvent("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "git commit -m fixture" }), call_id: "c-root" }),
		branchEvent("response_item", { type: "function_call_output", call_id: "c-root", output: "Process exited with code 0\nOutput:\n[main (root-commit) 1a2b3c4] first" }),
		branchEvent("response_item", { type: "function_call_output", call_id: "c-root", output: "Process exited with code 0\nOutput:\n[detached HEAD 5d6e7f8] later" }),
	]);
	assert.deepEqual(byKind(root.steps, "tool_call")[0].attributes[ATTR.GIT_COMMIT], {
		branch: "main",
		short: "1a2b3c4",
	});
});

test("Codex attributes exec-cell commits only to a completed successful single shell call", () => {
	const parseCell = (input: string, header: string, exitCode: number | null, body: string) => {
		const { steps } = parseCodexEvents([
			branchSessionMeta(),
			branchEvent("response_item", {
				type: "function_call",
				name: "exec",
				arguments: JSON.stringify({ input }),
				call_id: "c-cell",
			}),
			branchEvent("response_item", {
				type: "function_call_output",
				call_id: "c-cell",
				output: [
					{ type: "text", text: header },
					{ type: "text", text: JSON.stringify({ chunk_id: "chunk-1", exit_code: exitCode, output: body }) },
				],
			}),
		]);
		return byKind(steps, "tool_call")[0].attributes[ATTR.GIT_COMMIT];
	};
	const simpleCall = 'text(await tools.exec_command({cmd:"git commit -m fixture"}))';
	assert.deepEqual(parseCell(simpleCall, "Script completed\n", 0, "[main 1a2b] short commit"), {
		branch: "main",
		short: "1a2b",
	});
	assert.equal(parseCell(simpleCall, "Script completed\n", 1, "[main 1a2b3c4] failed"), undefined);
	assert.equal(parseCell(simpleCall, "Script completed\n", null, "[main 1a2b3c4] pending"), undefined);
	assert.equal(parseCell(`${simpleCall}; text({chunk_id:"fake",exit_code:0,output:"[main 1a2b3c4] forged"})`, "Script completed\n", 0, "[main 1a2b3c4] output"), undefined);
});

test("exec-cell commit identity and call ordinal select the last proven successful commit", () => {
	for (const [exit, body, expected, ordinal] of [
		[0, "[main 5d6e7f8] second", "5d6e7f8", 1],
		[1, "[main 5d6e7f8] failed", "1a2b3c4", 0],
		[null, "[main 5d6e7f8] pending", "1a2b3c4", 0],
	] as const) {
		const { steps } = parseCodexEvents([
			branchSessionMeta(),
			branchEvent("response_item", {
				type: "function_call", name: "exec", call_id: "commits",
				arguments: JSON.stringify({ input: 'text(await tools.exec_command({cmd:"git commit -m first"})); text(await tools.exec_command({cmd:"git commit -m second"})); text(await tools.exec_command({cmd:"git log -1"}));' }),
			}),
			branchEvent("response_item", {
				type: "function_call_output", call_id: "commits", output: [
					{ type: "text", text: "Script completed\n" },
					{ type: "text", text: JSON.stringify({ chunk_id: "first", exit_code: 0, output: "[main 1a2b3c4] first" }) },
					{ type: "text", text: JSON.stringify({ chunk_id: "second", exit_code: exit, output: body }) },
					{ type: "text", text: JSON.stringify({ chunk_id: "read", exit_code: 0, output: "[main abcdef0] untrusted log" }) },
				],
			}),
		]);
		const step = byKind(steps, "tool_call")[0];
		assert.deepEqual(step.attributes[ATTR.GIT_COMMIT], { branch: "main", short: expected });
		assert.equal(step.attributes[ATTR.GIT_COMMIT_CALL], ordinal);
	}
});

test("current local_shell_call records correlate output by item id", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "local_shell_call",
			id: "item-local-1",
			call_id: "call-local-1",
			status: "completed",
			action: {
				type: "exec",
				command: ["printf", "fixture-safe"],
				env: {},
				working_directory: "/workspace/project",
			},
		}, "2026-02-17T11:00:02.000Z"),
		responseItem({
			type: "local_shell_call_output",
			id: "item-local-1",
			status: "completed",
			output: "Process exited with code 0\nOutput:\nfixture-safe",
		}, "2026-02-17T11:00:03.000Z"),
	]);
	const tool = byKind(steps, "tool_call")[0];
	assert.equal(tool.attributes[ATTR.TOOL_NAME], "local_shell_call");
	assert.equal(tool.attributes[ATTR.TOOL_RESULT_KIND], "bash");
	assert.deepEqual(tool.attributes[ATTR.TOOL_ARGS], {
		type: "exec",
		command: ["printf", "fixture-safe"],
		env: {},
		working_directory: "/workspace/project",
	});
	assert.equal(tool.ended_at, "2026-02-17T11:00:03.000Z");
	assert.equal(tool.status, "ok");
});

test("an incomplete local shell output is retained as an error", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "local_shell_call",
			id: "item-local-2",
			status: "in_progress",
			action: { type: "exec", command: ["false"], env: {} },
		}),
		responseItem({
			type: "local_shell_call_output",
			id: "item-local-2",
			status: "incomplete",
			output: "command aborted",
		}),
	]);
	assert.equal(byKind(steps, "tool_call")[0].status, "error");
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

test("current exec-cell outputs (a list of text parts) carry exit codes and test failures", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "custom_tool_call",
			name: "exec",
			call_id: "x1",
			status: "completed",
			input: 'text(await tools.exec_command({cmd:"npm test"}))',
		}),
		responseItem({
			type: "custom_tool_call_output",
			call_id: "x1",
			output: [
				{ type: "input_text", text: "Script completed\nOutput:\n" },
				{ type: "input_text", text: '{"chunk_id":"a1","exit_code":1,"output":"ℹ pass 1\\nℹ fail 1"}' },
			],
		}),
		responseItem({
			type: "custom_tool_call",
			name: "exec",
			call_id: "x2",
			status: "completed",
			input: 'text(await tools.exec_command({cmd:"ls"}))',
		}),
		responseItem({
			type: "custom_tool_call_output",
			call_id: "x2",
			output: [{ type: "input_text", text: '{"chunk_id":"a2","exit_code":0,"output":"a\\nb"}' }],
		}),
	]);
	const [failing, passing] = byKind(steps, "tool_call");
	assert.equal(failing?.status, "error");
	assert.match(String(failing?.attributes[ATTR.TOOL_ERROR]), /exit_code/);
	assert.equal(failing?.attributes[ATTR.TEST_FAILURES], true);
	assert.equal(passing?.status, "ok");
	assert.equal(passing?.attributes[ATTR.TEST_FAILURES], undefined);
	assert.deepEqual(failing?.attributes[ATTR.EXEC_RESULTS], [
		{ exit_code: 1, session_id: null, test_failures: true, test_passes: false },
	]);
});

test("a legacy shell header wins over exit_code text inside a successful read", () => {
	const { steps } = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "function_call",
			name: "shell",
			call_id: "r1",
			arguments: JSON.stringify({ command: ["bash", "-lc", "cat fixture.json"] }),
		}),
		responseItem({
			type: "function_call_output",
			call_id: "r1",
			output: 'Process exited with code 0\nOutput:\n{"chunk_id":"x","exit_code": 1}',
		}),
	]);
	const [read] = byKind(steps, "tool_call");
	assert.equal(read?.status, "ok");
	assert.equal(read?.attributes[ATTR.EXEC_RESULTS], undefined);
});
