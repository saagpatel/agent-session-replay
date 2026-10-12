import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Finding } from "../core/detect/types.ts";
import { eventIdFor } from "./policy.ts";
import {
	canSkip,
	findingKey,
	hasAlerted,
	loadState,
	markAlerted,
	markProcessed,
	MAX_PENDING_PAYLOAD_BYTES,
	MAX_RETAINED_PAYLOAD_BYTES,
	pendingPayloadFor,
	pendingPayloadError,
	pruneState,
	retainPendingPayload,
	retainedPayloadStats,
	saveState,
	type WatchdogState,
} from "./state.ts";

const dir = () => mkdtempSync(join(tmpdir(), "watchdog-state-"));

function finding(id: string, severity: Finding["severity"]): Finding {
	return {
		id,
		kind: "grind_loop",
		severity,
		title: "t",
		detail: "d",
		step_ids: [],
		score: 1,
	};
}

test("state round-trips through save and load", () => {
	const path = join(dir(), "nested", "state.json");
	const state = loadState(path); // missing file -> clean state
	markAlerted(state, "/s/a.jsonl", "grind_loop@warning", 1000);
	saveState(path, state);
	const back = loadState(path);
	assert.ok(hasAlerted(back, "/s/a.jsonl", "grind_loop@warning"));
	assert.ok(!hasAlerted(back, "/s/a.jsonl", "grind_loop@critical"));
	assert.ok(!hasAlerted(back, "/s/b.jsonl", "grind_loop@warning"));
});

test("a corrupt state file loads as a clean slate instead of crashing", () => {
	const path = join(dir(), "state.json");
	writeFileSync(path, "{ not json");
	assert.deepEqual(loadState(path), { sessions: {} });
	writeFileSync(path, '"a string"');
	assert.deepEqual(loadState(path), { sessions: {} });
	writeFileSync(path, '{"sessions":[]}');
	assert.deepEqual(loadState(path), { sessions: {} });
});

test("malformed nested entries are dropped while valid dedupe state survives", () => {
	const path = join(dir(), "state.json");
	writeFileSync(
		path,
		JSON.stringify({
			sessions: {
				"/valid.jsonl": {
					findings: ["grind_loop@warning"],
					updatedMs: 1000,
					processedMtimeMs: 500,
					pending: false,
					extra: "ignored for forward compatibility",
				},
				"/bad-findings.jsonl": {
					findings: "grind_loop@warning",
					updatedMs: 1000,
				},
				"/bad-time.jsonl": {
					findings: [],
					updatedMs: "yesterday",
				},
				"/bad-pending.jsonl": {
					findings: [],
					updatedMs: 1000,
					pending: "no",
				},
			},
		}),
	);

	const state = loadState(path);
	assert.deepEqual(Object.keys(state.sessions), ["/valid.jsonl"]);
	assert.deepEqual(state.sessions["/valid.jsonl"], {
		findings: ["grind_loop@warning"],
		updatedMs: 1000,
		processedMtimeMs: 500,
		pending: false,
	});
	assert.ok(hasAlerted(state, "/valid.jsonl", "grind_loop@warning"));
	assert.doesNotThrow(() =>
		markAlerted(state, "/bad-findings.jsonl", "grind_loop@warning", 2000),
	);
});

test("saveState writes valid JSON atomically (no partial tmp left behind)", () => {
	const path = join(dir(), "state.json");
	const state = loadState(path);
	markAlerted(state, "/s/a.jsonl", "k@warning", 5);
	// A legacy shared temp path must not interfere with this process's save.
	mkdirSync(path + ".tmp");
	saveState(path, state);
	assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")));
	assert.equal(existsSync(`${path}.${process.pid}.tmp`), false);
	assert.equal(existsSync(path + ".tmp"), true);
});

test("findingKey carries severity so an escalation re-alerts", () => {
	assert.notEqual(
		findingKey(finding("grind_loop", "warning")),
		findingKey(finding("grind_loop", "critical")),
	);
});

