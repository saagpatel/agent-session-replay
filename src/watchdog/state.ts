/**
 * Dedupe state: which (session, finding, severity) triples already alerted.
 *
 * Keyed on severity too, so a finding that escalates (grind loop crossing
 * warning -> critical) re-alerts once at the new tier instead of staying
 * suppressed under its warning-level entry.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Finding } from "../core/detect/types.ts";
import { eventIdFor } from "./policy.ts";

interface SessionAlerts {
	findings: string[];
	updatedMs: number;
	/** mtime of the transcript when it was last parsed; unchanged -> skippable. */
	processedMtimeMs?: number;
	/** Held findings or failed posts from the last pass: never skip these. */
	pending?: boolean;
	/** Exact JSON sent for unacknowledged findings, keyed by finding + severity. */
	pendingPayloads?: Record<string, string>;
}

export interface WatchdogState {
	sessions: Record<string, SessionAlerts>;
}

export const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_PAYLOAD_BYTES = 16 * 1024;
export const MAX_RETAINED_PAYLOAD_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validPayload(sessionPath: string, key: string, payload: unknown): payload is string {
	if (!key.length || key.length > 200 || typeof payload !== "string" ||
		Buffer.byteLength(payload) > MAX_PENDING_PAYLOAD_BYTES)
		return false;
	try {
		const event: unknown = JSON.parse(payload);
		return isRecord(event) &&
			event.event_id === eventIdFor(sessionPath, key) &&
			(event.source === "cc" || event.source === "codex") &&
			(event.level === "urgent" || event.level === "normal" || event.level === "info") &&
			typeof event.title === "string" && typeof event.body === "string" &&
			(event.project === undefined || typeof event.project === "string") &&
			(event.session_label === undefined || typeof event.session_label === "string") &&
			(event.dedupe_key === undefined || (typeof event.dedupe_key === "string" &&
				event.dedupe_key.length > 0 && event.dedupe_key.length <= 200)) &&
			(event.intent === undefined || event.intent === "needs_attention") &&
			isRecord(event.context) && Object.values(event.context).every(value =>
				typeof value === "string" || typeof value === "boolean" ||
				(typeof value === "number" && Number.isFinite(value)));
	} catch {
		return false;
	}
}

function parseSessionAlerts(sessionPath: string, value: unknown): SessionAlerts | null {
	if (!isRecord(value)) return null;
	if (
		!Array.isArray(value.findings) ||
		!value.findings.every(
			(item): item is string => typeof item === "string" && item.length > 0,
		) ||
		!isFiniteNonNegative(value.updatedMs) ||
		(value.processedMtimeMs !== undefined &&
			!isFiniteNonNegative(value.processedMtimeMs)) ||
		(value.pending !== undefined && typeof value.pending !== "boolean")
	) {
		return null;
	}
	const findings = value.findings;
	if (value.pendingPayloads !== undefined) {
		if (!isRecord(value.pendingPayloads)) return null;
		const payloads = Object.entries(value.pendingPayloads);
		if (payloads.some(([key, payload]) =>
			findings.includes(key) ||
			!validPayload(sessionPath, key, payload))) return null;
		// A payload may outlive its pending finding: it stays until acknowledged,
		// so a recurrence replays the same bytes under the same event ID.
	}

	return {
		findings: [...value.findings],
		updatedMs: value.updatedMs,
		...(value.processedMtimeMs === undefined
			? {}
			: { processedMtimeMs: value.processedMtimeMs }),
		...(value.pending === undefined ? {} : { pending: value.pending }),
		...(value.pendingPayloads === undefined ? {} : {
			pendingPayloads: Object.fromEntries(Object.entries(value.pendingPayloads)) as Record<string, string>,
		}),
	};
}

export function findingKey(finding: Finding): string {
	return `${finding.id}@${finding.severity}`;
}

export function loadState(path: string): WatchdogState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isRecord(parsed) && isRecord(parsed.sessions)) {
			let retainedBytes = 0;
			const sessions = Object.fromEntries(
				Object.entries(parsed.sessions).flatMap(([sessionPath, entry]) => {
					const validated = parseSessionAlerts(sessionPath, entry);
					if (!sessionPath.length || !validated) return [];
					const bytes = payloadBytes(validated);
					if (retainedBytes + bytes > MAX_RETAINED_PAYLOAD_BYTES) return [];
					retainedBytes += bytes;
					return [[sessionPath, validated] as const];
				}),
			);
			return { sessions };
		}
	} catch {
		// missing or corrupt -> start clean; worst case is one repeat alert
	}
	return { sessions: {} };
}

/** Atomic write (tmp + rename) so a crash mid-save never corrupts the state. */
export function saveState(path: string, state: WatchdogState): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, "\t"));
	renameSync(tmp, path);
}

export function hasAlerted(
	state: WatchdogState,
	sessionPath: string,
	key: string,
): boolean {
	return state.sessions[sessionPath]?.findings.includes(key) ?? false;
}

