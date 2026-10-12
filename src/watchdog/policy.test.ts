import assert from "node:assert/strict";
import { test } from "node:test";

import type { Finding } from "../core/detect/types.ts";
import { ALERTABLE_DETECTORS, buildEvent, eventIdFor, liveVerdict } from "./policy.ts";
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

test("grind_loop alerts immediately, even while the session writes", () => {
	assert.equal(liveVerdict(finding(), 0, STALL_QUIET_MS), "alert");
});

test("buildEvent maps severity to adapter levels and harness to source", () => {
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

test("buildEvent produces adapter-safe text: single-line, length-capped", () => {
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

test("project and session_label are capped to the adapter's field limits", () => {
	// Keep bounded fields deterministic across local adapter replays.
	const longName = "x".repeat(300);
	const e = buildEvent(
		finding(),
		session({ path: `/sessions/${longName}.jsonl` }),
		`/Users/x/Projects/${longName}`,
	);
	assert.ok((e.project ?? "").length <= 100);
	assert.ok((e.session_label ?? "").length <= 200);
});

test("only notifier-approved stuck-agent detectors may alert", () => {
	assert.deepEqual([...ALERTABLE_DETECTORS].sort(), [
		"grind_loop", "silent_stall", "transcript_budget_exceeded",
	]);
	for (const kind of ["grind_loop", "transcript_budget_exceeded"]) {
		assert.equal(liveVerdict(finding({ id: kind, kind }), 0, STALL_QUIET_MS), "alert");
	}
	for (const kind of [
		"guard_trip_cluster", "tool_error_spike", "compaction_thrash",
		"subagent_cost_runaway", "incomplete_run", "future_detector",
	]) {
		assert.equal(liveVerdict(finding({ id: kind, kind }), 0, STALL_QUIET_MS), "never");
		assert.equal(liveVerdict(finding({ id: kind, kind }), 10 * STALL_QUIET_MS, STALL_QUIET_MS), "never");
	}
});

test("adapter event identity is stable and binds session, finding and severity", () => {
	const first = buildEvent(finding(), session(), null);
	assert.equal(first.event_id, eventIdFor(session().path, "grind_loop@warning"));
	assert.match(first.event_id ?? "", /^agent-watchdog:[a-f0-9]{64}$/);
	assert.equal(buildEvent(finding(), session(), null).event_id, first.event_id);
	assert.notEqual(buildEvent(finding({ severity: "critical" }), session(), null).event_id, first.event_id);
	assert.notEqual(buildEvent(finding({ id: "other" }), session(), null).event_id, first.event_id);
	assert.notEqual(buildEvent(finding(), session({ path: "/x/other.jsonl" }), null).event_id, first.event_id);
});

test("adapter dedupe groups separate warning and critical, sessions and finding kinds", () => {
	const warning = buildEvent(finding(), session(), null);
	const critical = buildEvent(finding({ severity: "critical" }), session(), null);
	assert.notEqual(warning.dedupe_key, critical.dedupe_key,
		"the 15-minute policy group must not swallow an escalation");
	assert.equal(buildEvent(finding({ score: 400 }), session(), null).dedupe_key, warning.dedupe_key);
	assert.notEqual(buildEvent(finding(), session({ path: "/other/session.jsonl" }), null).dedupe_key, warning.dedupe_key);
	assert.notEqual(buildEvent(finding({ kind: "silent_stall" }), session(), null).dedupe_key, warning.dedupe_key);
	const long = buildEvent(finding({ kind: "x".repeat(1000) }), session({ path: "/" + "s".repeat(1000) }), null);
	assert.ok(long.dedupe_key && long.dedupe_key.length <= 200);
});
