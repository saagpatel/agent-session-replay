import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Finding } from "../core/detect/types.ts";
import {
	canSkip,
	findingKey,
	hasAlerted,
	loadState,
	markAlerted,
	markProcessed,
	pruneState,
	saveState,
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
});

test("saveState writes valid JSON atomically (no partial tmp left behind)", () => {
	const path = join(dir(), "state.json");
	const state = loadState(path);
	markAlerted(state, "/s/a.jsonl", "k@warning", 5);
	saveState(path, state);
	assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")));
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
