/**
 * Watchdog CLI entry.
 *
 *   node --experimental-strip-types src/watchdog/main.ts [--once] [--dry-run]
 *     [--interval 45] [--window 30] [--quiet 120] [--stall-quiet 600]
 *     [--hub http://127.0.0.1:9199] [--state <path>]
 *
 * Alert-only by contract: the only side effects are POST /events to
 * notification-hub and the dedupe-state file.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { WatchdogConfig } from "./types.ts";
import { tick } from "./watchdog.ts";

const { values: args } = parseArgs({
	options: {
		once: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		/** seconds between ticks */
		interval: { type: "string", default: "45" },
		/** minutes of transcript-write recency to watch */
		window: { type: "string", default: "30" },
		/** seconds of silence before a session counts as settled */
		quiet: { type: "string", default: "120" },
		/** seconds of silence before silent_stall may fire */
		"stall-quiet": { type: "string", default: "600" },
		hub: { type: "string", default: "http://127.0.0.1:9199" },
		state: {
			type: "string",
			default: join(
				homedir(),
				".local",
				"state",
				"agent-watchdog",
				"state.json",
			),
		},
	},
});

function num(name: string, raw: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`--${name} must be a positive number, got '${raw}'`);
	}
	return n;
}

const config: WatchdogConfig = {
	claudeProjectsDir: join(homedir(), ".claude", "projects"),
	codexSessionsDir: join(homedir(), ".codex", "sessions"),
	hubUrl: args.hub,
	windowMinutes: num("window", args.window),
	quietSeconds: num("quiet", args.quiet),
	stallQuietSeconds: num("stall-quiet", args["stall-quiet"]),
	maxSessionBytes: 64 * 1024 * 1024,
	statePath: args.state,
	dryRun: args["dry-run"],
};

const intervalMs = num("interval", args.interval) * 1000;

async function runOnce(): Promise<void> {
	const report = await tick(config, Date.now());
	console.log(`watchdog: ${JSON.stringify(report)}`);
}

if (args.once) {
	await runOnce();
} else {
	console.log(
		`watchdog: watching (interval ${intervalMs / 1000}s, window ${config.windowMinutes}m, ` +
			`hub ${config.hubUrl}${config.dryRun ? ", DRY-RUN" : ""})`,
	);
	// Sequential loop, never overlapping ticks; a tick failure logs and continues.
	for (;;) {
		try {
			await runOnce();
		} catch (err) {
			console.error(`watchdog: tick crashed: ${String(err)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
