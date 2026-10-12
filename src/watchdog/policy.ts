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

/** Bind the existing watchdog dedupe tuple to an adapter-stable event ID. */
export function eventIdFor(sessionPath: string, findingKey: string): string {
	const digest = createHash("sha256")
		.update(`${sessionPath}\x00${findingKey}`, "utf8")
		.digest("hex");
	return `agent-watchdog:${digest}`;
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
	return {
		event_id: eventIdFor(session.path, `${finding.id}@${finding.severity}`),
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
	};
}
