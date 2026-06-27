/**
 * Cross-tool entry point: sniff which harness produced a transcript, then route
 * to the matching parser. One call ingests a Claude Code `.jsonl` or a Codex
 * `rollout-*.jsonl` and returns the same plumbline Trace — the cross-tool view
 * the UI and detector engine sit on top of.
 */

import { parseJsonl } from "./jsonl.ts";
import { parseClaudeCodeTranscript } from "./parsers/claude-code.ts";
import { parseCodexTranscript } from "./parsers/codex.ts";
import type { Trace } from "./types.ts";

export type Harness = "claude-code" | "codex" | "unknown";

/** Codex envelopes carry one of these top-level `type`s; Claude Code never does. */
const CODEX_TYPES = new Set([
	"session_meta",
	"response_item",
	"event_msg",
	"turn_context",
	"compacted",
]);
/** Claude Code events carry one of these top-level `type`s. */
const CC_TYPES = new Set(["assistant", "user", "system"]);

/** Sniff the harness from the first handful of parseable events. */
export function detectHarness(text: string): Harness {
	const events = parseJsonl(text).slice(0, 25);
	for (const ev of events) {
		if (typeof ev !== "object" || ev === null) continue;
		const e = ev as Record<string, unknown>;
		const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
		// Codex: envelope { timestamp, type, payload } with a known type.
		if (CODEX_TYPES.has(type) && "payload" in e) return "codex";
		// Claude Code: an event type plus a session/uuid marker.
		if (CC_TYPES.has(type) && ("sessionId" in e || "uuid" in e))
			return "claude-code";
	}
	return "unknown";
}

export interface ParsedTranscript {
	harness: Harness;
	trace: Trace;
}

/**
 * Parse any supported transcript, auto-detecting the harness. `subagentTexts`
 * (Claude Code sidechains) are merged when the source is Claude Code; Codex has
 * no sidechain files so they are ignored there.
 */
export function parseTranscript(
	mainText: string,
	subagentTexts: readonly string[] = [],
): ParsedTranscript {
	const harness = detectHarness(mainText);
	if (harness === "codex") {
		return { harness, trace: parseCodexTranscript(mainText) };
	}
	// Default to the Claude Code parser (also handles the "unknown" best-effort).
	return {
		harness: harness === "claude-code" ? "claude-code" : harness,
		trace: parseClaudeCodeTranscript(mainText, subagentTexts),
	};
}
