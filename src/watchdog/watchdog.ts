/**
 * One watchdog tick: scan -> parse -> detect -> policy -> dedupe -> post.
 *
 * Re-reads each active transcript whole rather than tailing byte offsets:
 * active sessions are a handful of files a few MB each, so a full re-parse
 * costs milliseconds and buys total reuse of the forensic parsers + engine
 * with zero incremental-state machinery to get wrong.
 */

import { readFileSync } from "node:fs";

import { detect } from "../core/detect/engine.ts";
import { parseClaudeCodeTranscript } from "../core/parsers/claude-code.ts";
import { parseCodexTranscript } from "../core/parsers/codex.ts";
import type { Trace } from "../core/types.ts";
import { buildEvent, liveVerdict } from "./policy.ts";
import { scanSessions } from "./scan.ts";
import { postEvent } from "./sink.ts";
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
import type { SessionFile, TickReport, WatchdogConfig } from "./types.ts";

function read(path: string): string {
	return readFileSync(path, "utf8");
}

function parseSession(session: SessionFile): Trace {
	if (session.harness === "codex")
		return parseCodexTranscript(read(session.path));
	return parseClaudeCodeTranscript(
		read(session.path),
		session.subagentPaths.map(read),
	);
}

export async function tick(
	config: WatchdogConfig,
	nowMs: number,
): Promise<TickReport> {
	const report: TickReport = {
		scannedSessions: 0,
		skippedOversize: 0,
		skippedUnchanged: 0,
		parseFailures: 0,
		findings: 0,
		alertsPosted: 0,
		alertsDeduped: 0,
		alertsHeld: 0,
		postFailures: 0,
	};
	let dirty = false;

	const cutoffMs = nowMs - config.windowMinutes * 60 * 1000;
	const sessions = scanSessions(
		config.claudeProjectsDir,
		config.codexSessionsDir,
		cutoffMs,
	);
	const state = loadState(config.statePath);

	for (const session of sessions) {
		if (session.sizeBytes > config.maxSessionBytes) {
			report.skippedOversize += 1;
			continue;
		}
		// Idle sessions linger in the mtime window for many ticks; skip the
		// re-parse when nothing changed AND the last pass left nothing pending
		// (a held silent_stall waiting out quiescence, or a failed post).
		if (canSkip(state, session.path, session.mtimeMs)) {
			report.skippedUnchanged += 1;
			continue;
		}
		report.scannedSessions += 1;

		let trace: Trace;
		try {
			trace = parseSession(session);
		} catch (err) {
			report.parseFailures += 1;
			console.error(
				`watchdog: parse failed for ${session.path}: ${String(err)}`,
			);
			continue;
		}

		const findings = detect(trace);
		report.findings += findings.length;
		const quietMs = nowMs - session.mtimeMs;
		let held = 0;
		let failed = 0;

		for (const finding of findings) {
			const verdict = liveVerdict(
				finding,
				quietMs,
				config.stallQuietSeconds * 1000,
			);
			if (verdict === "never") continue;
			if (verdict === "hold") {
				held += 1;
				report.alertsHeld += 1;
				continue;
			}
			const key = findingKey(finding);
			if (hasAlerted(state, session.path, key)) {
				report.alertsDeduped += 1;
				continue;
			}

			const event = buildEvent(finding, session, trace.run.workspace?.cwd);
			if (config.dryRun) {
				console.log(`watchdog[dry-run]: ${event.level} ${event.title}`);
				markAlerted(state, session.path, key, nowMs);
				dirty = true;
				report.alertsPosted += 1;
				continue;
			}
			const result = await postEvent(config.hubUrl, event);
			if (result.ok) {
				markAlerted(state, session.path, key, nowMs);
				dirty = true;
				report.alertsPosted += 1;
				console.log(`watchdog: posted ${event.level} '${event.title}'`);
			} else {
				// Not marked alerted -> retries next tick once the hub is back.
				failed += 1;
				report.postFailures += 1;
				console.error(
					`watchdog: post failed (${result.status ?? "no-response"}): ${result.error ?? ""}`,
				);
			}
		}

		dirty =
			markProcessed(
				state,
				session.path,
				session.mtimeMs,
				held > 0 || failed > 0,
				nowMs,
			) || dirty;
	}

	const pruned = pruneState(state, nowMs);
	if (dirty || pruned > 0) saveState(config.statePath, state);
	return report;
}