test("pruneState drops sessions untouched for over a week, keeps fresh ones", () => {
	const state = loadState(join(dir(), "none.json"));
	const now = 10 * 24 * 60 * 60 * 1000;
	markAlerted(state, "/old.jsonl", "k@warning", now - 8 * 24 * 60 * 60 * 1000);
	markAlerted(state, "/new.jsonl", "k@warning", now - 60 * 1000);
	const removed = pruneState(state, now);
	assert.equal(removed, 1);
	assert.ok(!hasAlerted(state, "/old.jsonl", "k@warning"));
	assert.ok(hasAlerted(state, "/new.jsonl", "k@warning"));
});

test("canSkip requires an identical mtime and nothing pending from last pass", () => {
	const state = loadState(join(dir(), "none.json"));
	assert.ok(!canSkip(state, "/s.jsonl", 100)); // never processed
	markProcessed(state, "/s.jsonl", 100, false, 1000);
	assert.ok(canSkip(state, "/s.jsonl", 100));
	assert.ok(!canSkip(state, "/s.jsonl", 200)); // file advanced
	markProcessed(state, "/s.jsonl", 200, true, 2000); // held/failed work pending
	assert.ok(!canSkip(state, "/s.jsonl", 200));
});

test("markProcessed reports whether the entry actually changed", () => {
	const state = loadState(join(dir(), "none.json"));
	assert.equal(markProcessed(state, "/s.jsonl", 100, false, 1000), true);
	assert.equal(markProcessed(state, "/s.jsonl", 100, false, 2000), false);
	assert.equal(markProcessed(state, "/s.jsonl", 100, true, 3000), true);
	assert.equal(markProcessed(state, "/s.jsonl", 300, true, 4000), true);
});

function payloadFor(path: string, key = "grind_loop@warning", body = "first payload"): string {
	// Whitespace is intentional: persistence must preserve the serialized bytes.
	return JSON.stringify({
		event_id: eventIdFor(path, key), source: "cc", level: "normal",
		title: "fixture", body, context: { detector: "grind_loop", score: 320 },
	}, null, " ");
}

test("retained payload bytes round-trip and acknowledgement removes them", () => {
	const path = join(dir(), "state.json");
	const session = "/s/pending.jsonl";
	const key = "grind_loop@warning";
	const payload = payloadFor(session);
	const state = loadState(path);
	assert.equal(retainPendingPayload(state, session, key, payload, 1000), true);
	saveState(path, state);
	const back = loadState(path);
	assert.deepEqual(back, state);
	assert.equal(pendingPayloadFor(back, session, key), payload);
	assert.equal(retainPendingPayload(back, session, key, payloadFor(session, key, "changed"), 2000), false);
	assert.equal(pendingPayloadFor(back, session, key), payload);
	markAlerted(back, session, key, 2000);
	assert.equal(back.sessions[session]?.pendingPayloads, undefined);
	saveState(path, back);
	assert.equal(pendingPayloadFor(loadState(path), session, key), undefined);
});

