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

export function recordHarness(record: unknown): Harness {
	if (typeof record !== "object" || record === null || !("type" in record)) return "unknown";
	const type = record.type;
	if (typeof type !== "string") return "unknown";
	if (CODEX_TYPES.has(type) && "payload" in record) return "codex";
	if (type === "data-flow-incomplete") {
		return "sessionId" in record && typeof record.sessionId === "string" && record.sessionId.trim().length > 0 &&
			"uuid" in record && typeof record.uuid === "string" && record.uuid.trim().length > 0
			? "claude-code" : "unknown";
	}
	if (!("sessionId" in record || "uuid" in record)) return "unknown";
	if (CC_TYPES.has(type)) return "claude-code";
	if (type === "permission-mode" && "permissionMode" in record && typeof record.permissionMode === "string")
		return "claude-code";
	if (type === "mode" && "mode" in record && typeof record.mode === "string") return "claude-code";
	return "unknown";
}

/** Sniff the harness from the first identifiable event. */
export function detectHarness(text: string): Harness {
	for (const ev of parseJsonl(text)) {
		const harness = recordHarness(ev);
		if (harness !== "unknown") return harness;
	}
	return "unknown";
}

export interface ParsedTranscript {
	harness: Exclude<Harness, "unknown">;
	trace: Trace;
}

export class UnsupportedTranscriptError extends Error {}

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
	if (harness === "claude-code") {
		return { harness, trace: parseClaudeCodeTranscript(mainText, subagentTexts) };
	}
	throw new UnsupportedTranscriptError("Unsupported transcript format. Expected a Claude Code or Codex transcript.");
}
