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
import { buildEvent, liveVerdict, withEventId } from "./policy.ts";
import { scanSessions } from "./scan.ts";
import { eventStatus, isTerminalFailure, postEvent, type PostResult } from "./sink.ts";
import {
	canSkip,
	dropPendingPayload,
	findingKey,
	hasAlerted,
	loadState,
	markAlerted,
	markProcessed,
	MAX_RETAINED_PAYLOAD_BYTES,
	pendingPayloadFor,
	pendingPayloadError,
	pruneState,
	retainPendingPayload,
	retainedPayloadStats,
	saveState,
	STATE_MAX_AGE_MS,
} from "./state.ts";
import type {
	NotificationEvent,
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

function oversizeEvent(session: SessionFile, limit: number): NotificationEvent {
	return withEventId(session.path, "transcript_budget_exceeded@critical", {
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
	});
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
		terminalFailures: 0,
		retainedPayloads: 0,
		retainedPayloadBytes: 0,
		retentionCapReached: false,
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
	const sessionsByPath = new Map(sessions.map(session => [session.path, session]));
	// Missing observations (including parse failures) cannot prove resolution.
	const observedKeys = new Map<string, Set<string> | undefined>();
	const statusResults = new Map<string, PostResult>();
	const applyOutcome = (path: string, key: string, result: PostResult): boolean => {
		if (result.ok && result.eventId) {
			const payload = pendingPayloadFor(state, path, key);
			if (payload) {
				const event = JSON.parse(payload) as NotificationEvent;
				console.log(`watchdog: handled ${event.level} '${event.title}' (state=${result.state})`);
			}
			markAlerted(state, path, key, nowMs);
			dirty = true;
			report.alertsPosted += 1;
			report.acceptedEventIds.push(result.eventId);
			return true;
		}
		if (isTerminalFailure(result)) {
			console.error(
				`watchdog: TERMINAL notification failure for ${key} (state=${result.state ?? "changed_payload_rejection"}, exit=${result.status ?? "no-response"}): ${result.error ?? ""}; will not retry`,
			);
			markAlerted(state, path, key, nowMs);
			dirty = true;
			report.terminalFailures += 1;
			return true;
		}
		return false;
	};
	const keysFor = (session: SessionFile): Set<string> | undefined => {
		if (!observedKeys.has(session.path)) {
			try {
				const { trace } = parseSession(session, config.maxSessionBytes);
				observedKeys.set(session.path, new Set(detect(trace).map(findingKey)));
			} catch {
				// A coverage/budget failure cannot prove an older finding disappeared.
				observedKeys.set(session.path, undefined);
			}
		}
		return observedKeys.get(session.path);
	};
	const evictObsoletePayloads = async (weeklyOnly: boolean): Promise<void> => {
		if (config.dryRun) return; // even status may create the adapter's store
		for (const [path, entry] of Object.entries(state.sessions)) {
			if (weeklyOnly && nowMs - entry.updatedMs <= STATE_MAX_AGE_MS) continue;
			for (const key of Object.keys(entry.pendingPayloads ?? {})) {
				const session = sessionsByPath.get(path);
				if (session) {
					const keys = keysFor(session);
					if (keys === undefined || keys.has(key)) continue;
				}
				// Retained bytes carry the ID they were (or may have been) sent under.
				const retained = pendingPayloadFor(state, path, key);
				if (retained === undefined) continue;
				const id = (JSON.parse(retained) as NotificationEvent).event_id!;
				let result = statusResults.get(id);
				if (!result) {
					result = await eventStatus(config.localAdapterPath, id, config.localReceiptStore);
					statusResults.set(id, result);
				}
				if (result.status === 0 && result.eventId === id && result.state === "not_found") {
					dropPendingPayload(state, path, key);
					dirty = true;
				} else if (result.status !== 0 || result.eventId !== id || !applyOutcome(path, key, result)) {
					console.error(`watchdog: retained ${key}; status unresolved (state=${result.state ?? "no-response"}, exit=${result.status ?? "no-response"}): ${result.error ?? ""}`);
				}
			}
		}
	};
	let capEvictionAttempted = false;
	const reportRetentionCap = (): void => {
		if (report.retentionCapReached) return;
		report.retentionCapReached = true;
		const stats = retainedPayloadStats(state);
		console.error(`watchdog: retention cap reached (${stats.retainedPayloads} payloads, ${stats.retainedPayloadBytes} bytes); operator action required; new sends blocked`);
	};
	const postPending = async (
		session: SessionFile, key: string, createEvent: () => NotificationEvent,
	): Promise<PostResult> => {
		const payload = pendingPayloadFor(state, session.path, key) ??
			JSON.stringify(createEvent());
		let error = pendingPayloadError(state, session.path, key, payload);
		if (error === "retention cap reached" && !capEvictionAttempted) {
			capEvictionAttempted = true;
			await evictObsoletePayloads(false);
			error = pendingPayloadError(state, session.path, key, payload);
		}
		if (error) {
			if (error === "retention cap reached") reportRetentionCap();
			return { ok: false, error };
		}
		retainPendingPayload(state, session.path, key, payload, nowMs);
		// Save BEFORE sending: a lost receipt, crash, or failed acknowledgement
		// write must leave the exact first payload available to the next tick.
		// If this write fails, do not invoke the adapter.
		saveState(config.statePath, state);
		return postEvent(config.localAdapterPath, payload, config.localReceiptStore);
	};

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
				observedKeys.set(session.path, undefined);
				report.skippedOversize += 1;
				const key = "transcript_budget_exceeded@critical";
				if (!hasAlerted(state, session.path, key)) {
					if (config.dryRun) {
						if (pendingPayloadFor(state, session.path, key) !== undefined) {
							console.log(`watchdog[dry-run]: live attempt pending for ${key}; left untouched`);
							// Coverage checks stay pending below, including this live payload.
						} else {
							const event = oversizeEvent(session, config.maxSessionBytes);
							console.log(`watchdog[dry-run]: ${event.level} ${event.title}`);
							markAlerted(state, session.path, key, nowMs);
							dirty = true;
							report.alertsPosted += 1;
						}
					} else {
						const result = await postPending(
							session, key, () => oversizeEvent(session, config.maxSessionBytes),
						);
						if (!applyOutcome(session.path, key, result)) {
							report.postFailures += 1;
							console.error(
								`watchdog: post failed (${result.status ?? "no-response"}): ${result.error ?? ""}`,
							);
						}
					}
				} else {
					report.alertsDeduped += 1;
				}
				// Keep retrying coverage checks even once the budget alert is handled.
				dirty = markProcessed(state, session.path, session.mtimeMs, true, nowMs) || dirty;
				continue;
			}
			observedKeys.set(session.path, undefined);
			report.parseFailures += 1;
			console.error(
				`watchdog: parse failed for ${session.path}: ${String(err)}`,
			);
			continue;
		}

		const findings = detect(trace);
		observedKeys.set(session.path, new Set(findings.map(findingKey)));
		report.findings += findings.length;
		const quietMs = nowMs - session.mtimeMs;
		// Retain unresolved payloads until status proves safe eviction or a final
		// disposition. A recurrence must otherwise replay the same exact bytes.
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

			if (config.dryRun) {
				// A live attempt awaiting acknowledgement owns this key: a dry run must
				// not mark it alerted, which would drop the payload a retry replays.
				if (pendingPayloadFor(state, session.path, key) !== undefined) {
					console.log(`watchdog[dry-run]: live attempt pending for ${key}; left untouched`);
					held += 1; // keep the session pending so the next live tick retries it
					continue;
				}
				const event = buildEvent(finding, session, trace.run.workspace?.cwd);
				console.log(`watchdog[dry-run]: ${event.level} ${event.title}`);
				markAlerted(state, session.path, key, nowMs);
				dirty = true;
				report.alertsPosted += 1;
				continue;
			}
			const result = await postPending(
				session, key, () => buildEvent(finding, session, trace.run.workspace?.cwd),
			);
			if (!applyOutcome(session.path, key, result)) {
				// Not marked alerted -> retry the retained payload next tick.
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

	await evictObsoletePayloads(true);
	if (!config.dryRun) {
		const pruned = pruneState(state, nowMs);
		if (dirty || pruned > 0) saveState(config.statePath, state);
	}
	Object.assign(report, retainedPayloadStats(state));
	if (report.retainedPayloadBytes >= MAX_RETAINED_PAYLOAD_BYTES) reportRetentionCap();
	return report;
}
