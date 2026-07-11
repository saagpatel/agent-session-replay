import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { scanClaudeProjects, scanCodexSessions, scanSessions } from "./scan.ts";

function roots(): { claude: string; codex: string } {
	const base = mkdtempSync(join(tmpdir(), "watchdog-scan-"));
	const claude = join(base, "projects");
	const codex = join(base, "sessions");
	mkdirSync(claude, { recursive: true });
	mkdirSync(codex, { recursive: true });
	return { claude, codex };
}

function writeAged(path: string, ageMs: number, content = "{}\n"): void {
	writeFileSync(path, content);
	const t = (Date.now() - ageMs) / 1000;
	utimesSync(path, t, t);
}

test("finds a recently-written CC session with its subagent sidechains", () => {
	const { claude, codex } = roots();
	const proj = join(claude, "-Users-x-repo");
	const subDir = join(proj, "abc123", "subagents");
	mkdirSync(subDir, { recursive: true });
	writeAged(join(proj, "abc123.jsonl"), 0);
	writeAged(join(subDir, "agent-1.jsonl"), 0);
	writeAged(join(subDir, "notes.txt"), 0); // non-jsonl ignored

	const found = scanSessions(claude, codex, Date.now() - 60_000);
	assert.equal(found.length, 1);
	const s = found[0];
	if (!s) throw new Error("expected a session");
	assert.equal(s.harness, "claude-code");
	assert.equal(s.subagentPaths.length, 1);
	assert.ok(s.sizeBytes > 0);
});

test("sessions older than the window are never surfaced", () => {
	const { claude } = roots();
	const proj = join(claude, "-p");
	mkdirSync(proj, { recursive: true });
	writeAged(join(proj, "old.jsonl"), 60 * 60 * 1000); // 1h old
	assert.equal(
		scanClaudeProjects(claude, Date.now() - 30 * 60 * 1000).length,
		0,
	);
});

test("a fresh subagent write keeps a quiet main transcript in the window", () => {
	const { claude } = roots();
	const proj = join(claude, "-p");
	const subDir = join(proj, "s1", "subagents");
	mkdirSync(subDir, { recursive: true });
	writeAged(join(proj, "s1.jsonl"), 60 * 60 * 1000); // main quiet for 1h
	writeAged(join(subDir, "agent-busy.jsonl"), 0); // sidechain writing now

	const found = scanClaudeProjects(claude, Date.now() - 30 * 60 * 1000);
	assert.equal(found.length, 1);
});

test("finds codex rollouts nested in date directories", () => {
	const { codex } = roots();
	const day = join(codex, "2026", "07", "10");
	mkdirSync(day, { recursive: true });
	writeAged(join(day, "rollout-2026-07-10-abc.jsonl"), 0);

	const found = scanCodexSessions(codex, Date.now() - 60_000);
	assert.equal(found.length, 1);
	const s = found[0];
	if (!s) throw new Error("expected a session");
	assert.equal(s.harness, "codex");
	assert.deepEqual(s.subagentPaths, []);
});

test("missing roots scan to empty instead of throwing", () => {
	assert.deepEqual(scanSessions("/nonexistent-a", "/nonexistent-b", 0), []);
});
