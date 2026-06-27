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

test("noise event types produce no steps", () => {
	const events = [
		{ type: "attachment", timestamp: TS1 },
		{ type: "file-history-snapshot", timestamp: TS1 },
		{ type: "pr-link", timestamp: TS1 },
		{ type: "ai-title", timestamp: TS1 },
	];
	assert.equal(parseClaudeCodeEvents(events).steps.length, 0);
});

test("does not crash on events with missing or non-object message", () => {
	const events = [
		{ type: "assistant", timestamp: TS1, message: "weird-string" },
		{ type: "user", timestamp: TS1, message: null },
		{ type: "assistant", timestamp: TS1 },
	];
	assert.doesNotThrow(() => parseClaudeCodeEvents(events));
});
