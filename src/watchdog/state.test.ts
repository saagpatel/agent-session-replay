import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Finding } from "../core/detect/types.ts";
import {
	findingKey,
	hasAlerted,
	loadState,
	markAlerted,
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
	pruneState(state, now);
	assert.ok(!hasAlerted(state, "/old.jsonl", "k@warning"));
	assert.ok(hasAlerted(state, "/new.jsonl", "k@warning"));
});
