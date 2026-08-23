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

interface SessionAlerts {
	findings: string[];
	updatedMs: number;
	/** mtime of the transcript when it was last parsed; unchanged -> skippable. */
	processedMtimeMs?: number;
	/** Held findings or failed posts from the last pass: never skip these. */
	pending?: boolean;
}

export interface WatchdogState {
	sessions: Record<string, SessionAlerts>;
}

const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseSessionAlerts(value: unknown): SessionAlerts | null {
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

	return {
		findings: [...value.findings],
		updatedMs: value.updatedMs,
		...(value.processedMtimeMs === undefined
			? {}
			: { processedMtimeMs: value.processedMtimeMs }),
		...(value.pending === undefined ? {} : { pending: value.pending }),
	};
}

export function findingKey(finding: Finding): string {
	return `${finding.id}@${finding.severity}`;
}

export function loadState(path: string): WatchdogState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isRecord(parsed) && isRecord(parsed.sessions)) {
			const sessions = Object.fromEntries(
				Object.entries(parsed.sessions).flatMap(([sessionPath, entry]) => {
					const validated = parseSessionAlerts(entry);
					return sessionPath.length > 0 && validated
						? [[sessionPath, validated] as const]
						: [];
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
	const tmp = `${path}.tmp`;
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
	entry.updatedMs = nowMs;
	state.sessions[sessionPath] = entry;
}

/** True when the session can be skipped: transcript unchanged since it was
 * last parsed AND nothing from that pass (held finding, failed post) is
 * waiting on time or the hub to advance. */
export function canSkip(
	state: WatchdogState,
	sessionPath: string,
	mtimeMs: number,
): boolean {
	const entry = state.sessions[sessionPath];
	return entry?.processedMtimeMs === mtimeMs && !entry.pending;
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
 * Returns the number of entries removed. */
export function pruneState(state: WatchdogState, nowMs: number): number {
	let removed = 0;
	for (const [path, entry] of Object.entries(state.sessions)) {
		if (nowMs - entry.updatedMs > STATE_MAX_AGE_MS) {
			delete state.sessions[path];
			removed += 1;
		}
	}
	return removed;
}
