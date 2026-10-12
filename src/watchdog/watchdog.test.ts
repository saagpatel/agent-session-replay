import assert from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { detect } from "../core/detect/engine.ts";
import { parseClaudeCodeTranscript } from "../core/parsers/claude-code.ts";
import { buildEvent, eventIdFor } from "./policy.ts";
import {
	hasAlerted, loadState, MAX_PENDING_PAYLOAD_BYTES, MAX_RETAINED_PAYLOAD_BYTES,
	pendingPayloadFor, retainPendingPayload, retainedPayloadStats, saveState,
	STATE_MAX_AGE_MS, type WatchdogState,
} from "./state.ts";
import type { NotificationEvent, WatchdogConfig } from "./types.ts";
import { tick } from "./watchdog.ts";

/* ---------- fixture transcripts ---------- */

let clock = 0;
function ts(): string {
	clock += 1;
	const m = String(Math.floor(clock / 60) % 60).padStart(2, "0");
	const s = String(clock % 60).padStart(2, "0");
	return `2026-07-10T10:${m}:${s}.000Z`;
}

/** CC transcript whose assistant grinds two tools long enough to trip grind_loop. */
function ccGrindTranscript(calls: number): string {
	const lines: string[] = [];
	for (let i = 0; i < calls; i++) {
		lines.push(
			JSON.stringify({
				type: "assistant",
				sessionId: "sess-grind",
				uuid: `u${i}`,
				timestamp: ts(),
				cwd: "/Users/x/Projects/bridge-db",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: `tu${i}`,
							name: i % 2 === 0 ? "Bash" : "Write",
							input: {},
						},
					],
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Codex rollout that completes without a single tool call: the silent no-op. */
function codexStallTranscript(): string {
	const evs = [
		{
			timestamp: ts(),
			type: "session_meta",
			payload: { id: "run-stall", cwd: "/w/p", cli_version: "0.142.0" },
		},
		{
			timestamp: ts(),
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "All done, looks great!" }],
			},
		},
		{
			timestamp: ts(),
			type: "event_msg",
			payload: { type: "task_complete", last_agent_message: "done" },
		},
	];
	return `${evs.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/* ---------- harness ---------- */

interface Fixture {
	config: WatchdogConfig;
	claudeRoot: string;
	codexRoot: string;
}

function fixture(over: Partial<WatchdogConfig> = {}, failFirst = false): Fixture {
	const base = mkdtempSync(join(tmpdir(), "watchdog-tick-"));
	const claudeRoot = join(base, "projects");
	const codexRoot = join(base, "sessions");
	mkdirSync(claudeRoot, { recursive: true });
	mkdirSync(codexRoot, { recursive: true });
	const adapterPath = join(base, "local_notification_adapter.cjs");
	writeFileSync(adapterPath, `#!/usr/bin/env node
let text = "";
process.stdin.on("data", (chunk) => text += chunk).on("end", () => {
  const payload = JSON.parse(text);
  const store = process.argv[3];
  const counter = store + ".count";
  const fs = require("node:fs");
  const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : "0") + 1;
  fs.writeFileSync(counter, String(count));
  if (store.includes("fail-first") && count === 1) {
    console.error(JSON.stringify({state: "rejected", error: "fixture failure"}));
    process.exitCode = 2;
    return;
  }
  fs.appendFileSync(store + ".events", JSON.stringify(payload) + "\\n");
  console.log(JSON.stringify({state: "accepted_by_os", stable_event_id: payload.event_id}));
});
`, { mode: 0o700 });
	chmodSync(adapterPath, 0o700);
	return {
		claudeRoot,
		codexRoot,
		config: {
			claudeProjectsDir: claudeRoot,
			codexSessionsDir: codexRoot,
			localAdapterPath: adapterPath,
			localReceiptStore: join(base, failFirst ? "fail-first-receipts.sqlite3" : "receipts.sqlite3"),
			windowMinutes: 30,
			stallQuietSeconds: 600,
			maxSessionBytes: 64 * 1024 * 1024,
			statePath: join(base, "state.json"),
			dryRun: false,
			...over,
		},
	};
}

function postedEvents(config: WatchdogConfig): NotificationEvent[] {
	try {
		return readFileSync(config.localReceiptStore + ".events", "utf8")
			.trim().split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as NotificationEvent);
	} catch {
		return [];
	}
}

function writeCcSession(claudeRoot: string, text: string): string {
	const proj = join(claudeRoot, "-Users-x-Projects-bridge-db");
	mkdirSync(proj, { recursive: true });
	const path = join(proj, "sess-grind.jsonl");
	writeFileSync(path, text);
	return path;
}

function writeCodexSession(codexRoot: string, text: string): string {
	const day = join(codexRoot, "2026", "07", "10");
	mkdirSync(day, { recursive: true });
	const path = join(day, "rollout-stall.jsonl");
	writeFileSync(path, text);
	return path;
}

/* ---------- tests ---------- */

test("a grinding CC session posts one grind_loop alert; the next tick skips the unchanged file", async () => {
	const { config, claudeRoot } = fixture();
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));

	const first = await tick(config, Date.now());
	assert.equal(first.alertsPosted, 1);
	assert.equal(first.acceptedEventIds.length, 1);
	const event = postedEvents(config)[0];
	if (!event) throw new Error("expected a posted event");
	assert.equal(event.source, "cc");
	assert.equal(event.level, "normal");
	assert.equal(event.context["detector"], "grind_loop");
	assert.equal(event.event_id, first.acceptedEventIds[0]);
	assert.equal(event.project, "bridge-db");
	assert.ok(event.title.length <= 200);

	// Unchanged mtime + nothing pending -> the session is not even re-parsed.
	const second = await tick(config, Date.now());
	assert.equal(second.alertsPosted, 0);
	assert.deepEqual(second.acceptedEventIds, []);
	assert.equal(second.skippedUnchanged, 1);
	assert.equal(second.scannedSessions, 0);
	assert.equal(postedEvents(config).length, 1);

	// A new write re-opens the session, and dedupe (not skip) suppresses the
	// already-alerted finding.
	appendFileSync(path, ccGrindTranscript(2));
	const third = await tick(config, Date.now());
	assert.equal(third.scannedSessions, 1);
	assert.equal(third.alertsPosted, 0);
	assert.ok(third.alertsDeduped >= 1);
	assert.equal(postedEvents(config).length, 1);
});

test("incomplete_run on a live session is suppressed entirely", async () => {
	const { config, claudeRoot } = fixture();
	// Small clean session: parses fine, live (just written), no clean end_turn.
	writeCcSession(claudeRoot, ccGrindTranscript(5));
	const report = await tick(config, Date.now());
	assert.equal(report.alertsPosted, 0);
	assert.equal(postedEvents(config).length, 0);
});

test("non-approved findings remain detected and counted without adapter attempts", async () => {
	const { config, claudeRoot } = fixture();
	const lines = ccGrindTranscript(5).trim().split("\n");
	const results = Array.from({ length: 5 }, (_, i) => JSON.stringify({
		type: "user",
		uuid: `result-${i}`,
		timestamp: ts(),
		message: { content: [{
			type: "tool_result",
			tool_use_id: `tu${i}`,
			is_error: true,
			content: "Blocked (bash-egress): fixture destination denied",
		}] },
	}));
	const transcript = [...lines, ...results].join("\n") + "\n";
	const findings = detect(parseClaudeCodeTranscript(transcript));
	assert.ok(findings.some((finding) => finding.kind === "guard_trip_cluster"));
	writeCcSession(claudeRoot, transcript);
	const report = await tick(config, Date.now());
	assert.equal(report.findings, findings.length);
	assert.equal(report.alertsPosted, 0);
	assert.equal(report.postFailures, 0);
	assert.equal(postedEvents(config).length, 0);
	const repeat = await tick(config, Date.now());
	assert.equal(repeat.skippedUnchanged, 1);
});

test("a settled codex no-op run posts a silent_stall; a fresh one is held", async () => {
	const fresh = fixture();
	writeCodexSession(fresh.codexRoot, codexStallTranscript());

	// Fresh: written moments ago -> held, not posted.
	const held = await tick(fresh.config, Date.now());
	assert.equal(held.alertsPosted, 0);
	assert.ok(held.alertsHeld >= 1);

	// Settled: pretend 11 minutes elapsed with no further writes.
	const settled = await tick(fresh.config, Date.now() + 11 * 60 * 1000);
	assert.equal(settled.alertsPosted, 1);
	assert.equal(settled.acceptedEventIds.length, 1);
	const event = postedEvents(fresh.config)[0];
	if (!event) throw new Error("expected a posted event");
	assert.equal(event.source, "codex");
	assert.equal(event.context["detector"], "silent_stall");
});

test("a failed adapter result is retried on the next tick (nothing marked alerted)", async () => {
	const { config, claudeRoot } = fixture({}, true);
	writeCcSession(claudeRoot, ccGrindTranscript(320));

	const first = await tick(config, Date.now());
	assert.equal(first.postFailures, 1);
	assert.equal(first.alertsPosted, 0);

	const second = await tick(config, Date.now());
	assert.equal(second.alertsPosted, 1);
	assert.equal(second.acceptedEventIds.length, 1);
	assert.equal(postedEvents(config).length, 1);
});

/** Store the attempt before losing the first receipt; enforce notifier hash equality. */
function loseFirstReceipt(t: TestContext, config: WatchdogConfig, failAcknowledgementWrite = false): void {
	t.after(() => rmSync(join(config.statePath, ".."), { recursive: true, force: true }));
	writeFileSync(config.localAdapterPath, `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
