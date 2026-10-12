/**
 * Watchdog CLI entry.
 *
 *   node --experimental-strip-types src/watchdog/main.ts [--once] [--dry-run]
 *     [--interval 45] [--window 30] [--stall-quiet 600]
 *     [--adapter <path>] [--receipts <path>] [--state <path>]
 *
 * Adapter resolution: --adapter flag > LOCAL_NOTIFICATION_ADAPTER env >
 * the installed local adapter path.
 *
 * Alert-only by contract: the only side effects are local adapter attempts
 * and the watchdog's dedupe-state file.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { localNotificationDefaults } from "./config.ts";
import {
	terminalLine,
	terminalStateForFailure,
	terminalStateForReport,
} from "./terminal.ts";
import type { WatchdogConfig } from "./types.ts";
import { tick } from "./watchdog.ts";

const defaults = localNotificationDefaults();
const { values: args } = parseArgs({
	options: {
		once: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		/** seconds between ticks */
		interval: { type: "string", default: "45" },
		/** minutes of transcript-write recency to watch */
		window: { type: "string", default: "30" },
		/** seconds of silence before silent_stall may fire */
		"stall-quiet": { type: "string", default: "600" },
		adapter: {
			type: "string",
			default: defaults.adapter,
		},
		receipts: {
			type: "string",
			default: defaults.receipts,
		},
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
	localAdapterPath: args.adapter,
	localReceiptStore: args.receipts,
	windowMinutes: num("window", args.window),
	stallQuietSeconds: num("stall-quiet", args["stall-quiet"]),
	maxSessionBytes: 96 * 1024 * 1024,
	statePath: args.state,
	dryRun: args["dry-run"],
};

const intervalMs = num("interval", args.interval) * 1000;

async function runOnce(): Promise<number> {
	const started = Date.now();
	try {
		const report = await tick(config, started);
		console.log(`watchdog: ${JSON.stringify(report)}`);
		const observedAt = new Date().toISOString();
		const terminal = terminalStateForReport(
			report,
			config.localAdapterPath,
			config.dryRun,
			observedAt,
			Date.now() - started,
		);
		console.log(terminalLine(terminal));
		return terminal.exit_code;
	} catch (err) {
		const observedAt = new Date().toISOString();
		console.log(
			terminalLine(
				terminalStateForFailure(
					err,
					config.localAdapterPath,
					observedAt,
					Date.now() - started,
				),
			),
		);
		throw err;
	}
}

if (args.once) {
	process.exitCode = await runOnce();
} else {
	console.log(
		`watchdog: watching (interval ${intervalMs / 1000}s, window ${config.windowMinutes}m, ` +
			`adapter ${config.localAdapterPath}${config.dryRun ? ", DRY-RUN" : ""})`,
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
