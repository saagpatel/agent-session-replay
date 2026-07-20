/**
 * One watchdog tick: scan -> parse -> detect -> policy -> dedupe -> post.
 *
 * Re-reads each active transcript whole rather than tailing byte offsets:
 * active sessions are a handful of files a few MB each, so a full re-parse
 * costs milliseconds and buys total reuse of the forensic parsers + engine
 * with zero incremental-state machinery to get wrong.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";

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
import type {
	HubEvent,
	SessionFile,
	TickReport,
	WatchdogConfig,
} from "./types.ts";

class TranscriptBudgetError extends Error {}

function readBounded(path: string, remainingBytes: number): string {
	const fd = openSync(path, "r");
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > remainingBytes)
			throw new TranscriptBudgetError(
				"transcript exceeds remaining byte budget",
			);
		const chunks: Buffer[] = [];
		let consumed = 0;
		const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remainingBytes + 1));
		while (true) {
			const read = readSync(
				fd,
				buffer,
				0,
				Math.min(buffer.length, remainingBytes - consumed + 1),
				null,
			);
			if (read === 0) break;
			consumed += read;
			if (consumed > remainingBytes)
				throw new TranscriptBudgetError("transcript grew beyond byte budget");
			chunks.push(Buffer.from(buffer.subarray(0, read)));
		}
		const after = fstatSync(fd);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			consumed !== after.size
		)
			throw new TranscriptBudgetError("transcript changed during bounded read");
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function parseSession(session: SessionFile, maxBytes: number): Trace {
	let remaining = maxBytes;
	const read = (path: string): string => {
		const text = readBounded(path, remaining);
		remaining -= Buffer.byteLength(text);
		return text;
	};
	if (session.harness === "codex")
		return parseCodexTranscript(read(session.path));
	return parseClaudeCodeTranscript(
		read(session.path),
		session.subagentPaths.map(read),
	);
}

function oversizeEvent(session: SessionFile, limit: number): HubEvent {
	return {
		source: session.harness === "codex" ? "codex" : "cc",
		level: "urgent",
		title: "Watchdog: transcript exceeded bounded scan budget",
		body: `The active transcript could not be read consistently within the ${limit}-byte watchdog ceiling. Detection is fail-closed until the session shrinks or rotates. Transcript: ${session.path}`,
		session_label: basename(session.path),
		intent: "needs_attention",
		context: {
			detector: "transcript_budget_exceeded",
			severity: "critical",
			harness: session.harness,
			transcript_path: session.path,
			max_session_bytes: limit,
		},
	};
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
		acceptedEventIds: [],
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
			const key = "transcript_budget_exceeded@critical";
			if (hasAlerted(state, session.path, key)) {
				report.alertsDeduped += 1;
				continue;
			}
			const event = oversizeEvent(session, config.maxSessionBytes);
			if (config.dryRun) {
				console.log(`watchdog[dry-run]: ${event.level} ${event.title}`);
				markAlerted(state, session.path, key, nowMs);
				dirty = true;
				report.alertsPosted += 1;
				continue;
			}
			const result = await postEvent(config.hubUrl, event, {
				producerId: config.hubProducerId,
				tokenFile: config.hubTokenFile,
			});
			if (result.ok && result.eventId) {
				markAlerted(state, session.path, key, nowMs);
				dirty = true;
				report.alertsPosted += 1;
				report.acceptedEventIds.push(result.eventId);
			} else {
				report.postFailures += 1;
			}
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
			trace = parseSession(session, config.maxSessionBytes);
		} catch (err) {
			if (err instanceof TranscriptBudgetError) {
				report.skippedOversize += 1;
				const key = "transcript_budget_exceeded@critical";
				if (!hasAlerted(state, session.path, key)) {
					const event = oversizeEvent(session, config.maxSessionBytes);
					if (config.dryRun) {
						console.log(`watchdog[dry-run]: ${event.level} ${event.title}`);
						markAlerted(state, session.path, key, nowMs);
						dirty = true;
						report.alertsPosted += 1;
					} else {
						const result = await postEvent(config.hubUrl, event, {
							producerId: config.hubProducerId,
							tokenFile: config.hubTokenFile,
						});
						if (result.ok && result.eventId) {
							markAlerted(state, session.path, key, nowMs);
							dirty = true;
							report.alertsPosted += 1;
							report.acceptedEventIds.push(result.eventId);
						} else {
							report.postFailures += 1;
						}
					}
				} else {
					report.alertsDeduped += 1;
				}
				continue;
			}
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
			const result = await postEvent(config.hubUrl, event, {
				producerId: config.hubProducerId,
				tokenFile: config.hubTokenFile,
			});
			if (result.ok && result.eventId) {
				markAlerted(state, session.path, key, nowMs);
				dirty = true;
				report.alertsPosted += 1;
				report.acceptedEventIds.push(result.eventId);
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
