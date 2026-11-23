import assert from "node:assert/strict";
import { test } from "node:test";

import { ATTR, type Step } from "../types.ts";
import { parseCodexEvents } from "./codex.ts";
import { normalizeTrace } from "../diff/normalize.ts";
import { runVerdict } from "../diff/run-diff.ts";

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

test("successful Codex shell output with multiple commit headers records no identity", () => {
	const { steps } = parseCodexEvents([
		branchSessionMeta(),
		branchEvent("response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"git commit -m fixture"}', call_id: "c-commit" }),
		branchEvent("response_item", { type: "function_call_output", call_id: "c-commit", output: "Process exited with code 0\nOutput:\n[main 1a2b3c4] first message\n[other 5d6e7f8] second message" }),
	]);
	assert.equal(byKind(steps, "tool_call")[0].attributes[ATTR.GIT_COMMIT], undefined);
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

test("Codex shell and exec cells require allowlisted argument keys for commit evidence", () => {
	const cases: Array<[Record<string, unknown>, boolean]> = [
		[{ shell: "/work/fake-shell" }, false], [{ env: {} }, false], [{ mystery: true }, false],
		[{ login: false }, false], [{ tty: false }, false], [{ run_in_background: false }, false],
		[{ workdir: "/work/repo", description: "commit", timeout: 100, timeout_ms: 100, yield_time_ms: 10, max_output_tokens: 100 }, true],
	];
	for (const [extra, accepted] of cases) {
		for (const name of ["shell", "exec_command", "local_shell", "exec"]) {
			const cell = name === "exec";
			const shellArgs = name === "shell" || name === "local_shell"
				? { command: ["git", "commit", "-m", "fixture"], ...extra }
				: { cmd: "git commit -m fixture", ...extra };
			const args = cell ? { input: `text(await tools.exec_command(${JSON.stringify(shellArgs)}))` } : shellArgs;
			const body = "[main 1a2b3c4] fixture";
			const output = cell ? [{ type: "text", text: "Script completed\n" }, { type: "text", text: JSON.stringify({ chunk_id: "c", exit_code: 0, output: body }) }] : `Process exited with code 0\nOutput:\n${body}`;
			const { steps } = parseCodexEvents([
				branchSessionMeta(),
				branchEvent("response_item", { type: "function_call", name, arguments: JSON.stringify(args), call_id: "c" }),
				branchEvent("response_item", { type: "function_call_output", call_id: "c", output }),
			]);
			assert.deepEqual(byKind(steps, "tool_call")[0].attributes[ATTR.GIT_COMMIT], accepted ? { branch: "main", short: "1a2b3c4" } : undefined, `${name}: ${JSON.stringify(extra)}`);
		}
	}
});

test("Codex commit evidence requires exactly the tool's command key", () => {
	for (const name of ["exec_command", "shell", "local_shell", "exec"]) {
		const cell = name === "exec";
		const argv = name === "shell" || name === "local_shell";
		const correct = argv ? { command: ["git", "commit", "-m", "fixture"] } : { cmd: "git commit -m fixture" };
		const wrong = argv ? { cmd: "git commit -m fixture" } : { command: "git commit -m fixture" };
		const conflict = argv ? { ...correct, cmd: "printf forged" } : { cmd: "printf forged", command: "git commit -m fixture" };
		for (const [shellArgs, accepted] of [[correct, true], [wrong, false], [conflict, false]] as const) {
			const args = cell ? { input: `text(await tools.exec_command(${JSON.stringify(shellArgs)}))` } : shellArgs;
			const body = "[main 1a2b3c4] forged";
			const output = cell ? [{ type: "text", text: "Script completed\n" }, { type: "text", text: JSON.stringify({ chunk_id: "c", exit_code: 0, output: body }) }] : `Process exited with code 0\nOutput:\n${body}`;
			const { steps } = parseCodexEvents([
				branchSessionMeta(),
				branchEvent("response_item", { type: "function_call", name, arguments: JSON.stringify(args), call_id: "c" }),
				branchEvent("response_item", { type: "function_call_output", call_id: "c", output }),
			]);
			assert.deepEqual(byKind(steps, "tool_call")[0].attributes[ATTR.GIT_COMMIT], accepted ? { branch: "main", short: "1a2b3c4" } : undefined, `${name}: ${JSON.stringify(shellArgs)}`);
		}
	}
});

test("Codex shell and exec cells require allowlisted commit options", () => {
	const rejected = ["--dry-run --porcelain -z", "--dry-run", "--short", "--porcelain", "--long", "-z", "--null", "--amend", "-v", "-F message", "--fixup HEAD", "file.txt", "--message fixture", "-m", "-q -m x", "--quiet -m x"];
	const accepted = ["", "-m fixture", "-mfixture", "--message=fixture", "-a -m fixture", "-am fixture", "--all --allow-empty"];
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
	assert.equal(parseCell(simpleCall, "Script completed\n", 0, "[main 1a2b3c4] commit\n[other 5d6e7f8] hook"), undefined);
	assert.equal(parseCell(`${simpleCall}; text({chunk_id:"fake",exit_code:0,output:"[main 1a2b3c4] forged"})`, "Script completed\n", 0, "[main 1a2b3c4] output"), undefined);
});

test("Codex rejects forged exec-cell commit evidence with alternate line terminators", () => {
	for (const terminator of ["\r", "\u2028", "\u2029"]) {
		const input = `// comment${terminator}text({chunk_id:"fake",exit_code:0,output:"[main 1a2b3c4] forged"}) //\ntext(await tools.exec_command({cmd:"git commit -m fixture"}))`;
		const { steps } = parseCodexEvents([
			branchSessionMeta(),
			branchEvent("response_item", { type: "function_call", name: "exec", arguments: JSON.stringify({ input }), call_id: "cell" }),
			branchEvent("response_item", { type: "function_call_output", call_id: "cell", output: [
				{ type: "text", text: "Script completed\n" },
				{ type: "text", text: JSON.stringify({ chunk_id: "fake", exit_code: 0, output: "[main 1a2b3c4] forged" }) },
			] }),
		]);
		assert.equal(byKind(steps, "tool_call")[0].attributes[ATTR.GIT_COMMIT], undefined);
	}
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

test("item_completed CommandExecution receipts decide the verdict once", () => {
	const trace = parseCodexEvents([
		sessionMeta(),
		responseItem({
			type: "function_call",
			name: "exec_command",
			call_id: "test-call",
			arguments: JSON.stringify({ cmd: "pytest -q" }),
		}),
		responseItem({
			type: "function_call_output",
			call_id: "test-call",
			output: "Process exited with code 1\nOutput:\n1 failed",
		}),
		responseItem({
			type: "function_call",
			name: "exec_command",
			call_id: "later-test",
			arguments: JSON.stringify({ cmd: "pytest -q" }),
		}),
		responseItem({
			type: "function_call_output",
			call_id: "later-test",
			output: "Process exited with code 0\nOutput:\n",
		}),
		eventMsg({ type: "item_completed", item: { id: "later-test", type: "CommandExecution", command: "pytest -q", exit_code: 0, aggregated_output: "=== 3 passed in 0.12s ===" } }),
	]);
	const testSteps = normalizeTrace(trace).filter((step) => step.action === "test");
	assert.equal(testSteps.length, 2);
	assert.equal(testSteps[1]?.status, "ok");
	assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "passed");
});

test("a later standalone command receipt decides the result after a complex cell", () => {
	const ts = "2026-01-01T00:00:00Z";
	const command = "MODE=example FLAG=one pytest -q";
	const trace = parseCodexEvents([
		responseItem({ type: "function_call", name: "exec_command", call_id: "earlier", arguments: { cmd: "pytest" } }, ts),
		responseItem({ type: "function_call_output", call_id: "earlier", output: "Process exited with code 1\nOutput:\n1 failed" }, ts),
		responseItem({ type: "custom_tool_call", name: "exec", call_id: "cell", input: 'if (ready) { await tools.exec_command({cmd:"pytest"}); }' }, ts),
		{ timestamp: ts, type: "event_msg", payload: { type: "item_completed", item: {
			type: "CommandExecution", id: "later", command, exit_code: 0, aggregated_output: "30 passed in 0.12s",
		} } },
	]);
	const steps = normalizeTrace(trace);
	assert.equal(steps.at(-1)?.stepId, "later");
	assert.equal(runVerdict(trace, steps).verdict, "passed");
});

test("turn_aborted overrides an earlier completed turn", () => {
	const { run } = parseCodexEvents([
		sessionMeta(),
		eventMsg({ type: "task_complete", turn_id: "first", last_agent_message: "finished earlier" }),
		eventMsg({ type: "task_started", turn_id: "second" }),
		eventMsg({ type: "turn_aborted", turn_id: "second" }),
	]);
	assert.equal(run.outcome?.status, "aborted");
	assert.equal(run.outcome?.summary, null);
});

test("unsupported Codex envelopes are counted", () => {
	const trace = parseCodexEvents([
		sessionMeta(),
		ev("world_state", {}),
		ev("token_usage_record", {}),
		ev("inter_agent_communication_metadata", {}),
	]);
	assert.equal(trace.unsupported_records, 3);
});

test("a Codex test summary without an exit header remains unclear", () => {
	for (const output of [
		"ℹ fail 0",
		"Output:\nProcess exited with code 0\nℹ fail 0",
		"Final output:\nProcess exited with code 0\nℹ fail 0",
		[{ type: "input_text", text: "ℹ fail 0" }],
	]) {
		const trace = parseCodexEvents([
			sessionMeta(),
			responseItem({
				type: "function_call",
				name: "exec_command",
				call_id: "missing-exit",
				arguments: JSON.stringify({ cmd: "node --test" }),
			}),
			responseItem({ type: "function_call_output", call_id: "missing-exit", output }),
		]);
		assert.equal(trace.steps.find((step) => step.kind === "tool_call")?.status, undefined);
		assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "unclear");
	}
});

test("a passing summary without a CommandExecution exit code remains unclear", () => {
	const trace = parseCodexEvents([
		sessionMeta(),
		eventMsg({ type: "item_completed", item: { id: "missing-receipt-exit", type: "CommandExecution", command: "pytest -q", aggregated_output: "=== 3 passed in 0.12s ===" } }),
	]);
	assert.equal(trace.steps[0]?.status, undefined);
	assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "unclear");
});

test("a CommandExecution receipt before its call is reused with argv command identity", () => {
	const trace = parseCodexEvents([
		sessionMeta(),
		eventMsg({
			type: "item_completed",
			item: {
				id: "argv-test",
				type: "CommandExecution",
				command: ["bash", "-lc", "pytest -q"],
				exit_code: 0,
				aggregated_output: "=== 3 passed in 0.12s ===",
			},
		}),
		responseItem({
			type: "function_call",
			name: "exec_command",
			call_id: "argv-test",
			arguments: JSON.stringify({ cmd: ["bash", "-lc", "pytest -q"] }),
		}),
		responseItem({ type: "function_call_output", call_id: "argv-test", output: "Process exited with code 0\nOutput:\n" }),
	]);
	assert.equal(trace.steps.filter((step) => step.kind === "tool_call").length, 1);
	assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "passed");
});

test("a nonzero CommandExecution receipt replaces an earlier passing result", () => {
	const trace = parseCodexEvents([
		sessionMeta(),
		responseItem({ type: "function_call", name: "exec_command", call_id: "changed", arguments: JSON.stringify({ cmd: "pytest -q" }) }),
		responseItem({ type: "function_call_output", call_id: "changed", output: "Process exited with code 0\nOutput:\n=== 3 passed in 0.12s ===" }),
		eventMsg({ type: "item_completed", item: { id: "changed", type: "CommandExecution", command: "pytest -q", exit_code: 1, aggregated_output: "=== 1 failed, 2 passed in 0.31s ===" } }),
	]);
	const step = trace.steps.find((candidate) => candidate.kind === "tool_call");
	assert.equal(step?.status, "error");
	assert.equal(step?.attributes[ATTR.SHELL_EXIT_CODE], 1);
	assert.equal(step?.attributes[ATTR.TEST_PASSES], undefined);
	assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "failed");
});