let text = "";
process.stdin.on("data", chunk => text += chunk).on("end", () => {
  const event = JSON.parse(text);
  const store = process.argv[3];
  const statePath = ${JSON.stringify(config.statePath)};
  const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const retained = saved.sessions[event.context.transcript_path].pendingPayloads;
  // Pre-send durability is part of the contract, including a daemon restart.
  if (!Object.values(retained).includes(text)) throw new Error("payload not saved before send");
  fs.appendFileSync(store + ".attempts", JSON.stringify(text) + "\\n");
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  if (!fs.existsSync(store)) {
    fs.writeFileSync(store, JSON.stringify({event_id: event.event_id, payload_hash: hash}));
    // The adapter stored the event, but the watchdog cannot acknowledge it.
    if (${failAcknowledgementWrite}) {
      fs.mkdirSync(statePath + "." + process.ppid + ".tmp");
      console.log(JSON.stringify({state: "accepted_by_os", stable_event_id: event.event_id}));
    } else {
      console.log("lost receipt");
    }
    return;
  }
  const prior = JSON.parse(fs.readFileSync(store, "utf8"));
  if (prior.event_id !== event.event_id || prior.payload_hash !== hash) {
    console.error(JSON.stringify({state: "rejected", error: "conflicts with prior attempt"}));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({state: "deduped", stable_event_id: event.event_id}));
});
`);
}

function attemptedPayloads(config: WatchdogConfig): string[] {
	return readFileSync(config.localReceiptStore + ".attempts", "utf8")
		.trim().split("\n").map(line => JSON.parse(line) as string);
}

test("lost adapter receipt replays identical JSON bytes after transcript growth and drops acknowledged payload", async (t) => {
	const { config, claudeRoot } = fixture();
	loseFirstReceipt(t, config);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));
	const key = "grind_loop@warning";
	const first = await tick(config, Date.now());
	assert.equal(first.postFailures, 1);
	assert.equal(first.alertsPosted, 0);
	const original = attemptedPayloads(config)[0]!;
	assert.equal(pendingPayloadFor(loadState(config.statePath), path, key), original);

	appendFileSync(path, ccGrindTranscript(2));
	const trace = parseClaudeCodeTranscript(readFileSync(path, "utf8"));
	const finding = detect(trace).find(f => f.kind === "grind_loop")!;
	const rebuilt = buildEvent(finding, {
		harness: "claude-code", path, subagentPaths: [], mtimeMs: 0, sizeBytes: 0,
	}, trace.run.workspace?.cwd);
	assert.notEqual(rebuilt.event_id, JSON.parse(original).event_id, "changed content gets its own ID");
	assert.notEqual(JSON.stringify(rebuilt), original, "fixture must change the live payload");

	const second = await tick(config, Date.now());
	assert.equal(second.alertsPosted, 1);
	assert.equal(second.postFailures, 0);
	assert.deepEqual(attemptedPayloads(config), [original, original]);
	assert.deepEqual(second.acceptedEventIds, [JSON.parse(original).event_id]);
	assert.equal(loadState(config.statePath).sessions[path]?.pendingPayloads, undefined);
	assert.equal((await tick(config, Date.now())).skippedUnchanged, 1);
});

test("a finding that disappears and returns replays its original payload", async (t) => {
	const { config, claudeRoot } = fixture();
	loseFirstReceipt(t, config);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));
	assert.equal((await tick(config, Date.now())).postFailures, 1);
	const original = attemptedPayloads(config)[0]!;
	writeFileSync(path, ccGrindTranscript(5));
	const resolved = await tick(config, Date.now());
	assert.equal(resolved.alertsPosted, 0);
	assert.equal(resolved.postFailures, 0);
	assert.equal(attemptedPayloads(config).length, 1);
	assert.equal(pendingPayloadFor(loadState(config.statePath), path, "grind_loop@warning"), original,
		"an unacknowledged payload survives its finding disappearing");
	writeFileSync(path, ccGrindTranscript(322));
	const returned = await tick(config, Date.now());
	assert.equal(returned.alertsPosted, 1);
	assert.equal(returned.postFailures, 0);
	assert.deepEqual(attemptedPayloads(config), [original, original]);
	assert.equal(loadState(config.statePath).sessions[path]?.pendingPayloads, undefined);
});

test("failed acknowledgement state write leaves the pre-send payload durable for retry", async (t) => {
	const { config, claudeRoot } = fixture();
	loseFirstReceipt(t, config, true);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));
	await assert.rejects(tick(config, Date.now()));
	const original = attemptedPayloads(config)[0]!;
	assert.equal(pendingPayloadFor(loadState(config.statePath), path, "grind_loop@warning"), original);
	rmSync(`${config.statePath}.${process.pid}.tmp`, { recursive: true });
	appendFileSync(path, ccGrindTranscript(2));
	const retry = await tick(config, Date.now());
	assert.equal(retry.alertsPosted, 1);
	assert.equal(retry.postFailures, 0);
	assert.deepEqual(attemptedPayloads(config), [original, original]);
	assert.equal(loadState(config.statePath).sessions[path]?.pendingPayloads, undefined);
});

test("a budget alert retries its retained payload when the configured ceiling changes", async (t) => {
	const { config, claudeRoot } = fixture({ maxSessionBytes: 32 });
	loseFirstReceipt(t, config);
	const path = writeCcSession(claudeRoot, JSON.stringify({ body: "x".repeat(128) }));
	assert.equal((await tick(config, Date.now())).postFailures, 1);
	const original = attemptedPayloads(config)[0]!;
	const retry = await tick({ ...config, maxSessionBytes: 48 }, Date.now());
	assert.equal(retry.alertsPosted, 1);
	assert.equal(retry.postFailures, 0);
	assert.deepEqual(attemptedPayloads(config), [original, original]);
	assert.equal(loadState(config.statePath).sessions[path]?.pendingPayloads, undefined);
	assert.equal((await tick(config, Date.now())).skippedOversize, 1);
});

test("a failed pre-send state write never invokes the adapter", async (t) => {
	const { config, claudeRoot } = fixture();
	t.after(() => rmSync(join(config.statePath, ".."), { recursive: true, force: true }));
	writeCcSession(claudeRoot, ccGrindTranscript(320));
	// A directory at the state path makes the atomic rename fail deterministically.
	mkdirSync(config.statePath);
	await assert.rejects(tick(config, Date.now()));
	assert.deepEqual(postedEvents(config), []);
	assert.equal(existsSync(config.localReceiptStore + ".count"), false);
});

test("dry-run logs and dedupes but never invokes the adapter", async () => {
	const { config, claudeRoot } = fixture({
		dryRun: true,
	});
	writeCcSession(claudeRoot, ccGrindTranscript(320));

	const report = await tick(config, Date.now());
	assert.equal(report.alertsPosted, 1);
	assert.deepEqual(report.acceptedEventIds, []);
	assert.equal(report.postFailures, 0);
	assert.equal(postedEvents(config).length, 0);
});

test("dry-run leaves a live unacknowledged payload untouched", async (t) => {
	const { config, claudeRoot } = fixture();
	loseFirstReceipt(t, config);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));
	assert.equal((await tick(config, Date.now())).postFailures, 1);
	const original = attemptedPayloads(config)[0]!;
	appendFileSync(path, ccGrindTranscript(2));
	const dry = await tick({ ...config, dryRun: true }, Date.now());
	assert.equal(dry.alertsPosted, 0);
	assert.equal(pendingPayloadFor(loadState(config.statePath), path, "grind_loop@warning"), original);
	const live = await tick(config, Date.now());
	assert.equal(live.alertsPosted, 1);
	assert.deepEqual(attemptedPayloads(config), [original, original]);
});

test("oversize transcripts scan a bounded recent JSONL window", async () => {
	const transcript = ccGrindTranscript(800);
	const { config, claudeRoot } = fixture({
		maxSessionBytes: Math.floor(Buffer.byteLength(transcript) / 2),
	});
	writeCcSession(claudeRoot, transcript);
	const report = await tick(config, Date.now());
	assert.equal(report.skippedOversize, 0);
	assert.equal(report.scannedSessions, 1);
	assert.equal(report.windowedSessions, 1);
	assert.equal(report.alertsPosted, 1);
	assert.equal(report.acceptedEventIds.length, 1);
	assert.equal(postedEvents(config)[0]?.context["detector"], "grind_loop");
	const repeat = await tick(config, Date.now());
	assert.equal(repeat.alertsPosted, 0);
	assert.equal(repeat.skippedUnchanged, 1);
});

test("a giant JSONL event with no bounded line boundary still fails closed", async () => {
	const { config, claudeRoot } = fixture({ maxSessionBytes: 32 });
	writeCcSession(claudeRoot, JSON.stringify({ body: "x".repeat(128) }));
	const report = await tick(config, Date.now());
	assert.equal(report.skippedOversize, 1);
	assert.equal(report.windowedSessions, 0);
	assert.equal(report.alertsPosted, 1);
	assert.equal(report.acceptedEventIds.length, 1);
	assert.equal(postedEvents(config)[0]?.level, "urgent");
	assert.equal(postedEvents(config)[0]?.context["detector"], "transcript_budget_exceeded");
	assert.equal(postedEvents(config)[0]?.event_id, report.acceptedEventIds[0]);
});

function cleanupFixture(t: TestContext, config: WatchdogConfig): void {
	t.after(() => rmSync(join(config.statePath, ".."), { recursive: true, force: true }));
}

/** A bounded protocol fixture; status never reads or binds a new event. */
function outcomeAdapter(
	config: WatchdogConfig, postState = "delivered",
	statuses: Record<string, string> = {}, defaultStatus = "not_found",
): void {
	writeFileSync(config.localAdapterPath, `#!/usr/bin/env node
