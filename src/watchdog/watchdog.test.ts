import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { HubEvent, WatchdogConfig } from "./types.ts";
import { tick } from "./watchdog.ts";

/* ---------- stub notification-hub ---------- */

const posts: HubEvent[] = [];
let failNext = false;
const server: Server = createServer((req, res) => {
	let body = "";
	req.on("data", (c: unknown) => {
		body += String(c);
	});
	req.on("end", () => {
		if (failNext) {
			failNext = false;
			res.statusCode = 500;
			res.end("boom");
			return;
		}
		posts.push(JSON.parse(body) as HubEvent);
		res.statusCode = 201;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ event_id: "e", level: "normal", accepted: true }));
	});
});
await new Promise<void>((resolve) => {
	server.listen(0, "127.0.0.1", resolve);
});
const addr = server.address();
const hubUrl =
	typeof addr === "object" && addr !== null
		? `http://127.0.0.1:${addr.port}`
		: "unreachable";
after(() => server.close());

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

function fixture(over: Partial<WatchdogConfig> = {}): Fixture {
	const base = mkdtempSync(join(tmpdir(), "watchdog-tick-"));
	const claudeRoot = join(base, "projects");
	const codexRoot = join(base, "sessions");
	mkdirSync(claudeRoot, { recursive: true });
	mkdirSync(codexRoot, { recursive: true });
	return {
		claudeRoot,
		codexRoot,
		config: {
			claudeProjectsDir: claudeRoot,
			codexSessionsDir: codexRoot,
			hubUrl,
			windowMinutes: 30,
			quietSeconds: 120,
			stallQuietSeconds: 600,
			maxSessionBytes: 64 * 1024 * 1024,
			statePath: join(base, "state.json"),
			dryRun: false,
			...over,
		},
	};
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

test("a grinding CC session posts one grind_loop alert; the next tick dedupes it", async () => {
	const { config, claudeRoot } = fixture();
	writeCcSession(claudeRoot, ccGrindTranscript(130));
	posts.length = 0;

	const first = await tick(config, Date.now());
	assert.equal(first.alertsPosted, 1);
	assert.equal(posts.length, 1);
	const event = posts[0];
	if (!event) throw new Error("expected a posted event");
	assert.equal(event.source, "cc");
	assert.equal(event.level, "normal");
	assert.equal(event.context["detector"], "grind_loop");
	assert.equal(event.project, "bridge-db");
	assert.ok(event.title.length <= 200);

	const second = await tick(config, Date.now());
	assert.equal(second.alertsPosted, 0);
	assert.ok(second.alertsDeduped >= 1);
	assert.equal(posts.length, 1);
});

test("incomplete_run on a live session is suppressed entirely", async () => {
	const { config, claudeRoot } = fixture();
	// Small clean session: parses fine, live (just written), no clean end_turn.
	writeCcSession(claudeRoot, ccGrindTranscript(5));
	posts.length = 0;
	const report = await tick(config, Date.now());
	assert.equal(report.alertsPosted, 0);
	assert.equal(posts.length, 0);
});

test("a settled codex no-op run posts a silent_stall; a fresh one is held", async () => {
	const fresh = fixture();
	writeCodexSession(fresh.codexRoot, codexStallTranscript());
	posts.length = 0;

	// Fresh: written moments ago -> held, not posted.
	const held = await tick(fresh.config, Date.now());
	assert.equal(held.alertsPosted, 0);
	assert.ok(held.alertsHeld >= 1);

	// Settled: pretend 11 minutes elapsed with no further writes.
	const settled = await tick(fresh.config, Date.now() + 11 * 60 * 1000);
	assert.equal(settled.alertsPosted, 1);
	const event = posts[0];
	if (!event) throw new Error("expected a posted event");
	assert.equal(event.source, "codex");
	assert.equal(event.context["detector"], "silent_stall");
});

test("a failed post is retried on the next tick (nothing marked alerted)", async () => {
	const { config, claudeRoot } = fixture();
	writeCcSession(claudeRoot, ccGrindTranscript(130));
	posts.length = 0;

	failNext = true;
	const first = await tick(config, Date.now());
	assert.equal(first.postFailures, 1);
	assert.equal(first.alertsPosted, 0);

	const second = await tick(config, Date.now());
	assert.equal(second.alertsPosted, 1);
	assert.equal(posts.length, 1);
});

test("dry-run logs and dedupes but never touches the network", async () => {
	const { config, claudeRoot } = fixture({
		dryRun: true,
		hubUrl: "http://127.0.0.1:1",
	});
	writeCcSession(claudeRoot, ccGrindTranscript(130));
	posts.length = 0;

	const report = await tick(config, Date.now());
	assert.equal(report.alertsPosted, 1);
	assert.equal(report.postFailures, 0);
	assert.equal(posts.length, 0);
});

test("oversize transcripts are skipped, counted, and never parsed", async () => {
	const { config, claudeRoot } = fixture({ maxSessionBytes: 10 });
	writeCcSession(claudeRoot, ccGrindTranscript(130));
	const report = await tick(config, Date.now());
	assert.equal(report.skippedOversize, 1);
	assert.equal(report.scannedSessions, 0);
});
