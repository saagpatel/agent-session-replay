import assert from "node:assert/strict";
import { test } from "node:test";

import { detectHarness, parseTranscript } from "./parse.ts";

const ccLine = JSON.stringify({
	type: "assistant",
	sessionId: "abc",
	uuid: "u1",
	timestamp: "2026-06-20T00:00:00.000Z",
	message: { role: "assistant", model: "claude-opus-4-8", content: [] },
});
const codexLine = JSON.stringify({
	timestamp: "2026-02-17T11:16:48.046Z",
	type: "session_meta",
	payload: { id: "run-1", cwd: "/x", cli_version: "0.100.0" },
});

test("detectHarness identifies a Claude Code transcript", () => {
	assert.equal(detectHarness(ccLine), "claude-code");
});

test("detectHarness identifies a Codex rollout", () => {
	assert.equal(detectHarness(codexLine), "codex");
});

test("detectHarness returns unknown for empty or unrecognizable input", () => {
	assert.equal(detectHarness(""), "unknown");
	assert.equal(detectHarness('{"foo":"bar"}'), "unknown");
});

test("parseTranscript routes to the matching parser by sniffed harness", () => {
	const cc = parseTranscript(ccLine);
	assert.equal(cc.harness, "claude-code");
	assert.equal(cc.trace.run.harness.name, "claude-code");

	const codex = parseTranscript(codexLine);
	assert.equal(codex.harness, "codex");
	assert.equal(codex.trace.run.harness.name, "codex");
	assert.equal(codex.trace.run.run_id, "run-1");
});