const fs = require("node:fs");
const store = process.argv[3];
if (process.argv[4] === "--status") {
  const id = process.argv[5];
  fs.appendFileSync(store + ".queries", id + "\\n");
  const state = ${JSON.stringify(statuses)}[id] ?? ${JSON.stringify(defaultStatus)};
  if (state === "lookup_failed") {
    console.error(JSON.stringify({state: "rejected", error: "stable event id was reused with a changed payload"}));
    process.exitCode = 2;
  } else if (state === "invalid") {
    console.log("not a receipt");
  } else {
    console.log(JSON.stringify({state: state === "wrong_id" ? "not_found" : state,
      stable_event_id: state === "wrong_id" ? "wrong-id" : id}));
  }
} else {
  let text = "";
  process.stdin.on("data", chunk => text += chunk).on("end", () => {
    const event = JSON.parse(text);
    fs.appendFileSync(store + ".attempts", JSON.stringify(text) + "\\n");
    if (${JSON.stringify(postState)} === "changed_payload") {
      console.error(JSON.stringify({state: "rejected", error: "stable event id was reused with a changed payload"}));
      process.exitCode = 2;
    } else {
      console.log(JSON.stringify({state: ${JSON.stringify(postState)}, stable_event_id: event.event_id}));
    }
  });
}
`);
}

function retainedEvent(path: string, key = "grind_loop@warning", body = "original"): string {
	return JSON.stringify({
		event_id: eventIdFor(path, key), source: "cc", level: "normal",
		title: "fixture", body, intent: "needs_attention",
		context: { detector: key.split("@")[0], transcript_path: path },
	});
}

for (const oversize of [false, true]) {
	for (const state of ["failed", "unknown", "abandoned_no_retry", "changed_payload"]) {
		test(`${oversize ? "budget" : "finding"} alert releases terminal ${state} payload and never retries`, async (t) => {
			const { config, claudeRoot } = fixture(oversize ? { maxSessionBytes: 32 } : {});
			cleanupFixture(t, config);
			const errors = t.mock.method(console, "error", () => {});
			outcomeAdapter(config, state);
			const path = writeCcSession(claudeRoot, oversize
				? JSON.stringify({ body: "x".repeat(128) }) : ccGrindTranscript(320));
			const key = oversize ? "transcript_budget_exceeded@critical" : "grind_loop@warning";
			const first = await tick(config, Date.now());
			assert.equal(first.terminalFailures, 1);
			assert.equal(first.postFailures, 0);
			assert.equal(first.alertsPosted, 0);
			assert.equal(first.retainedPayloads, 0);
			assert.equal(first.retainedPayloadBytes, 0);
			assert.ok(hasAlerted(loadState(config.statePath), path, key));
			assert.equal(pendingPayloadFor(loadState(config.statePath), path, key), undefined);
			assert.match(String(errors.mock.calls[0]?.arguments[0]), /TERMINAL.*state=/);
			appendFileSync(path, oversize ? " " : ccGrindTranscript(2));
			assert.equal((await tick(config, Date.now())).terminalFailures, 0);
			assert.equal(attemptedPayloads(config).length, 1);
		});
	}
}

for (const oversize of [false, true]) {
	test(`dry ${oversize ? "budget" : "finding"} tick neither creates state nor overwrites a concurrent live save`, async (t) => {
		const { config, claudeRoot } = fixture({ dryRun: true, ...(oversize ? { maxSessionBytes: 32 } : {}) });
		cleanupFixture(t, config);
		writeCcSession(claudeRoot, oversize
			? JSON.stringify({ body: "x".repeat(128) }) : ccGrindTranscript(320));
		await tick(config, Date.now());
		assert.equal(existsSync(config.statePath), false, "dry runs never create state");
		const liveState: WatchdogState = { sessions: {} };
		const path = join(claudeRoot, "another-live-session.jsonl");
		retainPendingPayload(liveState, path, "grind_loop@critical",
			retainedEvent(path, "grind_loop@critical"), Date.now());
		// Interleave a live writer after the dry tick has read its starting state.
		t.mock.method(console, "log", () => saveState(config.statePath, liveState));
		await tick(config, Date.now());
		assert.deepEqual(loadState(config.statePath), liveState);
		assert.equal(existsSync(config.localReceiptStore + ".count"), false);
	});
}

test("dry budget tick preserves a live retained payload and the exact on-disk state", async (t) => {
	const { config, claudeRoot } = fixture({ maxSessionBytes: 32 });
	loseFirstReceipt(t, config);
	const path = writeCcSession(claudeRoot, JSON.stringify({ body: "x".repeat(128) }));
	assert.equal((await tick(config, Date.now())).postFailures, 1);
	const before = readFileSync(config.statePath, "utf8");
	const dry = await tick({ ...config, dryRun: true }, Date.now());
	assert.equal(dry.alertsPosted, 0);
	assert.equal(dry.retainedPayloads, 1);
	assert.equal(dry.retainedPayloadBytes, Buffer.byteLength(attemptedPayloads(config)[0]!));
	assert.equal(readFileSync(config.statePath, "utf8"), before);
	assert.equal(loadState(config.statePath).sessions[path]?.pending, true);
	assert.equal((await tick(config, Date.now())).alertsPosted, 1);
});

test("budget branch logs transient exit status and rejection error", async (t) => {
	const { config, claudeRoot } = fixture({ maxSessionBytes: 32 }, true);
	cleanupFixture(t, config);
	const errors = t.mock.method(console, "error", () => {});
	writeCcSession(claudeRoot, JSON.stringify({ body: "x".repeat(128) }));
	const report = await tick(config, Date.now());
	assert.equal(report.postFailures, 1);
	assert.equal(report.retainedPayloads, 1);
	assert.match(String(errors.mock.calls[0]?.arguments[0]), /post failed \(2\): fixture failure/);
});

test("weekly eviction checks obsolete IDs and preserves uncertain adapter bindings", async (t) => {
	const { config, claudeRoot } = fixture();
	cleanupFixture(t, config);
	t.mock.method(console, "error", () => {});
	const now = Date.now();
	const state: WatchdogState = { sessions: {} };
	const statuses: Record<string, string> = {};
	const paths: Record<string, string> = {};
	const states = ["not_found", "delivered", "accepted_by_os", "deduped", "held_for_digest",
		"suppressed_quiet_hours", "suppressed_hourly_cap", "failed", "unknown", "abandoned_no_retry",
		"attempting", "lookup_failed", "invalid", "wrong_id"];
	for (const receipt of states) {
		const path = paths[receipt] = join(claudeRoot, receipt + ".jsonl");
		retainPendingPayload(state, path, "grind_loop@warning", retainedEvent(path), now - STATE_MAX_AGE_MS - 1);
		statuses[eventIdFor(path, "grind_loop@warning")] = receipt;
	}
	saveState(config.statePath, state);
	outcomeAdapter(config, "delivered", statuses);
	const report = await tick(config, now);
	const back = loadState(config.statePath);
	assert.equal(back.sessions[paths.not_found!], undefined);
	for (const receipt of states.slice(1, 10)) {
		assert.ok(hasAlerted(back, paths[receipt]!, "grind_loop@warning"), receipt);
		assert.equal(pendingPayloadFor(back, paths[receipt]!, "grind_loop@warning"), undefined);
	}
	for (const receipt of states.slice(10)) {
		assert.equal(pendingPayloadFor(back, paths[receipt]!, "grind_loop@warning"), retainedEvent(paths[receipt]!));
	}
	assert.equal(report.alertsPosted, 6);
	assert.equal(report.terminalFailures, 3);
	assert.deepEqual(retainedPayloadStats(back), {
		retainedPayloads: report.retainedPayloads, retainedPayloadBytes: report.retainedPayloadBytes,
	});
	assert.equal(report.retainedPayloads, 4);
	assert.equal(readFileSync(config.localReceiptStore + ".queries", "utf8").trim().split("\n").length, states.length);
});

test("weekly eviction checks a vanished finding in an unchanged in-window session", async (t) => {
	const { config, claudeRoot } = fixture();
	cleanupFixture(t, config);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(5));
	const now = Date.now();
	const state: WatchdogState = { sessions: {} };
	retainPendingPayload(state, path, "grind_loop@warning", retainedEvent(path), now - STATE_MAX_AGE_MS - 1);
	state.sessions[path]!.processedMtimeMs = statSync(path).mtimeMs;
	state.sessions[path]!.pending = false;
	saveState(config.statePath, state);
	outcomeAdapter(config);
	const report = await tick(config, now);
	assert.equal(report.skippedUnchanged, 1);
	assert.equal(report.retainedPayloads, 0);
	assert.equal(loadState(config.statePath).sessions[path], undefined);
});

test("weekly eviction cannot infer a vanished finding from an unverifiable transcript window", async (t) => {
	const { config, claudeRoot } = fixture({ maxSessionBytes: 32 });
	cleanupFixture(t, config);
	const path = writeCcSession(claudeRoot, JSON.stringify({ body: "x".repeat(128) }));
	const now = Date.now();
	const state: WatchdogState = { sessions: {} };
	retainPendingPayload(state, path, "grind_loop@warning", retainedEvent(path), now - STATE_MAX_AGE_MS - 1);
	state.sessions[path]!.processedMtimeMs = statSync(path).mtimeMs;
	state.sessions[path]!.pending = false;
	saveState(config.statePath, state);
	outcomeAdapter(config);
	const report = await tick(config, now);
	assert.equal(report.retainedPayloads, 1);
	assert.equal(pendingPayloadFor(loadState(config.statePath), path, "grind_loop@warning"), retainedEvent(path));
	assert.equal(existsSync(config.localReceiptStore + ".queries"), false);
});

function fullRetention(config: WatchdogConfig, now: number): WatchdogState {
	const state: WatchdogState = { sessions: {} };
	let i = 0;
	while (true) {
		const path = join(config.claudeProjectsDir, "retained-project", `unscanned-${i++}.jsonl`);
		const base = retainedEvent(path, "grind_loop@warning", "");
		const remaining = MAX_RETAINED_PAYLOAD_BYTES - retainedPayloadStats(state).retainedPayloadBytes;
		if (remaining < Buffer.byteLength(base)) break;
		const body = "x".repeat(Math.min(MAX_PENDING_PAYLOAD_BYTES, remaining) - Buffer.byteLength(base));
		assert.equal(retainPendingPayload(state, path, "grind_loop@warning", retainedEvent(path, "grind_loop@warning", body), now), true);
	}
	assert.equal(retainedPayloadStats(state).retainedPayloadBytes, MAX_RETAINED_PAYLOAD_BYTES);
	return state;
}

test("cap eviction checks vanished and out-of-window findings, keeping still-present payloads", async (t) => {
	const { config, claudeRoot } = fixture();
	cleanupFixture(t, config);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));
	const now = Date.now();
	const state = fullRetention(config, now);
	const [vanished, active] = Object.keys(state.sessions);
	mkdirSync(join(claudeRoot, "retained-project"), { recursive: true });
	writeFileSync(vanished!, ccGrindTranscript(5));
	writeFileSync(active!, ccGrindTranscript(320));
	state.sessions[active!]!.processedMtimeMs = statSync(active!).mtimeMs;
	state.sessions[active!]!.pending = false;
	saveState(config.statePath, state);
	outcomeAdapter(config);
	const report = await tick(config, now);
	assert.equal(report.alertsPosted, 1);
	assert.equal(report.postFailures, 0);
	assert.equal(report.retentionCapReached, false);
	assert.equal(report.retainedPayloads, 1);
	assert.ok(hasAlerted(loadState(config.statePath), path, "grind_loop@warning"));
	assert.equal(pendingPayloadFor(loadState(config.statePath), vanished!, "grind_loop@warning"), undefined);
	assert.equal(pendingPayloadFor(loadState(config.statePath), active!, "grind_loop@warning"),
		state.sessions[active!]!.pendingPayloads!["grind_loop@warning"]);
	const queries = readFileSync(config.localReceiptStore + ".queries", "utf8");
	assert.ok(queries.includes(eventIdFor(vanished!, "grind_loop@warning")));
	assert.ok(!queries.includes(eventIdFor(active!, "grind_loop@warning")));
});

test("cap pressure keeps failed status lookups, reports retention, and logs one operator line", async (t) => {
	const { config, claudeRoot, codexRoot } = fixture({ stallQuietSeconds: 0 });
	cleanupFixture(t, config);
	const errors = t.mock.method(console, "error", () => {});
	writeCcSession(claudeRoot, ccGrindTranscript(320));
	writeCodexSession(codexRoot, codexStallTranscript());
	const now = Date.now() + 1000; // scan time is after filesystem mtime rounding
	const state = fullRetention(config, now);
	saveState(config.statePath, state);
	outcomeAdapter(config, "delivered", {}, "lookup_failed");
	const report = await tick(config, now);
	assert.equal(report.postFailures, 2);
	assert.equal(report.terminalFailures, 0);
	assert.equal(report.retentionCapReached, true);
	assert.deepEqual(retainedPayloadStats(state), {
		retainedPayloads: report.retainedPayloads, retainedPayloadBytes: report.retainedPayloadBytes,
	});
	const back = loadState(config.statePath);
	for (const path of Object.keys(state.sessions)) {
		assert.equal(pendingPayloadFor(back, path, "grind_loop@warning"), state.sessions[path]!.pendingPayloads!["grind_loop@warning"]);
	}
	assert.equal(existsSync(config.localReceiptStore + ".attempts"), false);
	const lines = errors.mock.calls.map(call => String(call.arguments[0]));
	assert.equal(lines.filter(line => /operator action required/.test(line)).length, 1);
	assert.equal(lines.filter(line => /post failed.*retention cap reached/.test(line)).length, 2);
	const queries = readFileSync(config.localReceiptStore + ".queries", "utf8").trim().split("\n");
	assert.equal(new Set(queries).size, queries.length, "each ID is queried at most once per tick");
});

test("a full retained store reports operator action even without a new send", async (t) => {
	const { config } = fixture({ dryRun: true });
	cleanupFixture(t, config);
	const errors = t.mock.method(console, "error", () => {});
	const now = Date.now();
	saveState(config.statePath, fullRetention(config, now));
	const before = readFileSync(config.statePath, "utf8");
	const report = await tick(config, now);
	assert.equal(report.retentionCapReached, true);
	assert.equal(report.retainedPayloadBytes, MAX_RETAINED_PAYLOAD_BYTES);
	assert.equal(errors.mock.calls.length, 1);
	assert.equal(readFileSync(config.statePath, "utf8"), before);
	assert.equal(existsSync(config.localReceiptStore + ".queries"), false);
});

test("new severity escalation escapes the adapter policy group while old payloads replay unchanged", async (t) => {
	const { config, claudeRoot } = fixture();
	cleanupFixture(t, config);
	writeFileSync(config.localAdapterPath, `#!/usr/bin/env node