test("malformed retained payload state is rejected like other malformed session entries", () => {
	const path = join(dir(), "state.json");
	const session = "/s/pending.jsonl";
	const key = "grind_loop@warning";
	const payload = payloadFor(session);
	const valid = { findings: [], updatedMs: 1000, pending: true, pendingPayloads: { [key]: payload } };
	for (const invalid of [
		{ pendingPayloads: [] },
		{ pendingPayloads: { [key]: {} } },
		{ pendingPayloads: { [key]: "not-json" } },
		{ pendingPayloads: { [key]: "null" } },
		{ pendingPayloads: { [key]: payloadFor("/wrong-session.jsonl") } },
		{ pendingPayloads: { [key]: payloadFor(session, "grind_loop@critical") } },
		{ pendingPayloads: { [key]: JSON.stringify({ ...JSON.parse(payload), body: 12 }) } },
		{ pendingPayloads: { [key]: JSON.stringify({ ...JSON.parse(payload), context: { score: {} } }) } },
		{ pendingPayloads: { [key]: JSON.stringify({ ...JSON.parse(payload), dedupe_key: "" }) } },
		{ pendingPayloads: { [key]: JSON.stringify({ ...JSON.parse(payload), dedupe_key: 123 }) } },
		{ pendingPayloads: { [key]: JSON.stringify({ ...JSON.parse(payload), dedupe_key: "x".repeat(201) }) } },
		{ pendingPayloads: { [key]: payloadFor(session, key, "x".repeat(MAX_PENDING_PAYLOAD_BYTES)) } },
		{ findings: [key] },
	]) {
		writeFileSync(path, JSON.stringify({ sessions: {
			[session]: { ...valid, ...invalid },
			"/valid.jsonl": { findings: [key], updatedMs: 1000 },
		} }));
		assert.deepEqual(Object.keys(loadState(path).sessions), ["/valid.jsonl"]);
	}
	// A payload outlives its pending finding until acknowledged.
	writeFileSync(path, JSON.stringify({ sessions: { [session]: { ...valid, pending: false } } }));
	assert.equal(loadState(path).sessions[session]?.pendingPayloads?.[key], payload);
});

test("payloads whose findings are no longer pending are removed", () => {
	const state = loadState(join(dir(), "none.json"));
	const session = "/s/pending.jsonl";
	const key = "grind_loop@warning";
	retainPendingPayload(state, session, key, payloadFor(session), 1000);
});

test("retention caps refuse new payloads without evicting an unknown attempt", () => {
	const path = join(dir(), "state.json");
	const state = loadState(path);
	const key = "grind_loop@warning";
	const body = "x".repeat(MAX_PENDING_PAYLOAD_BYTES - 512);
	let bytes = 0;
	let i = 0;
	while (true) {
		const session = `/s/${i++}.jsonl`;
		const payload = payloadFor(session, key, body);
		if (bytes + Buffer.byteLength(payload) > MAX_RETAINED_PAYLOAD_BYTES) {
			assert.equal(retainPendingPayload(state, session, key, payload, 1000), false);
			assert.equal(pendingPayloadError(state, session, key, payload), "retention cap reached");
			assert.equal(state.sessions[session], undefined);
			break;
		}
		assert.equal(retainPendingPayload(state, session, key, payload, 1000), true);
		bytes += Buffer.byteLength(payload);
	}
	assert.equal(retainPendingPayload(state, "/too-big.jsonl", key,
		payloadFor("/too-big.jsonl", key, "x".repeat(MAX_PENDING_PAYLOAD_BYTES)), 1000), false);
	assert.equal(pendingPayloadError(state, "/too-big.jsonl", key,
		payloadFor("/too-big.jsonl", key, "x".repeat(MAX_PENDING_PAYLOAD_BYTES))), "payload invalid");
	assert.deepEqual(retainedPayloadStats(state), {
		retainedPayloads: i - 1, retainedPayloadBytes: bytes,
	});
	assert.equal(pendingPayloadFor(state, "/s/0.jsonl", key), payloadFor("/s/0.jsonl", key, body));
	saveState(path, state);
	assert.deepEqual(loadState(path), state);
});

test("weekly pruning keeps a session that holds an unacknowledged payload", () => {
	const session = "/s/resumed.jsonl";
	const key = "grind_loop@warning";
	const state: WatchdogState = { sessions: {
		[session]: { findings: [], updatedMs: 0, pendingPayloads: { [key]: payloadFor(session) } },
		"/s/old.jsonl": { findings: [key], updatedMs: 0 },
	} };
	assert.equal(pruneState(state, 30 * 24 * 60 * 60 * 1000), 1);
	assert.deepEqual(Object.keys(state.sessions), [session]);
});
