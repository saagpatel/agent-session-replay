import assert from "node:assert/strict";
import { test } from "node:test";

import { ATTR, type Step } from "../types.ts";
import {
	parseClaudeCodeEvents,
	parseClaudeCodeTranscript,
} from "./claude-code.ts";

const TS1 = "2026-06-20T10:00:00.000Z";
const TS2 = "2026-06-20T10:00:01.000Z";

function find(steps: Step[], pred: (s: Step) => boolean): Step {
	const s = steps.find(pred);
	assert.ok(s, "expected a matching step");
	return s;
}

test("classifies only observed non-Step user, system and summary parents", () => {
	for (const kind of ["user", "system", "summary", "assistant", "progress", "missing"]) {
		const parent = { type: kind, uuid: "parent", timestamp: TS1, message: { content: "Synthetic context." } };
		const child = {
			type: "assistant", uuid: "child", parentUuid: "parent", timestamp: TS2,
			message: { content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/work/project/src/a.ts" } }] },
		};
		// Classification uses all observed events, including an out-of-order parent.
		const trace = parseClaudeCodeEvents(kind === "missing" ? [child] : [child, parent]);
		for (const id of ["child", "toolu_read"]) {
			assert.equal(trace.steps.find((step) => step.step_id === id)!.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND],
				["user", "system", "summary"].includes(kind) ? kind : undefined, `${kind}: ${id}`);
		}
	}
	for (const subtype of ["compact_boundary", "hook"]) {
		const trace = parseClaudeCodeEvents([
			{ type: "system", uuid: "parent", subtype, timestamp: TS1 },
			{ type: "assistant", uuid: "child", parentUuid: "parent", timestamp: TS2, message: { content: "Done." } },
		]);
		assert.ok(trace.steps.some((step) => step.step_id === "parent"));
		assert.equal(trace.steps.find((step) => step.step_id === "child")!.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND], undefined);
	}
});

test("builds run metadata from session events", () => {
	const events = [
		{
			type: "user",
			sessionId: "sess-1",
			version: "1.2.3",
			entrypoint: "cli",
			cwd: "/repo",
			gitBranch: "main",
			timestamp: TS1,
			uuid: "u1",
			message: { role: "user", content: "Build the parser" },
		},
		{
			type: "assistant",
			sessionId: "sess-1",
			timestamp: TS2,
			uuid: "a1",
			parentUuid: "u1",
			message: {
				role: "assistant",
				model: "claude-opus-4-8",
				stop_reason: "end_turn",
				usage: { input_tokens: 10, output_tokens: 5 },
				content: [{ type: "text", text: "done" }],
			},
		},
	];
	const trace = parseClaudeCodeEvents(events);
	assert.equal(trace.plumbline_version, "0.1.0");
	assert.equal(trace.run.run_id, "sess-1");
	assert.equal(trace.run.harness.name, "claude-code");
	assert.equal(trace.run.harness.version, "1.2.3");
	assert.equal(trace.run.model, "claude-opus-4-8");
	assert.equal(trace.run.started_at, TS1);
	assert.equal(trace.run.ended_at, TS2);
	assert.deepEqual(trace.run.workspace, { cwd: "/repo", git_branch: "main" });
	assert.equal(trace.run.plan?.statement, "Build the parser");
	assert.equal(trace.run.outcome?.status, "completed");
});

test("run window is the min/max event timestamp, independent of event order", () => {
	// Subagent sidechains get concatenated by file size, so the chronologically
	// latest event is often NOT last in the array. The run window must be min/max,
	// not first/last-in-order, or the timeline collapses to a sliver and later
	// steps clamp to the right edge.
	const T0 = "2026-06-20T10:00:00.000Z"; // earliest
	const T1 = "2026-06-20T10:05:00.000Z";
	const T2 = "2026-06-20T10:12:00.000Z"; // latest
	const ev = (ts: string, sidechain: boolean) => ({
		type: "assistant",
		sessionId: "sess-1",
		timestamp: ts,
		uuid: `u-${ts}`,
		...(sidechain ? { isSidechain: true, agentId: "sub-1" } : {}),
		message: { role: "assistant", content: [{ type: "text", text: "x" }] },
	});
	// Out of chronological order: mid first, max in the middle, min last.
	const trace = parseClaudeCodeEvents([
		ev(T1, false),
		ev(T2, true),
		ev(T0, true),
	]);
	assert.equal(
		trace.run.started_at,
		T0,
		"started_at must be the min timestamp",
	);
	assert.equal(trace.run.ended_at, T2, "ended_at must be the max timestamp");
});

