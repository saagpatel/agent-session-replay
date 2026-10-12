import assert from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { detect } from "../core/detect/engine.ts";
import { parseClaudeCodeTranscript } from "../core/parsers/claude-code.ts";
import { buildEvent } from "./policy.ts";
import { loadState, pendingPayloadFor } from "./state.ts";
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
      fs.mkdirSync(statePath + ".tmp");
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
	assert.equal(rebuilt.event_id, JSON.parse(original).event_id);
	assert.notEqual(JSON.stringify(rebuilt), original, "fixture must change the live payload");

	const second = await tick(config, Date.now());
	assert.equal(second.alertsPosted, 1);
	assert.equal(second.postFailures, 0);
	assert.deepEqual(attemptedPayloads(config), [original, original]);
	assert.deepEqual(second.acceptedEventIds, [JSON.parse(original).event_id]);
	assert.equal(loadState(config.statePath).sessions[path]?.pendingPayloads, undefined);
	assert.equal((await tick(config, Date.now())).skippedUnchanged, 1);
});

test("a resolved finding drops its unacknowledged payload without retrying it", async (t) => {
	const { config, claudeRoot } = fixture();
	loseFirstReceipt(t, config);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));
	assert.equal((await tick(config, Date.now())).postFailures, 1);
	writeFileSync(path, ccGrindTranscript(5));
	const resolved = await tick(config, Date.now());
	assert.equal(resolved.alertsPosted, 0);
	assert.equal(resolved.postFailures, 0);
	assert.equal(attemptedPayloads(config).length, 1);
	assert.equal(loadState(config.statePath).sessions[path]?.pendingPayloads, undefined);
});

test("failed acknowledgement state write leaves the pre-send payload durable for retry", async (t) => {
	const { config, claudeRoot } = fixture();
	loseFirstReceipt(t, config, true);
	const path = writeCcSession(claudeRoot, ccGrindTranscript(320));
	await assert.rejects(tick(config, Date.now()));
	const original = attemptedPayloads(config)[0]!;
	assert.equal(pendingPayloadFor(loadState(config.statePath), path, "grind_loop@warning"), original);
	rmSync(config.statePath + ".tmp", { recursive: true });
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
