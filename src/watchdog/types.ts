/**
 * Fleet watchdog: live counterpart to the forensic replay viewer.
 *
 * Re-scans recently-written CC / Codex transcripts on an interval, runs the
 * same parsers + detector engine the viewer uses, and posts NEW findings to
 * notification-hub. Alert-only by design — the watchdog never kills, pauses,
 * or mutates a session; the hub's own classification/suppression pipeline
 * decides how loud each event gets.
 */

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
	/** notification-hub base URL, e.g. http://127.0.0.1:9199 */
	hubUrl: string;
	/** Exact notification-hub producer identity. */
	hubProducerId: string;
	/** Owner-private, non-symlinked bearer-token file. */
	hubTokenFile: string;
	/** Only sessions written within this many minutes are scanned. */
	windowMinutes: number;
	/**
	 * Silence required before silent_stall may alert: a Codex session "ends" in
	 * the parser's eyes on every event, so quiescence is the real end-of-run
	 * signal and a short pause must not read as a stall.
	 */
	stallQuietSeconds: number;
	/** Skip transcripts larger than this (pathological-file defense). */
	maxSessionBytes: number;
	/** Dedupe-state JSON path. */
	statePath: string;
	/** Log would-be alerts instead of posting them. */
	dryRun: boolean;
}

/** notification-hub POST /events payload (models.py Event). */
export interface HubEvent {
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
	scannedSessions: number;
	skippedOversize: number;
	/** In-window sessions skipped: unchanged mtime and nothing pending. */
	skippedUnchanged: number;
	parseFailures: number;
	findings: number;
	alertsPosted: number;
	alertsDeduped: number;
	alertsHeld: number;
	postFailures: number;
	/** Notification Hub event ids from accepted machine-readable receipts. */
	acceptedEventIds: string[];
}
