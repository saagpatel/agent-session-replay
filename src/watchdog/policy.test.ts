import assert from "node:assert/strict";
import { test } from "node:test";

import type { Finding } from "../core/detect/types.ts";
import { buildEvent, liveVerdict } from "./policy.ts";
import type { SessionFile } from "./types.ts";

function finding(over: Partial<Finding> = {}): Finding {
	return {
		id: "grind_loop",
		kind: "grind_loop",
		severity: "warning",
		title: "Grind loop: 150 consecutive calls cycling bash / write_stdin",
		detail: "detail text",
		step_ids: [],
		score: 150,
		...over,
	};
}

function session(over: Partial<SessionFile> = {}): SessionFile {
	return {
		harness: "claude-code",
		path: "/home/x/.claude/projects/-p/abc.jsonl",
		subagentPaths: [],
		mtimeMs: 0,
		sizeBytes: 100,
		...over,
	};
}

const STALL_QUIET_MS = 600_000;

test("incomplete_run never alerts live — every running session is incomplete", () => {
	const f = finding({ id: "incomplete_run", kind: "incomplete_run" });
	assert.equal(liveVerdict(f, 0, STALL_QUIET_MS), "never");
	assert.equal(liveVerdict(f, 10 * STALL_QUIET_MS, STALL_QUIET_MS), "never");
});

test("silent_stall holds until the session has been quiet long enough", () => {
	const f = finding({ id: "silent_stall", kind: "silent_stall" });
	assert.equal(liveVerdict(f, 30_000, STALL_QUIET_MS), "hold");
	assert.equal(liveVerdict(f, STALL_QUIET_MS, STALL_QUIET_MS), "alert");
});

test("ordinary findings alert immediately, even while the session writes", () => {
	assert.equal(liveVerdict(finding(), 0, STALL_QUIET_MS), "alert");
});

test("buildEvent maps severity to hub levels and harness to source", () => {
	const cc = buildEvent(finding({ severity: "critical" }), session(), null);
	assert.equal(cc.source, "cc");
	assert.equal(cc.level, "urgent");
	const codex = buildEvent(
		finding({ severity: "info" }),
		session({ harness: "codex", path: "/x/rollout-1.jsonl" }),
		null,
	);
	assert.equal(codex.source, "codex");
	assert.equal(codex.level, "info");
	assert.equal(buildEvent(finding(), session(), null).level, "normal");
});

test("buildEvent produces hub-safe text: single-line, length-capped", () => {
	const f = finding({
		title: "line one\nline two\ttabbed",
		detail: "x".repeat(3000),
	});
	const e = buildEvent(f, session(), "/Users/x/Projects/bridge-db");
	assert.ok(!/[\n\r\t]/.test(e.title), "title must be single-line");
	assert.ok(!/[\n\r\t]/.test(e.body), "body must be single-line");
	assert.ok(e.title.length <= 200);
	assert.ok(e.body.length <= 2000);
	assert.equal(e.project, "bridge-db");
	assert.equal(e.session_label, "abc.jsonl");
	assert.equal(e.intent, "needs_attention");
	assert.equal(e.context["detector"], "grind_loop");
	assert.equal(e.context["transcript_path"], session().path);
});

test("buildEvent omits project when the trace has no cwd", () => {
	const e = buildEvent(finding(), session(), undefined);
	assert.ok(!("project" in e));
});
