/**
 * Parse JSONL transcript text into a list of raw records.
 *
 * Defensive by design: a single malformed line never aborts the parse, because
 * real Claude Code and Codex transcripts occasionally contain truncated or
 * partial lines (interrupted writes, crashes). Blank lines and CRLF endings are
 * tolerated. Returns `unknown[]`; the per-harness parsers narrow from there.
 */
export interface JsonlParseResult {
	records: unknown[];
	/** Non-blank lines that failed to parse — surfaced so the UI can warn rather
	 * than silently under-report (forensic completeness). */
	malformed: number;
}

/** Parse JSONL and report how many non-blank lines were unparseable. */
export function parseJsonlWithStats(text: string): JsonlParseResult {
	const records: unknown[] = [];
	let malformed = 0;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			malformed += 1; // skipped, not fatal — but counted.
		}
	}
	return { records, malformed };
}

export function parseJsonl(text: string): unknown[] {
	return parseJsonlWithStats(text).records;
}
