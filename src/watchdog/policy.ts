/**
 * Live-mode policy: which findings are alertable on a session that may still
 * be running, and how a Finding becomes a local infrastructure event.
 *
 * The detector engine is forensic — it judges a complete trace. Two findings
 * change meaning mid-flight and are gated here rather than forked in the
 * engine: incomplete_run is true of every live session (never alert), and
 * silent_stall needs real quiescence before "no tool activity" means stalled
 * rather than "still thinking".
 */

import { basename } from "node:path";
import { createHash } from "node:crypto";

import type { Finding, Severity } from "../core/detect/types.ts";
import type { NotificationEvent, SessionFile } from "./types.ts";

export type LiveVerdict = "alert" | "hold" | "never";

/** Mirrors the local notifier's approved watchdog detectors. */
export const ALERTABLE_DETECTORS: ReadonlySet<string> = new Set([
	"grind_loop",
	"silent_stall",
	"transcript_budget_exceeded",
]);

export function liveVerdict(
	finding: Finding,
	quietMs: number,
	stallQuietMs: number,
): LiveVerdict {
	if (!ALERTABLE_DETECTORS.has(finding.kind)) return "never";
	if (finding.kind === "silent_stall") {
		return quietMs >= stallQuietMs ? "alert" : "hold";
	}
	return "alert";
}

const LEVEL_BY_SEVERITY: Record<Severity, NotificationEvent["level"]> = {
	critical: "urgent",
	warning: "normal",
	info: "info",
};

/** Bounded digest of the watchdog dedupe tuple: the adapter's policy group,
 * and the event ID of payloads retained before IDs were content-bound. */
export function eventIdFor(sessionPath: string, findingKey: string): string {
	const digest = createHash("sha256")
		.update(`${sessionPath}\x00${findingKey}`, "utf8")
		.digest("hex");
	return `agent-watchdog:${digest}`;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * The adapter binds an event ID to its first payload forever and has no update
 * operation, so the ID covers the content: a changed finding is a new event
 * (dedupe_key still groups it), while a retry of retained bytes keeps its ID.
 */
export function contentEventId(
	sessionPath: string, findingKey: string, event: Omit<NotificationEvent, "event_id">,
): string {
	const { event_id: _ignored, ...content } = event as NotificationEvent;
	const digest = createHash("sha256")
		.update(`${sessionPath}\x00${findingKey}\x00${canonicalJson(content)}`, "utf8")
		.digest("hex");
	return `agent-watchdog:${digest}`;
}

export function withEventId(
	sessionPath: string, findingKey: string, event: Omit<NotificationEvent, "event_id">,
): NotificationEvent {
	return { event_id: contentEventId(sessionPath, findingKey, event), ...event };
}

/** Keep event text single-line and bounded before it reaches the adapter. */
function sanitize(text: string, max: number): string {
	const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function buildEvent(
	finding: Finding,
	session: SessionFile,
	cwd: string | null | undefined,
): NotificationEvent {
	const source: NotificationEvent["source"] =
		session.harness === "codex" ? "codex" : "cc";
	return withEventId(session.path, `${finding.id}@${finding.severity}`, {
		// Hash the full tuple to stay bounded even for long session paths/kinds.
		// Adapter policy severity alone does not distinguish warning/critical.
		dedupe_key: eventIdFor(session.path, `${finding.kind}@${finding.severity}`),
		source,
		level: LEVEL_BY_SEVERITY[finding.severity],
		title: sanitize(`Watchdog: ${finding.title}`, 200),
		body: sanitize(`${finding.detail} Transcript: ${session.path}`, 2000),
		// project/session_label share title/body's sanitizing so event identity
		// stays bounded and deterministic across adapter replays.
		...(cwd ? { project: sanitize(basename(cwd), 100) } : {}),
		session_label: sanitize(basename(session.path), 200),
		intent: "needs_attention",
		context: {
			detector: finding.kind,
			severity: finding.severity,
			score: finding.score,
			harness: session.harness,
			transcript_path: session.path,
		},
	});
}