test("llm step captures model, token usage incl. cache, finish reason, reasoning", () => {
	const events = [
		{
			type: "assistant",
			sessionId: "s",
			uuid: "a1",
			timestamp: TS1,
			message: {
				model: "claude-opus-4-8",
				stop_reason: "tool_use",
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_read_input_tokens: 2000,
					cache_creation_input_tokens: 300,
				},
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "ok" },
				],
			},
		},
	];
	const llm = find(
		parseClaudeCodeEvents(events).steps,
		(s) => s.kind === "llm",
	);
	assert.equal(llm.attributes[ATTR.MODEL], "claude-opus-4-8");
	assert.equal(llm.attributes[ATTR.INPUT_TOKENS], 100);
	assert.equal(llm.attributes[ATTR.OUTPUT_TOKENS], 50);
	assert.equal(llm.attributes[ATTR.CACHE_READ_TOKENS], 2000);
	assert.equal(llm.attributes[ATTR.CACHE_CREATION_TOKENS], 300);
	assert.deepEqual(llm.attributes[ATTR.FINISH_REASONS], ["tool_use"]);
	assert.equal(llm.attributes[ATTR.REASONING], true);
});

test("assistant message fragments count usage once and keep each tool call", () => {
	const trace = parseClaudeCodeEvents([
		{
			type: "assistant",
			uuid: "fragment-1",
			timestamp: TS1,
			message: {
				id: "msg-1",
				usage: { input_tokens: 12, cache_read_input_tokens: 9 },
				content: [
					{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/example-a" } },
				],
			},
		},
		{
			type: "assistant",
			uuid: "fragment-2",
			timestamp: TS2,
			message: {
				id: "msg-1",
				usage: { input_tokens: 12, cache_read_input_tokens: 9, output_tokens: 4 },
				stop_reason: "tool_use",
				content: [
					{ type: "thinking", thinking: "Example reasoning." },
					{ type: "tool_use", id: "tool-2", name: "Grep", input: { pattern: "fixture" } },
				],
			},
		},
		{
			type: "assistant",
			uuid: "child",
			parentUuid: "fragment-2",
			timestamp: TS2,
			message: { content: "Finished." },
		},
	]);
	const llm = find(trace.steps, (step) => step.kind === "llm");
	assert.equal(trace.steps.filter((step) => step.kind === "llm").length, 2);
	assert.equal(llm.attributes[ATTR.INPUT_TOKENS], 12);
	assert.equal(llm.attributes[ATTR.OUTPUT_TOKENS], 4);
	assert.equal(llm.attributes[ATTR.CACHE_READ_TOKENS], 9);
	assert.equal(llm.attributes[ATTR.REASONING], true);
	assert.deepEqual(llm.attributes[ATTR.FINISH_REASONS], ["tool_use"]);
	assert.equal(llm.started_at, TS1);
	assert.equal(llm.ended_at, TS2);
	assert.deepEqual(
		trace.steps.filter((step) => step.kind === "tool_call").map((step) => step.step_id),
		["tool-1", "tool-2"],
	);
	assert.equal(find(trace.steps, (step) => step.step_id === "child").parent_step_id, "fragment-1");
	assert.ok(!trace.external_parent_ids?.includes("fragment-2"));
});

test("a fragment without a timestamp does not inherit an intervening event time", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "assistant", uuid: "fragment-first", timestamp: TS1, message: { id: "timestamped-message", content: "First fragment." } },
		{ type: "user", uuid: "intervening-event", timestamp: TS2, message: { content: "Other activity." } },
		{ type: "assistant", uuid: "fragment-untimed", message: { id: "timestamped-message", content: "Last fragment." } },
	]);
	const llm = find(trace.steps, (step) => step.kind === "llm");
	assert.equal(llm.started_at, TS1);
	assert.equal(llm.ended_at, TS1);
});

test("a real fragment timestamp is retained when it equals an inferred start", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "system", uuid: "timed-context", timestamp: TS1, subtype: "other" },
		{ type: "assistant", uuid: "fragment-inferred", message: { id: "inferred-message", content: "First fragment." } },
		{ type: "assistant", uuid: "fragment-actual", timestamp: TS1, message: { id: "inferred-message", content: "Second fragment." } },
	]);
	const llm = find(trace.steps, (step) => step.kind === "llm");
	assert.equal(llm.started_at, TS1);
	assert.equal(llm.ended_at, TS1);
});

test("usage counters on coalesced message fragments keep the greatest cumulative value", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "assistant", uuid: "usage-first", timestamp: TS1, message: { id: "usage-message", usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 10 }, content: [{ type: "text", text: "First fragment." }] } },
		{ type: "assistant", uuid: "usage-final", timestamp: TS2, message: { id: "usage-message", usage: { input_tokens: 20, output_tokens: 42, cache_read_input_tokens: 10 }, content: [{ type: "text", text: "Final fragment." }] } },
	]);
	const llm = find(trace.steps, (step) => step.kind === "llm");
	assert.equal(llm.attributes[ATTR.OUTPUT_TOKENS], 42);
});