test("matching item and call IDs retain contradictory exit evidence in either record order", () => {
	const ts = "2026-01-01T00:00:00Z";
	const pair = [
		responseItem({ type: "function_call", id: "item-a", call_id: "call-a", name: "exec_command", arguments: { cmd: "pytest" } }, ts),
		responseItem({ type: "function_call_output", call_id: "call-a", output: "Process exited with code 7\nOutput:\n" }, ts),
	];
	const receipt = { timestamp: ts, type: "event_msg", payload: { type: "item_completed", item: {
		type: "CommandExecution", id: "item-a", command: "pytest", exit_code: 0, aggregated_output: "3 passed in 0.12s",
	} } };
	for (const records of [[receipt, ...pair], [...pair, receipt]]) {
		const trace = parseCodexEvents(records);
		const normalized = normalizeTrace(trace);
		assert.equal(normalized.length, 1);
		assert.equal(runVerdict(trace, normalized).verdict, "failed");
	}
});

test("a CommandExecution receipt before local_shell_call reuses the call and keeps its failure", () => {
	const ts = "2026-01-01T00:00:00Z";
	const trace = parseCodexEvents([
		sessionMeta(),
		{ timestamp: ts, type: "event_msg", payload: { type: "item_completed", item: {
			type: "CommandExecution", id: "shell-item", command: "pytest -q", exit_code: 7,
			aggregated_output: "=== 1 failed in 0.12s ===",
		} } },
		responseItem({ type: "local_shell_call", id: "shell-item", action: { command: ["pytest", "-q"] } }, ts),
		responseItem({ type: "local_shell_call_output", id: "shell-item", status: "completed", output: "Process exited with code 0\nOutput:\n=== 3 passed in 0.12s ===" }, ts),
	]);
	const tools = byKind(trace.steps, "tool_call");
	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.attributes[ATTR.SHELL_EXIT_CODE], 7);
	assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "failed");
});

