import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { WatchdogConfig } from "./types.ts";
import { tick } from "./watchdog.ts";

function boundedFixture(maxSessionBytes: number): {
	config: WatchdogConfig;
	claudeRoot: string;
} {
	const root = mkdtempSync(join(tmpdir(), "watchdog-bounded-"));
	const claudeRoot = join(root, "claude");
	const codexRoot = join(root, "codex");
	mkdirSync(claudeRoot, { recursive: true });
	mkdirSync(codexRoot, { recursive: true });
	return {
		claudeRoot,
		config: {
			claudeProjectsDir: claudeRoot,
			codexSessionsDir: codexRoot,
			hubUrl: "http://127.0.0.1:1",
			hubProducerId: "agent-watchdog",
			hubTokenFile: join(root, "unused.token"),
			windowMinutes: 30,
			stallQuietSeconds: 600,
			maxSessionBytes,
			statePath: join(root, "state.json"),
			dryRun: true,
		},
	};
}

test("controlled dry run fails closed at the aggregate transcript ceiling", async () => {
	const { config, claudeRoot } = boundedFixture(32);
	const project = join(claudeRoot, "fixture-project");
	const main = join(project, "session.jsonl");
	const sidechains = join(project, "session", "subagents");
	mkdirSync(sidechains, { recursive: true });
	writeFileSync(main, "{}\n");
	writeFileSync(join(sidechains, "agent-current.jsonl"), "x".repeat(30));

	const report = await tick(config, Date.now());

	assert.equal(report.scannedSessions, 0);
	assert.equal(report.skippedOversize, 1);
	assert.equal(report.alertsPosted, 1);
	assert.equal(report.postFailures, 0);
	assert.deepEqual(report.acceptedEventIds, []);
});