test("background Bash launch stays pending and preserves its task output path", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "assistant", uuid: "launch-call", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash-launch", name: "Bash", input: { command: "pytest -q > /tmp/example-tests.log 2>&1 &" } }] } },
		{ type: "user", uuid: "launch-result", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash-launch", content: "Process started" }] }, toolUseResult: { backgroundTaskId: "task-1", outputFile: "/tmp/example-tests.log" } },
	]);
	const launch = find(trace.steps, (step) => step.step_id === "bash-launch");
	assert.equal(launch.status, undefined);
	assert.equal(launch.ended_at, undefined);
	assert.equal(launch.attributes["claude.background_task_id"], "task-1");
	assert.equal(launch.attributes["claude.background_output_file"], "/tmp/example-tests.log");
});

test("background Bash launch with an explicit error or interruption is terminal", () => {
	for (const [result, isError, expectedStatus] of [
		[{ backgroundTaskId: "task-error", outputFile: "/tmp/example-error.log" }, true, "error"],
		[{ backgroundTaskId: "task-interrupted", outputFile: "/tmp/example-interrupted.log", interrupted: true }, false, "interrupted"],
		[{ backgroundTaskId: "task-exit", outputFile: "/tmp/example-exit.log", exitCode: 17 }, undefined, "error"],
	] as const) {
		const trace = parseClaudeCodeEvents([
			{ type: "assistant", uuid: "background-error-call", timestamp: TS1, message: { content: [{ type: "tool_use", id: "background-error-tool", name: "Bash", input: { command: "pytest -q" } }] } },
			{ type: "user", uuid: "background-error-result", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "background-error-tool", is_error: isError, content: "Synthetic launch failure." }] }, toolUseResult: result },
		]);
		const launch = find(trace.steps, (step) => step.step_id === "background-error-tool");
		assert.equal(launch.status, expectedStatus);
		assert.equal(launch.ended_at, TS2);
		assert.equal(launch.attributes[ATTR.CLAUDE_BACKGROUND_TASK_ID], result.backgroundTaskId);
		assert.equal(launch.attributes[ATTR.TOOL_ERROR], "Synthetic launch failure.");
		if ("exitCode" in result) assert.equal(launch.attributes[ATTR.SHELL_EXIT_CODE], 17);
		assert.equal(launch.attributes[ATTR.GUARD_TRIPPED], undefined);
	}
});

test("event-level exit metadata does not certify multiple Bash results", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "assistant", uuid: "batch-call-a", timestamp: TS1, message: { content: [{ type: "tool_use", id: "batch-a", name: "Bash", input: { command: "cat example.txt" } }] } },
		{ type: "assistant", uuid: "batch-call-test", timestamp: TS1, message: { content: [{ type: "tool_use", id: "batch-test", name: "Bash", input: { command: "pytest -q" } }] } },
		{ type: "user", uuid: "batch-results", timestamp: TS2, toolUseResult: { exitCode: 0 }, message: { content: [
			{ type: "tool_result", tool_use_id: "batch-a", content: "Synthetic file contents." },
			{ type: "tool_result", tool_use_id: "batch-test", content: "3 passed in 0.12s" },
		] } },
	]);
	const test = find(trace.steps, (step) => step.step_id === "batch-test");
	assert.equal(test.attributes[ATTR.SHELL_EXIT_CODE], undefined);
	assert.equal(test.status, undefined);
	assert.equal(test.attributes[ATTR.TEST_PASSES], true);
});

test("event-level interruption metadata does not terminate multiple tool results", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "assistant", uuid: "batch-interrupted-a", timestamp: TS1, message: { content: [{ type: "tool_use", id: "batch-interrupted-a-tool", name: "Bash", input: { command: "cat example.txt" } }] } },
		{ type: "assistant", uuid: "batch-interrupted-test", timestamp: TS1, message: { content: [{ type: "tool_use", id: "batch-interrupted-test-tool", name: "Bash", input: { command: "pytest -q" } }] } },
		{ type: "user", uuid: "batch-interrupted-results", timestamp: TS2, toolUseResult: { interrupted: true, stdout: "Synthetic event-level output." }, message: { content: [
			{ type: "tool_result", tool_use_id: "batch-interrupted-a-tool", content: "Synthetic file contents." },
			{ type: "tool_result", tool_use_id: "batch-interrupted-test-tool", content: "3 passed in 0.12s" },
		] } },
	]);
	const test = find(trace.steps, (step) => step.step_id === "batch-interrupted-test-tool");
	assert.equal(test.status, undefined);
	assert.equal(test.attributes[ATTR.TEST_PASSES], true);
});

