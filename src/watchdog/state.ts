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
}

export interface WatchdogState {
	sessions: Record<string, SessionAlerts>;
}

const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function findingKey(finding: Finding): string {
	return `${finding.id}@${finding.severity}`;
}

export function loadState(path: string): WatchdogState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as WatchdogState).sessions === "object" &&
			(parsed as WatchdogState).sessions !== null
		) {
			return parsed as WatchdogState;
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

/** Drop sessions untouched for a week; they will never re-enter the window. */
export function pruneState(state: WatchdogState, nowMs: number): void {
	for (const [path, entry] of Object.entries(state.sessions)) {
		if (nowMs - entry.updatedMs > STATE_MAX_AGE_MS) {
			delete state.sessions[path];
		}
	}
}