const fs = require("node:fs");
const store = process.argv[3];
let text = "";
process.stdin.on("data", chunk => text += chunk).on("end", () => {
  const event = JSON.parse(text);
  const groups = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : [];
  const group = JSON.stringify(["watchdog." + event.context.detector, event.source, event.dedupe_key]);
  const state = groups.includes(group) ? "deduped" : "delivered";
  groups.push(group);
  fs.writeFileSync(store, JSON.stringify(groups));
  fs.appendFileSync(store + ".events", JSON.stringify({...event, receiptState: state}) + "\\n");
  fs.appendFileSync(store + ".attempts", JSON.stringify(text) + "\\n");
  console.log(JSON.stringify({state, stable_event_id: event.event_id}));
});
`);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));
	// Seed a pre-R5 event without a dedupe_key: it must retain its original bytes.
	const trace = parseClaudeCodeTranscript(readFileSync(path, "utf8"));
	const finding = detect(trace).find(f => f.kind === "grind_loop")!;
	const oldEvent = buildEvent(finding, { harness: "claude-code", path, subagentPaths: [], mtimeMs: 0, sizeBytes: 0 }, null);
	delete oldEvent.dedupe_key;
	oldEvent.event_id = eventIdFor(path, "grind_loop@warning"); // pre-content-ID identity
	const original = JSON.stringify(oldEvent, null, " ");
	const state: WatchdogState = { sessions: {} };
	retainPendingPayload(state, path, "grind_loop@warning", original, Date.now());
	saveState(config.statePath, state);
	assert.equal((await tick(config, Date.now())).alertsPosted, 1);
	assert.equal(attemptedPayloads(config)[0], original);
	writeFileSync(path, ccGrindTranscript(1000));
	assert.equal((await tick(config, Date.now())).alertsPosted, 1);
	const events = postedEvents(config) as (NotificationEvent & { receiptState: string })[];
	assert.deepEqual(events.map(event => event.receiptState), ["delivered", "delivered"]);
	assert.equal(events[1]!.context.severity, "critical");
	assert.ok(events[1]!.dedupe_key);
	// Warning and critical built by R5 also occupy separate policy groups.
	const warning = buildEvent(finding, { harness: "claude-code", path, subagentPaths: [], mtimeMs: 0, sizeBytes: 0 }, null);
	assert.notEqual(warning.dedupe_key, events[1]!.dedupe_key);
	const newPath = join(path, "..", "new-session.jsonl");
	writeFileSync(newPath, ccGrindTranscript(320));
	assert.equal((await tick(config, Date.now())).alertsPosted, 1);
	writeFileSync(newPath, ccGrindTranscript(1000));
	assert.equal((await tick(config, Date.now())).alertsPosted, 1);
	const newEvents = postedEvents(config).slice(2) as (NotificationEvent & { receiptState: string })[];
	assert.deepEqual(newEvents.map(event => event.context.severity), ["warning", "critical"]);
	assert.deepEqual(newEvents.map(event => event.receiptState), ["delivered", "delivered"]);
});

/** Mirror the notifier contract: an event id is bound forever to its first payload bytes. */
function enforceStableIdPayload(config: WatchdogConfig): void {
	writeFileSync(config.localAdapterPath, `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