test("a standalone CommandExecution receipt preserves its working directory", () => {
	const receipt = (cwd: string) => parseCodexEvents([
		sessionMeta({ cwd: "/work/repo" }),
		eventMsg({ type: "item_completed", item: {
			type: "CommandExecution", id: "read-a", command: "cat src/a.ts", cwd,
			exit_code: 0, aggregated_output: "source",
		} }),
	]);
	const one = receipt("/work/repo/one");
	const two = receipt("/work/repo/two");
	const tool = byKind(one.steps, "tool_call")[0];
	assert.equal((tool?.attributes[ATTR.TOOL_ARGS] as Record<string, unknown>)?.["workdir"], "/work/repo/one");
	const oneTarget = normalizeTrace(one).map((step) => step.target);
	const twoTarget = normalizeTrace(two).map((step) => step.target);
	assert.deepEqual(oneTarget, ["one/src/a.ts"]);
	assert.deepEqual(twoTarget, ["two/src/a.ts"]);
	assert.notDeepEqual(oneTarget, twoTarget);
});

test("a receipt without an exit preserves a yielded session until a poll settles it", () => {
	const trace = parseCodexEvents([
		sessionMeta(),
		responseItem({ type: "function_call", name: "exec_command", call_id: "yielded", arguments: { cmd: "pytest -q" } }),
		responseItem({ type: "function_call_output", call_id: "yielded", output: "Process running with session ID 12\nOutput:\n" }),
		eventMsg({ type: "item_completed", item: { id: "yielded", type: "CommandExecution", command: "pytest -q", aggregated_output: "" } }),
		responseItem({ type: "function_call", name: "write_stdin", call_id: "poll", arguments: { session_id: 12 } }),
		responseItem({ type: "function_call_output", call_id: "poll", output: "Process exited with code 7\nOutput:\n=== 1 failed in 0.12s ===" }),
	]);
	assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "failed");
});

