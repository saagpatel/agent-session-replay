import type { CanonicalEvent, RuleId } from "./types.ts";

/** Public documentation: every original member is retained; there is no noise-drop. */
export const RULES: ReadonlyArray<{
	id: RuleId;
	description: string;
	example: string;
}> = [
	{
		id: "read-coalesce",
		description: "Union overlapping or adjacent reads of the same file across commuting reads/searches or unrelated known file edits. Whole-file-or-unknown reads merge only with identical source arguments. Keep the first member's position.",
		example: "read a:1-10, read b:1-5, read a:11-20 => read a:1-20, read b:1-5",
	},
	{
		id: "search-dedupe",
		description: "Merge identical enriched searches (query, path and options) with no intervening mutation. Every repeated search remains an expandable member.",
		example: "Grep(pattern=token, path=src), Read(b), Grep(pattern=token, path=src) => one search plus Read(b)",
	},
	{
		id: "edit-batch",
		description: "Batch consecutive successful replacements of one file only when their sequential composition matches the other side: compare composed old/new text on a connected touched region, or an identical ordered replacement list for disjoint regions. Unproven writes stay separate.",
		example: "Edit(a, old=x, new=y), Edit(a, old=y, new=z) <=> MultiEdit(a, x=>y, y=>z)",
	},
];

const observes = (e: CanonicalEvent) => e.action === "read" || e.action === "search";
const fileMutation = (e: CanonicalEvent) => e.action === "edit" || e.action === "write";

/**
 * The sole order guard. Observations commute; two mutators never do. A known,
 * successful file edit can commute only with a read of a distinct known file.
 * Search scope is conservatively global (a directory search can see any file).
 * Tests, runs, delegates, blocked/unknown commands and unknown-status mutations
 * are global barriers. Other actions also stay in their recorded order.
 */
export function canCommute(a: CanonicalEvent, b: CanonicalEvent): boolean {
	if (observes(a) && observes(b)) return true;
	const read = observes(a) ? a : observes(b) ? b : null;
	const mutation = read === a ? b : a;
	return read?.action === "read" && fileMutation(mutation) && mutation.status === "ok" &&
		read.target !== null && mutation.target !== null && read.target !== mutation.target;
}
