import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseTranscript } from "../parse.ts";
import { toWaitTrace } from "./export.ts";
import { ATTR } from "../types.ts";

test("synthetic session exports a contained wait trace", () => {
	const { harness, trace } = parseTranscript(readFileSync("fixtures/wait-anatomy-session.jsonl", "utf8"));
	assert.equal(harness, "claude-code");
	assert.ok(trace.steps.filter((step) => step.kind === "llm").length >= 2);
	assert.equal(trace.steps.find((step) => step.step_id === "nested-1")?.parent_step_id, "prompt");
	assert.equal(trace.steps.find((step) => step.step_id === "nested-1")?.subagent_id, "synthetic-agent");
	assert.equal(trace.steps.find((step) => step.step_id === "agent-1")?.attributes[ATTR.AGENT_SPAWNS], "synthetic-agent");
	const { waitTrace } = toWaitTrace(trace);
	const spans = new Map(waitTrace.spans.map((span) => [span.id, span]));
	assert.equal(spans.size, waitTrace.spans.length);
	for (const id of ["read-1", "search-1", "nested-1"]) assert.equal(spans.get(id)?.category, "tool_wait");
	assert.equal(spans.get("agent-1")?.category, "nested_call");
	assert.equal(spans.get("nested-1")?.parent_id, "agent-1");
	const read = spans.get("read-1")!, search = spans.get("search-1")!, nested = spans.get("nested-1")!, agent = spans.get("agent-1")!;
	assert.ok(read.start_ns < search.end_ns && search.start_ns < read.end_ns);
	assert.equal(new Set([read, search, nested].map((span) => span.end_ns - span.start_ns)).size, 3);
	assert.ok(agent.end_ns < waitTrace.window_ns[1]);
	const [start, end] = waitTrace.window_ns;
	assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start);
	for (const span of waitTrace.spans) {
		assert.ok(Number.isSafeInteger(span.start_ns) && Number.isSafeInteger(span.end_ns));
		assert.ok(start <= span.start_ns && span.start_ns <= span.end_ns && span.end_ns <= end);
		if (span.parent_id !== null) {
			const parent = spans.get(span.parent_id);
			assert.ok(parent);
			assert.ok(parent.start_ns <= span.start_ns && span.end_ns <= parent.end_ns);
		}
	}
});

test("zero-length session is noted and skips the engine", () => {
	const trace = parseTranscript(readFileSync("fixtures/render-smoke.jsonl", "utf8")).trace;
	assert.ok(toWaitTrace(trace).notes.some((note) => note.includes("window is zero-length")));
	const temp = mkdtempSync(join(tmpdir(), "wait-zero-"));
	try {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/wait-anatomy.ts", "fixtures/render-smoke.jsonl", "--out", join(temp, "output")], { encoding: "utf8", env: { ...process.env, TRACEGLASS_ROOT: join(temp, "nonexistent-engine") } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "No measurable time in this session (window is zero-length); nothing to analyze.");
	} finally { rmSync(temp, { recursive: true, force: true }); }
});
