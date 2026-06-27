/**
 * Parse JSONL transcript text into a list of raw records.
 *
 * Defensive by design: a single malformed line never aborts the parse, because
 * real Claude Code and Codex transcripts occasionally contain truncated or
 * partial lines (interrupted writes, crashes). Blank lines and CRLF endings are
 * tolerated. Returns `unknown[]`; the per-harness parsers narrow from there.
 */
export function parseJsonl(text: string): unknown[] {
	const records: unknown[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			// A malformed line is skipped, not fatal.
		}
	}
	return records;
}