test("background Bash result text supplies its exact output path", () => {
	const trace = parseClaudeCodeEvents([
		{
			type: "assistant",
			uuid: "launch-call",
			timestamp: TS1,
			message: { content: [{ type: "tool_use", id: "bash-launch", name: "Bash", input: { command: "pytest -q" } }] },
		},
		{
			type: "user",
			uuid: "launch-result",
			timestamp: TS2,
			message: {
				content: [{
					type: "tool_result",
					tool_use_id: "bash-launch",
					content: "Command running in background with ID: job-a. Output is being written to: /tmp/example/job-a.output",
				}],
			},
			toolUseResult: { backgroundTaskId: "job-a" },
		},
	]);
	const launch = find(trace.steps, (step) => step.step_id === "bash-launch");
	assert.equal(launch.attributes["claude.background_output_file"], "/tmp/example/job-a.output");
});

test("only a later read of the task output supplies evidence on the pending launch", () => {
	const outputFile = "/tmp/example/job-a.output";
	const result = (id: string, content: string, toolUseResult: Record<string, unknown>) => ({
		type: "user", timestamp: TS2, toolUseResult,
		message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
	});
	const call = (id: string, command: string) => ({
		type: "assistant", uuid: id + "-event", timestamp: TS1,
		message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
	});
	for (const [command, matches] of [
		[`tail -n 5 '${outputFile}'`, true],
		[`cat ${outputFile}.old`, false],
		[`cat ${outputFile} | printf '3 passed in 0.12s'`, false],
		[`cat /tmp/example/other ${outputFile}`, false],
	] as const) {
		const trace = parseClaudeCodeEvents([
			call("launch", "pytest -q"), result("launch", "Started", { backgroundTaskId: "job-a", outputFile }),
			call("read", command), result("read", "3 passed in 0.12s", { exitCode: 0 }),
		]);
		const launch = find(trace.steps, (step) => step.step_id === "launch");
		assert.equal(launch.attributes[ATTR.TEST_PASSES], matches || undefined, command);
		assert.equal(launch.status, undefined);
		assert.equal(launch.ended_at, undefined);
	}
});

test("missing or nonzero Bash exit evidence does not claim success", () => {
	for (const [result, expected] of [[{ exitCode: 7 }, "error"], [{}, undefined]] as const) {
		const trace = parseClaudeCodeEvents([
			{ type: "assistant", uuid: "call", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash-test", name: "Bash", input: { command: "pytest -q" } }] } },
			{ type: "user", uuid: "result", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash-test", content: "3 passed in 0.12s" }] }, toolUseResult: result },
		]);
		assert.equal(find(trace.steps, (step) => step.step_id === "bash-test").status, expected);
	}
});

test("wrong-typed duplicate tool result is malformed and does not replace valid result", () => {
	const trace = parseClaudeCodeTranscript([
		{ type: "assistant", uuid: "call", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash-test", name: "Bash", input: { command: "pytest -q" } }] } },
		{ type: "user", uuid: "good", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash-test", is_error: false, content: "3 passed in 0.12s" }] }, toolUseResult: { exitCode: 0 } },
		{ type: "user", uuid: "bad", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash-test", is_error: "false", content: "failed" }] } },
	].map((event) => JSON.stringify(event)).join("\n"));
	assert.equal(trace.malformed_lines, 1);
	const step = find(trace.steps, (item) => item.step_id === "bash-test");
	assert.equal(step.status, "ok");
	assert.equal(step.attributes[ATTR.TEST_FAILURES], undefined);
});

test("a later Claude result does not replace the first result for a tool use", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "assistant", uuid: "call", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash-test", name: "Bash", input: { command: "pytest -q" } }] } },
		{ type: "user", uuid: "first-result", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash-test", content: "1 failed in 0.12s" }] }, toolUseResult: { exitCode: 7 } },
		{ type: "user", uuid: "duplicate-result", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash-test", content: "1 passed in 0.12s" }] }, toolUseResult: { exitCode: 0 } },
	]);
	const step = find(trace.steps, (item) => item.step_id === "bash-test");
	assert.equal(step.status, "error");
	assert.equal(step.attributes[ATTR.SHELL_EXIT_CODE], 7);
	assert.deepEqual(step.attributes[ATTR.CLAUDE_RESULT_EVENT_UUIDS], ["first-result", "duplicate-result"]);
	assert.equal(trace.malformed_lines, 1);
});

test("the first Bash result remains authoritative when duplicate exits are reversed", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "assistant", uuid: "call", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash-test", name: "Bash", input: { command: "pytest -q" } }] } },
		{ type: "user", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash-test", content: "1 passed in 0.12s" }] }, toolUseResult: { exitCode: 0 } },
		{ type: "user", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash-test", content: "1 failed in 0.12s" }] }, toolUseResult: { exitCode: 7 } },
	]);
	const step = find(trace.steps, (item) => item.step_id === "bash-test");
	assert.equal(step.status, "ok");
	assert.equal(step.attributes[ATTR.SHELL_EXIT_CODE], 0);
	assert.equal(trace.malformed_lines, 1);
});

test("multiple malformed tool results on one line count once", () => {
	const trace = parseClaudeCodeTranscript([
		JSON.stringify({
			type: "user",
			uuid: "bad-results",
			timestamp: TS1,
			message: { content: [
				{ type: "tool_result", tool_use_id: "missing-a", is_error: "false" },
				{ type: "tool_result", tool_use_id: "missing-b", is_error: 1 },
			] },
		}),
	].join("\n"));
	assert.equal(trace.malformed_lines, 1);
});

test("non-test Bash with explicit is_error false retains successful status", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "assistant", uuid: "call", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash-routine", name: "Bash", input: { command: "git status --short" } }] } },
		{ type: "user", uuid: "result", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash-routine", is_error: false, content: "working tree clean" }] } },
	]);
	assert.equal(find(trace.steps, (step) => step.step_id === "bash-routine").status, "ok");
});

test("tool_use + matching tool_result merge into one ok tool_call step", () => {
	const events = [
		{
			type: "assistant",
			sessionId: "s",
			uuid: "a1",
			timestamp: TS1,
			message: {
				content: [
					{
						type: "tool_use",
						id: "tu1",
						name: "Read",
						input: { file_path: "/x" },
					},
				],
			},
		},
		{
			type: "user",
			uuid: "u2",
			timestamp: TS2,
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu1",
						is_error: false,
						content: "file body",
					},
				],
			},
			toolUseResult: { type: "text" },
		},
	];
	const tc = find(
		parseClaudeCodeEvents(events).steps,
		(s) => s.kind === "tool_call",
	);
	assert.equal(tc.attributes[ATTR.TOOL_NAME], "Read");
	assert.equal(tc.attributes[ATTR.TOOL_RESULT_KIND], "read");
	assert.equal(tc.status, "ok");
	assert.equal(tc.ended_at, TS2);
});

