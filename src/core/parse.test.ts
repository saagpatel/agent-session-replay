import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

test("a Claude permission-mode record alone identifies the transcript", () => {
	for (const record of [{ type: "permission-mode", permissionMode: "plan" }, { type: "mode", mode: "plan" }]) {
		const event = { ...record, uuid: "mode-a", sessionId: "example" };
		const { harness, trace } = parseTranscript(JSON.stringify(event));
		assert.equal(harness, "claude-code");
		assert.equal(trace.steps[0]?.kind, "mode_change");
	}
});

test("a standalone incomplete Claude capture marker is recognized", () => {
	const marker = JSON.stringify({
		type: "data-flow-incomplete",
		sessionId: "synthetic-session",
		uuid: "synthetic-gap",
	});
	const parsed = parseTranscript(marker);
	assert.equal(parsed.harness, "claude-code");
	assert.equal(parsed.trace.incomplete_records, 1);
});

test("an incomplete marker requires non-empty string session identity", () => {
	for (const marker of [
		{ type: "data-flow-incomplete", sessionId: "synthetic-session" },
		{ type: "data-flow-incomplete", uuid: "synthetic-gap" },
		{ type: "data-flow-incomplete", sessionId: "", uuid: "synthetic-gap" },
		{ type: "data-flow-incomplete", sessionId: 7, uuid: "synthetic-gap" },
		{ type: "data-flow-incomplete", sessionId: "synthetic-session", uuid: " " },
		{ type: "data-flow-incomplete", sessionId: "synthetic-session", uuid: 7 },
	]) {
		assert.throws(() => parseTranscript(JSON.stringify(marker)), /unsupported.*Claude Code or Codex/i);
	}
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

const unsupportedInputs = [
	'{"role":"assistant","message":{"content":[]}}\n{"type":"turn_ended"}',
	'{"type":"PLANNER_RESPONSE","content":"An example plan."}',
];

test("unsupported transcripts have no Claude trace", () => {
	for (const input of unsupportedInputs) {
		assert.throws(() => parseTranscript(input), /unsupported.*Claude Code or Codex/i);
	}
});

test("metadata preceding the first identifiable event does not hide a supported transcript", () => {
	const preamble = Array<string>(30).fill('{"type":"file-history-snapshot"}');
	assert.equal(parseTranscript([...preamble, ccLine].join("\n")).harness, "claude-code");
});

test("the smoke CLI reports unsupported input before computing findings", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "replay-smoke-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "example.jsonl");
	const cli = fileURLToPath(new URL("../../scripts/parse-real.ts", import.meta.url));
	for (const input of unsupportedInputs) {
		writeFileSync(path, input);
		const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
		assert.match(result.stderr, /unsupported.*Claude Code or Codex/i);
		assert.equal(result.status, 1);
		assert.doesNotMatch(result.stdout, /ranked findings|clean run/i);
	}
});
