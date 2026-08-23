/**
 * One watchdog tick: scan -> parse -> detect -> policy -> dedupe -> post.
 *
 * Re-reads each active transcript under one aggregate byte ceiling. Files that
 * fit are parsed whole. A larger append-only JSONL transcript is parsed from a
 * stable, newline-aligned recent window so a long-lived session cannot turn
 * into a permanent coverage outage merely by growing past the ceiling.
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

export function boundedReadSnapshotIsValid(
	before: { dev: number; ino: number; size: number; mtimeMs: number },
	after: { dev: number; ino: number; size: number; mtimeMs: number },
	consumed: number,
	startOffset = 0,
): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		after.size >= before.size &&
		startOffset + consumed === before.size &&
		(after.size > before.size || after.mtimeMs === before.mtimeMs)
	);
}

interface BoundedRead {
	text: string;
	readBytes: number;
	windowed: boolean;
}

function readBounded(path: string, byteBudget: number): BoundedRead {
	const fd = openSync(path, "r");
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || byteBudget < 1)
			throw new TranscriptBudgetError("transcript has no readable byte budget");
		const snapshotSize = Math.min(before.size, byteBudget);
		const startOffset = before.size - snapshotSize;
		const chunks: Buffer[] = [];
		let consumed = 0;
		const buffer = Buffer.allocUnsafe(
			Math.max(1, Math.min(64 * 1024, snapshotSize)),
		);
		while (consumed < snapshotSize) {
			const read = readSync(
				fd,
				buffer,
				0,
				Math.min(buffer.length, snapshotSize - consumed),
				startOffset + consumed,
			);
			if (read === 0)
				throw new TranscriptBudgetError("transcript truncated during bounded read");
			consumed += read;
			chunks.push(Buffer.from(buffer.subarray(0, read)));
		}
		const after = fstatSync(fd);
		// Session transcripts are append-only. Accept a stable prefix when the
		// same inode grew while it was being read; the next tick will inspect
		// the appended bytes. Replacement, truncation, or same-size mutation
		// still fails closed.
		if (!boundedReadSnapshotIsValid(before, after, consumed, startOffset))
			throw new TranscriptBudgetError("transcript changed during bounded read");

		let bytes = Buffer.concat(chunks);
		if (startOffset > 0) {
			const prior = Buffer.allocUnsafe(1);
			const priorRead = readSync(fd, prior, 0, 1, startOffset - 1);
			if (priorRead !== 1)
				throw new TranscriptBudgetError(
					"transcript window boundary could not be verified",
				);
			if (prior[0] !== 0x0a) {
				const firstNewline = bytes.indexOf(0x0a);
				if (firstNewline < 0)
					throw new TranscriptBudgetError(
						"transcript window contains no complete JSONL event",
					);
				bytes = bytes.subarray(firstNewline + 1);
			}
			if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
				const lastNewline = bytes.lastIndexOf(0x0a);
				if (lastNewline < 0)
					throw new TranscriptBudgetError(
						"transcript window contains no complete JSONL event",
					);
				bytes = bytes.subarray(0, lastNewline + 1);
			}
			if (bytes.length === 0)
				throw new TranscriptBudgetError(
					"transcript window contains no complete JSONL event",
				);
		}
		return {
			text: bytes.toString("utf8"),
			readBytes: snapshotSize,
			windowed: startOffset > 0,
		};
	} finally {
		closeSync(fd);
	}
}

function parseSession(
	session: SessionFile,
	maxBytes: number,
): { trace: Trace; windowed: boolean } {
	let remaining = maxBytes;
	let pathsRemaining = 1 + session.subagentPaths.length;
	let windowed = false;
	const read = (path: string): string => {
		const allocation = Math.floor(remaining / pathsRemaining);
		if (allocation < 1)
			throw new TranscriptBudgetError(
				"aggregate transcript components exceed the byte budget",
			);
		const result = readBounded(path, allocation);
		remaining -= result.readBytes;
		pathsRemaining -= 1;
		windowed ||= result.windowed;
		return result.text;
	};
	if (session.harness === "codex")
		return { trace: parseCodexTranscript(read(session.path)), windowed };
	const main = read(session.path);
	const sidechains = session.subagentPaths.map(read);
	return {
		trace: parseClaudeCodeTranscript(main, sidechains),
		windowed,
	};
}

function oversizeEvent(session: SessionFile, limit: number): HubEvent {
	return {
		source: session.harness === "codex" ? "codex" : "cc",
		level: "urgent",
		title: "Watchdog: transcript window could not be verified",
		body: `The active transcript did not expose a stable, complete JSONL window within the ${limit}-byte watchdog ceiling. Detection is fail-closed until a verifiable event boundary is available. Transcript: ${session.path}`,
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
		windowedSessions: 0,
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
			const parsed = parseSession(session, config.maxSessionBytes);
			trace = parsed.trace;
			if (parsed.windowed) report.windowedSessions += 1;
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
