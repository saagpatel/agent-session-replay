/**
 * Live-mode policy: which findings are alertable on a session that may still
 * be running, and how a Finding becomes a notification-hub Event.
 *
 * The detector engine is forensic — it judges a complete trace. Two findings
 * change meaning mid-flight and are gated here rather than forked in the
 * engine: incomplete_run is true of every live session (never alert), and
 * silent_stall needs real quiescence before "no tool activity" means stalled
 * rather than "still thinking".
 */

import type { Finding, Severity } from "../core/detect/types.ts";
import type { HubEvent, SessionFile } from "./types.ts";

export type LiveVerdict = "alert" | "hold" | "never";

export function liveVerdict(
	finding: Finding,
	quietMs: number,
	stallQuietMs: number,
): LiveVerdict {
	if (finding.kind === "incomplete_run") return "never";
	if (finding.kind === "silent_stall") {
		return quietMs >= stallQuietMs ? "alert" : "hold";
	}
	return "alert";
}

const LEVEL_BY_SEVERITY: Record<Severity, HubEvent["level"]> = {
	critical: "urgent",
	warning: "normal",
	info: "info",
};

/** The hub rejects control characters in text fields; flatten to one line. */
function sanitize(text: string, max: number): string {
	const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function lastSegment(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function buildEvent(
	finding: Finding,
	session: SessionFile,
	cwd: string | null | undefined,
): HubEvent {
	const source: HubEvent["source"] =
		session.harness === "codex" ? "codex" : "cc";
	return {
		source,
		level: LEVEL_BY_SEVERITY[finding.severity],
		title: sanitize(`Watchdog: ${finding.title}`, 200),
		body: sanitize(`${finding.detail} Transcript: ${session.path}`, 2000),
		...(cwd ? { project: lastSegment(cwd) } : {}),
		session_label: lastSegment(session.path),
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