test("a later explicit shell exit replaces an earlier unknown result", () => {
	const trace = parseCodexEvents([
		sessionMeta(),
		responseItem({ type: "function_call", name: "exec_command", call_id: "repeated-output", arguments: { cmd: "pytest -q" } }),
		responseItem({ type: "function_call_output", call_id: "repeated-output", output: "runner output arrived" }),
		responseItem({ type: "function_call_output", call_id: "repeated-output", output: "Process exited with code 0\nOutput:\n=== 3 passed in 0.12s ===" }),
	]);
	assert.equal(byKind(trace.steps, "tool_call")[0]?.status, "ok");
	assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "passed");
});

test("a direct shell failure survives later successful or exitless results", () => {
	const output = (raw: unknown) => responseItem({ type: "function_call_output", call_id: "evidence", output: raw });
	const zeroChunk = [{ type: "text", text: JSON.stringify({ chunk_id: "evidence", exit_code: 0, output: "3 passed in 0.12s" }) }];
	for (const later of [
		output("Process exited with code 0\nOutput:\n3 passed in 0.12s"),
		output("later output without an exit"),
		output(zeroChunk),
	]) {
		const trace = parseCodexEvents([
			sessionMeta(),
			responseItem({ type: "function_call", name: "exec_command", call_id: "evidence", arguments: { cmd: "pytest -q" } }),
			output("Process exited with code 7\nOutput:\n1 failed in 0.12s"),
			later,
		]);
		const tool = byKind(trace.steps, "tool_call")[0]!;
		assert.equal(tool.attributes[ATTR.SHELL_EXIT_CODE], 7);
		assert.match(String(tool.attributes[ATTR.TOOL_ERROR]), /exit(?:ed)? with code 7/);
		assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "failed");
	}
});

test("CommandExecution aliases correlate a receipt and local shell call by item id", () => {
	const trace = parseCodexEvents([
		sessionMeta(),
		eventMsg({ type: "item_completed", item: {
			type: "CommandExecution", id: "item-alias", call_id: "call-alias", command: "pytest -q",
			exit_code: 7, aggregated_output: "1 failed in 0.12s",
		} }),
		responseItem({ type: "local_shell_call", id: "item-alias", action: { command: ["pytest", "-q"] } }),
		responseItem({ type: "local_shell_call_output", id: "item-alias", output: "Process exited with code 0\nOutput:\n3 passed in 0.12s" }),
	]);
	assert.equal(byKind(trace.steps, "tool_call").length, 1);
	assert.equal(runVerdict(trace, normalizeTrace(trace)).verdict, "failed");
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