test("Claude commit evidence requires allowlisted shell arguments", () => {
	const cases: Array<[Record<string, unknown>, boolean]> = [
		[{ shell: "/work/fake-shell" }, false], [{ env: {} }, false], [{ mystery: true }, false],
		[{ run_in_background: false }, false],
		[{ cmd: "printf forged" }, false],
		[{ workdir: "/work/repo", description: "commit", timeout: 100, timeout_ms: 100, yield_time_ms: 10, max_output_tokens: 100 }, true],
	];
	for (const [extra, accepted] of cases) {
		const { steps } = parseClaudeCodeEvents([
			{ type: "assistant", sessionId: "s", uuid: "a1", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "git commit -m fixture", ...extra } }] } },
			{ type: "user", sessionId: "s", uuid: "u1", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash1", content: "[main 1a2b3c4] fixture" }] }, toolUseResult: { type: "bash", stdout: "[main 1a2b3c4] fixture", stderr: "", interrupted: false, isImage: false } },
		]);
		assert.deepEqual(find(steps, (s) => s.kind === "tool_call").attributes[ATTR.GIT_COMMIT], accepted ? { branch: "main", short: "1a2b3c4" } : undefined);
	}
});

test("Claude Bash does not infer a command from cmd alone", () => {
	const { steps } = parseClaudeCodeEvents([
		{ type: "assistant", sessionId: "s", uuid: "a1", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { cmd: "git commit -m fixture" } }] } },
		{ type: "user", sessionId: "s", uuid: "u1", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash1", content: "[main 1a2b3c4] fixture" }] }, toolUseResult: { type: "bash", stdout: "[main 1a2b3c4] fixture" } },
	]);
	assert.equal(find(steps, (s) => s.kind === "tool_call").attributes[ATTR.GIT_COMMIT], undefined);
});

test("successful Bash output with multiple commit headers records no identity", () => {
	const { steps } = parseClaudeCodeEvents([
		{
			type: "assistant",
			sessionId: "s",
			uuid: "a1",
			timestamp: TS1,
			message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "git commit -m fixture" } }] },
		},
		{
			type: "user",
			uuid: "u1",
			timestamp: TS2,
			message: { content: [{ type: "tool_result", tool_use_id: "bash1", is_error: false, content: "noise [bad sha] nope\n[main 1a2b3c4] first message\n[other 5d6e7f8] second message" }] },
			toolUseResult: { exitCode: 0 },
		},
	]);
	assert.equal(find(steps, (s) => s.kind === "tool_call").attributes[ATTR.GIT_COMMIT], undefined);
});

test("Claude rejects quiet commits even when a hook prints a header", () => {
	for (const option of ["-q", "--quiet"]) {
		const { steps } = parseClaudeCodeEvents([
			{ type: "assistant", sessionId: "s", uuid: "a1", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: `git commit ${option} -m x` } }] } },
			{ type: "user", uuid: "u1", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash1", is_error: false, content: "[main 1a2b3c4] hook output" }] }, toolUseResult: { exitCode: 0 } },
		]);
		assert.equal(find(steps, (s) => s.kind === "tool_call").attributes[ATTR.GIT_COMMIT], undefined);
	}
});