let text = "";
process.stdin.on("data", chunk => text += chunk).on("end", () => {
  const event = JSON.parse(text);
  const store = process.argv[3];
  const seen = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : {};
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  if (seen[event.event_id] !== undefined && seen[event.event_id] !== hash) {
    console.error(JSON.stringify({state: "rejected", error: "stable event id was reused with a changed payload"}));
    process.exitCode = 2;
    return;
  }
  seen[event.event_id] = hash;
  fs.writeFileSync(store, JSON.stringify(seen));
  fs.appendFileSync(store + ".events", text + "\\n");
  console.log(JSON.stringify({state: "delivered", stable_event_id: event.event_id}));
});
`);
}

test("a changed finding after lost dedupe state gets a new event id instead of a terminal rejection", async () => {
	const { config, claudeRoot } = fixture();
	enforceStableIdPayload(config);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));
	const first = await tick(config, Date.now());
	assert.equal(first.alertsPosted, 1);

	// A release cutover or state reset forgets the alert while the session keeps grinding.
	rmSync(config.statePath);
	appendFileSync(path, ccGrindTranscript(40));
	const second = await tick(config, Date.now());
	assert.equal(second.terminalFailures, 0);
	assert.equal(second.postFailures, 0);
	assert.equal(second.alertsPosted, 1);
	const [before, after] = postedEvents(config);
	assert.notEqual(after!.body, before!.body, "fixture must change the payload");
	assert.notEqual(after!.event_id, before!.event_id);
	assert.equal(after!.dedupe_key, before!.dedupe_key, "adapter still groups the repeat");
	assert.ok(hasAlerted(loadState(config.statePath), path, "grind_loop@warning"));
});
