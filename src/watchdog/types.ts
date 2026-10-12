/**
 * Fleet watchdog: live counterpart to the forensic replay viewer.
 *
 * Re-scans recently-written CC / Codex transcripts on an interval, runs the
 * same parsers + detector engine the viewer uses, and sends NEW findings to
 * the bounded local notification adapter. Alert-only by design — the
 * watchdog never kills, pauses, or mutates a session.
 */

import type { TickFailureProgress } from "./progress.ts";

export type Harness = "claude-code" | "codex";

/** One discoverable session transcript (plus CC subagent sidechains). */
export interface SessionFile {
	harness: Harness;
	/** Absolute path to the main transcript (also the dedupe key). */
	path: string;
	/** CC subagent sidechain transcripts merged into the parse. */
	subagentPaths: string[];
	/** Newest write across main + sidechains, ms epoch. */
	mtimeMs: number;
	/** Total bytes across main + sidechains. */
	sizeBytes: number;
}

export interface WatchdogConfig {
	/** ~/.claude/projects */
	claudeProjectsDir: string;
	/** ~/.codex/sessions */
	codexSessionsDir: string;
	/** Stable executable for the daemonless local notification adapter. */
	localAdapterPath: string;
	/** Adapter-owned owner-private receipt store. */
	localReceiptStore: string;
	/** Only sessions written within this many minutes are scanned. */
	windowMinutes: number;
	/**
	 * Silence required before silent_stall may alert: a Codex session "ends" in
	 * the parser's eyes on every event, so quiescence is the real end-of-run
	 * signal and a short pause must not read as a stall.
	 */
	stallQuietSeconds: number;
	/** Aggregate per-session read ceiling; larger JSONL inputs use recent windows. */
	maxSessionBytes: number;
	/** Dedupe-state JSON path. */
	statePath: string;
	/** Log would-be alerts instead of posting them. */
	dryRun: boolean;
}

/** Local infrastructure event payload consumed by the adapter. */
export interface NotificationEvent {
	/** Stable retry identity; replays with changed payload are refused by the adapter. */
	event_id?: string;
	/** Bounded adapter policy group, separate from stable retry identity. */
	dedupe_key?: string;
	source: "cc" | "codex";
	level: "urgent" | "normal" | "info";
	title: string;
	body: string;
	project?: string;
	session_label?: string;
	intent?: "needs_attention";
	context: Record<string, string | number | boolean>;
}

export interface TickReport {
	/** Immutable outcome observations; excludes payloads and transcript paths. */
	progress?: TickFailureProgress;
	scannedSessions: number;
	/** Sessions parsed from a newline-aligned recent window under the byte ceiling. */
	windowedSessions: number;
	skippedOversize: number;
	/** In-window sessions skipped: unchanged mtime and nothing pending. */
	skippedUnchanged: number;
	parseFailures: number;
	findings: number;
	alertsPosted: number;
	alertsDeduped: number;
	alertsHeld: number;
	postFailures: number;
	/** Adapter outcomes that can never be retried under this stable event ID. */
	terminalFailures: number;
	retainedPayloads: number;
	retainedPayloadBytes: number;
	/** Retention is full, or a new payload stayed blocked after safe eviction. */
	retentionCapReached: boolean;
	/** Stable event IDs from handled local adapter receipts. */
	acceptedEventIds: string[];
}