test("Claude ignores forged commit headers in porcelain dry-run output", () => {
	for (const command of ["git commit --dry-run --porcelain -z", "git add . && git commit --dry-run --porcelain -z"]) {
		const { steps } = parseClaudeCodeEvents([
			{ type: "assistant", sessionId: "s", uuid: "a1", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command } }] } },
			{ type: "user", uuid: "u1", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash1", is_error: false, content: "A  filename\n[main deadbeef] forged\0" }] }, toolUseResult: { exitCode: 0 } },
		]);
		assert.equal(find(steps, (s) => s.kind === "tool_call").attributes[ATTR.GIT_COMMIT], undefined);
	}
});

test("Claude commit metadata requires a successful Bash result and a matching line", () => {
	const make = (isError: boolean, output: string, exitCode?: number) => {
		const { steps } = parseClaudeCodeEvents([
			{ type: "assistant", sessionId: "s", uuid: "a1", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "git commit -m fixture" } }] } },
			{ type: "user", uuid: "u1", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash1", is_error: isError, content: output }] }, toolUseResult: exitCode === undefined ? {} : { exitCode } },
		]);
		return find(steps, (s) => s.kind === "tool_call");
	};
	assert.equal(make(true, "[main 1a2b3c4] failed", 1).attributes[ATTR.GIT_COMMIT], undefined);
	assert.equal(make(false, "prefix [main 1a2b3c4] not anchored", 0).attributes[ATTR.GIT_COMMIT], undefined);
	assert.equal(make(false, "[main 1a2b3c4] success", 1).attributes[ATTR.GIT_COMMIT], undefined);
});

test("Claude commit metadata accepts detached and root commit headers", () => {
	for (const [line, branch, short] of [
		["[detached HEAD 1a2b3c4] detached commit", "detached HEAD", "1a2b3c4"],
		["[main (root-commit) 5d6e7f8] initial commit", "main", "5d6e7f8"],
		["[short 1a2b] short abbreviation", "short", "1a2b"],
	]) {
		const { steps } = parseClaudeCodeEvents([
			{ type: "assistant", sessionId: "s", uuid: "a1", timestamp: TS1, message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "git commit -m fixture" } }] } },
			{ type: "user", uuid: "u1", timestamp: TS2, message: { content: [{ type: "tool_result", tool_use_id: "bash1", is_error: false, content: line }] }, toolUseResult: { exitCode: 0 } },
		]);
		assert.deepEqual(find(steps, (s) => s.kind === "tool_call").attributes[ATTR.GIT_COMMIT], { branch, short });
	}
});

test("a blocked tool_result becomes an error tool_call with parsed guard name + reason", () => {
	const events = [
		{
			type: "assistant",
			sessionId: "s",
			uuid: "a1",
			timestamp: TS1,
			message: {
				content: [
					{
						type: "tool_use",
						id: "tu1",
						name: "Bash",
						input: { command: "curl x" },
					},
				],
			},
		},
		{
			type: "user",
			uuid: "u2",
			timestamp: TS2,
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu1",
						is_error: true,
						content:
							"Blocked (bash-egress): network shell command with no verifiable destination host",
					},
				],
			},
		},
	];
	const tc = find(
		parseClaudeCodeEvents(events).steps,
		(s) => s.kind === "tool_call",
	);
	assert.equal(tc.status, "error");
	assert.equal(tc.attributes[ATTR.GUARD_TRIPPED], true);
	assert.equal(tc.attributes[ATTR.GUARD_NAME], "bash-egress");
	assert.match(
		String(tc.attributes[ATTR.GUARD_REASON]),
		/network shell command/,
	);
});

test("a stale-read hint on a tool result is surfaced (Read-to-Edit race signal)", () => {
	const events = [
		{
			type: "assistant",
			sessionId: "s",
			uuid: "a1",
			timestamp: TS1,
			message: {
				content: [
					{
						type: "tool_use",
						id: "tu1",
						name: "Edit",
						input: { file_path: "/x" },
					},
				],
			},
		},
		{
			type: "user",
			uuid: "u2",
			timestamp: TS2,
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu1",
						is_error: false,
						content: "ok",
					},
				],
			},
			toolUseResult: { staleReadFileStateHint: true },
		},
	];
	const tc = find(
		parseClaudeCodeEvents(events).steps,
		(s) => s.kind === "tool_call",
	);
	assert.equal(tc.attributes[ATTR.STALE_READ], true);
});