export function markAlerted(
	state: WatchdogState,
	sessionPath: string,
	key: string,
	nowMs: number,
): void {
	const entry = state.sessions[sessionPath] ?? {
		findings: [],
		updatedMs: nowMs,
	};
	if (!entry.findings.includes(key)) entry.findings.push(key);
	dropPendingPayload(state, sessionPath, key);
	entry.updatedMs = nowMs;
	state.sessions[sessionPath] = entry;
}

/** True when the session can be skipped: transcript unchanged since it was
 * last parsed AND nothing from that pass (held finding, failed post) is
 * waiting on time or the local adapter to handle an attempt. */
export function canSkip(
	state: WatchdogState,
	sessionPath: string,
	mtimeMs: number,
): boolean {
	const entry = state.sessions[sessionPath];
	// A retained payload alone does not force a re-parse: its finding can only
	// recur through new transcript content, which changes mtime.
	return entry?.processedMtimeMs === mtimeMs && !entry.pending;
}

function payloadBytes(entry: SessionAlerts): number {
	return Object.values(entry.pendingPayloads ?? {})
		.reduce((bytes, payload) => bytes + Buffer.byteLength(payload), 0);
}

export function pendingPayloadFor(state: WatchdogState, sessionPath: string, key: string): string | undefined {
	return state.sessions[sessionPath]?.pendingPayloads?.[key];
}

export function dropPendingPayload(state: WatchdogState, sessionPath: string, key: string): void {
	const entry = state.sessions[sessionPath];
	if (entry?.pendingPayloads) {
		delete entry.pendingPayloads[key];
		if (Object.keys(entry.pendingPayloads).length === 0) delete entry.pendingPayloads;
	}
}

export function retainedPayloadStats(state: WatchdogState): {
	retainedPayloads: number; retainedPayloadBytes: number;
} {
	return Object.values(state.sessions).reduce((stats, entry) => ({
		retainedPayloads: stats.retainedPayloads + Object.keys(entry.pendingPayloads ?? {}).length,
		retainedPayloadBytes: stats.retainedPayloadBytes + payloadBytes(entry),
	}), { retainedPayloads: 0, retainedPayloadBytes: 0 });
}

export function pendingPayloadError(
	state: WatchdogState, sessionPath: string, key: string, payload: string,
): "payload invalid" | "retention cap reached" | undefined {
	const existing = pendingPayloadFor(state, sessionPath, key);
	if (existing !== undefined) return existing === payload ? undefined : "payload invalid";
	if (!validPayload(sessionPath, key, payload) || hasAlerted(state, sessionPath, key))
		return "payload invalid";
	if (retainedPayloadStats(state).retainedPayloadBytes + Buffer.byteLength(payload) > MAX_RETAINED_PAYLOAD_BYTES)
		return "retention cap reached";
	return undefined;
}

/** Bound retention by refusing new sends, never evicting an unknown attempt. */
export function retainPendingPayload(
	state: WatchdogState, sessionPath: string, key: string, payload: string, nowMs: number,
): boolean {
	if (pendingPayloadError(state, sessionPath, key, payload)) return false;
	if (pendingPayloadFor(state, sessionPath, key) !== undefined) return true;
	const entry = state.sessions[sessionPath] ?? { findings: [], updatedMs: nowMs };
	entry.pendingPayloads = { ...entry.pendingPayloads, [key]: payload };
	entry.pending = true;
	entry.updatedMs = nowMs;
	state.sessions[sessionPath] = entry;
	return true;
}

/** Record the parse pass; returns whether the entry actually changed so the
 * caller can decide if the state file needs rewriting. */
export function markProcessed(
	state: WatchdogState,
	sessionPath: string,
	mtimeMs: number,
	pending: boolean,
	nowMs: number,
): boolean {
	const entry = state.sessions[sessionPath] ?? {
		findings: [],
		updatedMs: nowMs,
	};
	const changed =
		entry.processedMtimeMs !== mtimeMs || (entry.pending ?? false) !== pending;
	if (changed) {
		entry.processedMtimeMs = mtimeMs;
		entry.pending = pending;
		entry.updatedMs = nowMs;
	}
	state.sessions[sessionPath] = entry;
	return changed;
}

/** Drop sessions untouched for a week; they will never re-enter the window.
 * A session holding an unacknowledged payload is kept: a resumed session must
 * replay those bytes, and the retained-payload cap bounds what this keeps.
 * Returns the number of entries removed. */
export function pruneState(state: WatchdogState, nowMs: number): number {
	let removed = 0;
	for (const [path, entry] of Object.entries(state.sessions)) {
		if (Object.keys(entry.pendingPayloads ?? {}).length) continue;
		if (nowMs - entry.updatedMs > STATE_MAX_AGE_MS) {
			delete state.sessions[path];
			removed += 1;
		}
	}
	return removed;
}