test("Agent tool becomes an agent step enriched with subagent telemetry", () => {
	const events = [
		{
			type: "assistant",
			sessionId: "s",
			uuid: "a1",
			timestamp: TS1,
			message: {
				content: [
					{
						type: "tool_use",
						id: "tu1",
						name: "Agent",
						input: {
							subagent_type: "code-reviewer",
							name: "rev",
							model: "sonnet",
						},
					},
				],
			},
		},
		{
			type: "user",
			uuid: "u2",
			timestamp: TS2,
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu1",
						is_error: false,
						content: "ok",
					},
				],
			},
			toolUseResult: {
				agentId: "ag-9",
				resolvedModel: "claude-sonnet-4-6",
				totalTokens: 12345,
				totalDurationMs: 6000,
			},
		},
	];
	const ag = find(
		parseClaudeCodeEvents(events).steps,
		(s) => s.kind === "agent",
	);
	assert.equal(ag.attributes[ATTR.AGENT_TYPE], "code-reviewer");
	assert.equal(ag.attributes[ATTR.AGENT_SPAWNS], "ag-9");
	assert.equal(ag.attributes[ATTR.AGENT_MODEL], "claude-sonnet-4-6");
	assert.equal(ag.attributes[ATTR.AGENT_TOTAL_TOKENS], 12345);
	assert.equal(ag.attributes[ATTR.AGENT_DURATION_MS], 6000);
	assert.equal(ag.attributes[ATTR.CLAUDE_AGENT_RESULT_KIND], "completed");
});

test("Agent results distinguish completed output, launch receipts and unknown evidence", () => {
	const call = { type: "assistant", uuid: "dispatch", timestamp: TS1, message: { content: [
		{ type: "tool_use", id: "agent-call", name: "Agent", input: { subagent_type: "Explore" } },
	] } };
	const cases: { content: unknown; result?: Record<string, unknown>; error?: boolean; expected: string }[] = [
		{ content: "Synthetic inspection completed.", expected: "completed" },
		{ content: [{ type: "text", text: "Synthetic findings." }], result: { isAsync: false }, expected: "completed" },
		{ content: "Async agent launched successfully.", expected: "launched" },
		{ content: [{ type: "text", text: "Agent launched in the background." }], expected: "launched" },
		{ content: "Background agent started.", expected: "launched" },
		{ content: "The agent has been launched in the background.", expected: "launched" },
		{ content: "Synthetic receipt.", result: { isAsync: true }, expected: "launched" },
		{ content: "Synthetic receipt.", result: { status: "async_launched" }, expected: "launched" },
		{ content: "Synthetic receipt.", result: { status: "launched" }, expected: "launched" },
		{ content: undefined, expected: "unknown" },
		{ content: "  ", expected: "unknown" },
		{ content: [{ type: "image" }], expected: "unknown" },
		{ content: "Synthetic error.", error: true, expected: "unknown" },
		{ content: "Synthetic interruption.", result: { interrupted: true }, expected: "unknown" },
		{ content: "Synthetic pending result.", result: { status: "running" }, expected: "unknown" },
		{ content: "Synthetic ambiguous result.", result: { isAsync: "unknown" }, expected: "unknown" },
	];
	for (const entry of cases) {
		const result = { type: "user", uuid: "agent-result", timestamp: TS2,
			toolUseResult: { agentId: "child", ...entry.result }, message: { content: [
				{ type: "tool_result", tool_use_id: "agent-call", content: entry.content, is_error: entry.error },
			] } };
		const agent = find(parseClaudeCodeEvents([call, result]).steps, (step) => step.kind === "agent");
		assert.equal(agent.attributes[ATTR.CLAUDE_AGENT_RESULT_KIND], entry.expected, JSON.stringify(entry));
	}
	const agent = find(parseClaudeCodeEvents([call]).steps, (step) => step.kind === "agent");
	assert.equal(agent.attributes[ATTR.CLAUDE_AGENT_RESULT_KIND], "unknown");
});

test("multiple Agent result events leave completion evidence unknown", () => {
	const trace = parseClaudeCodeEvents([
		{ type: "assistant", timestamp: TS1, message: { content: [
			{ type: "tool_use", id: "agent-call", name: "Agent", input: {} },
		] } },
		...["launch", "completion"].map((uuid) => ({ type: "user", uuid, timestamp: TS2,
			toolUseResult: { agentId: "child" }, message: { content: [
				{ type: "tool_result", tool_use_id: "agent-call", content: uuid === "launch" ? "Async agent launched successfully." : "Synthetic output." },
			] } })),
	]);
	assert.equal(find(trace.steps, (step) => step.kind === "agent").attributes[ATTR.CLAUDE_AGENT_RESULT_KIND], "unknown");
});

test("a stop-hook system event with preventedContinuation becomes a deny hook step", () => {
	const events = [
		{
			type: "system",
			uuid: "sys1",
			timestamp: TS1,
			subtype: "stop_hook_summary",
			hookCount: 3,
			hookInfos: [
				{ command: "bash ~/.claude/hooks/stop-gate.sh", durationMs: 33 },
			],
			hookErrors: [],
			preventedContinuation: true,
			toolUseID: "tu1",
		},
	];
	const hk = find(
		parseClaudeCodeEvents(events).steps,
		(s) => s.kind === "hook",
	);
	assert.equal(hk.attributes[ATTR.HOOK_VERDICT], "deny");
	assert.equal(hk.attributes[ATTR.HOOK_PREVENTED], true);
	assert.equal(hk.attributes[ATTR.HOOK_EVENT], "stop_hook_summary");
	assert.equal(hk.caused_by, "tu1");
	assert.deepEqual(hk.attributes[ATTR.HOOK_COMMANDS], [
		"bash ~/.claude/hooks/stop-gate.sh",
	]);
});

test("a compaction system event becomes a compaction step with token deltas", () => {
	const events = [
		{
			type: "system",
			uuid: "sys1",
			timestamp: TS1,
			subtype: "compact_boundary",
			compactMetadata: {
				trigger: "auto",
				preTokens: 150000,
				postTokens: 40000,
			},
		},
	];
	const c = find(
		parseClaudeCodeEvents(events).steps,
		(s) => s.kind === "compaction",
	);
	assert.equal(c.attributes[ATTR.COMPACT_REASON], "auto");
	assert.equal(c.attributes[ATTR.COMPACT_BEFORE], 150000);
	assert.equal(c.attributes[ATTR.COMPACT_AFTER], 40000);
});

test("permission-mode events become mode_change steps tracking from/to", () => {
	const events = [
		{ type: "permission-mode", timestamp: TS1, permissionMode: "default" },
		{
			type: "permission-mode",
			timestamp: TS2,
			permissionMode: "bypassPermissions",
		},
	];
	const modes = parseClaudeCodeEvents(events).steps.filter(
		(s) => s.kind === "mode_change",
	);
	assert.equal(modes.length, 2);
	const second = find(
		modes,
		(s) => s.attributes[ATTR.MODE_TO] === "bypassPermissions",
	);
	assert.equal(second.attributes[ATTR.MODE_FROM], "default");
	assert.equal(second.attributes[ATTR.MODE_KIND], "permission_mode");
});

test("subagent sidechain events are tagged with subagent_id", () => {
	const main = JSON.stringify({
		type: "assistant",
		sessionId: "s",
		uuid: "a1",
		timestamp: TS1,
		message: { content: [{ type: "text", text: "spawning" }] },
	});
	const sub = JSON.stringify({
		type: "assistant",
		isSidechain: true,
		agentId: "ag-7",
		uuid: "sa1",
		timestamp: TS2,
		message: {
			content: [{ type: "tool_use", id: "stu1", name: "Grep", input: {} }],
		},
	});
	const trace = parseClaudeCodeTranscript(main + "\n", [sub + "\n"]);
	const subStep = find(trace.steps, (s) => s.subagent_id === "ag-7");
	assert.equal(subStep.subagent_id, "ag-7");
});

test("parseClaudeCodeTranscript reports unparseable-line counts across main + sidechains", () => {
	const valid = JSON.stringify({
		type: "assistant",
		sessionId: "s",
		uuid: "a",
		timestamp: TS1,
		message: { role: "assistant", content: [{ type: "text", text: "x" }] },
	});
	const trace = parseClaudeCodeTranscript(`${valid}\n{ broken json\n`, [
		"totally not json\n",
	]);
	assert.equal(trace.malformed_lines, 2);
	assert.ok(trace.steps.length > 0, "valid lines still parse");
});

test("noise event types produce no steps", () => {
	const events = [
		{ type: "attachment", timestamp: TS1 },
		{ type: "file-history-snapshot", timestamp: TS1 },
		{ type: "pr-link", timestamp: TS1 },
		{ type: "ai-title", timestamp: TS1 },
	];
	assert.equal(parseClaudeCodeEvents(events).steps.length, 0);
});

test("unsupported Claude API errors and incomplete-flow records are counted", () => {
	const trace = parseClaudeCodeTranscript([
		{ type: "system", subtype: "api_error", uuid: "api-error", timestamp: TS1 },
		{ type: "data-flow-incomplete", uuid: "flow-gap", timestamp: TS2 },
	].map((event) => JSON.stringify(event)).join("\n"));
	assert.equal(trace.unsupported_records, 1);
	assert.equal(trace.incomplete_records, 1);
});

test("does not crash on events with missing or non-object message", () => {
	const events = [
		{ type: "assistant", timestamp: TS1, message: "weird-string" },
		{ type: "user", timestamp: TS1, message: null },
		{ type: "assistant", timestamp: TS1 },
	];
	assert.doesNotThrow(() => parseClaudeCodeEvents(events));
});
