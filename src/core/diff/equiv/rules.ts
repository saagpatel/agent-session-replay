import type { CanonicalEvent, RuleId } from "./types.ts";

/** Public documentation: every original member is retained; there is no noise-drop. */
export const RULES: ReadonlyArray<{
	id: RuleId;
	description: string;
	example: string;
}> = [
	{
		id: "read-coalesce",
		description: "Allowlist only: structured Read/read_file with known keys, or an entire literal sed -n 'N,Mp' file, sed -n 'Np' file, head -n N file, or cat file (plain command or exact sh/bash/zsh -c/-lc argv). Union successful overlapping/adjacent ranges of one file across commuting events. Whole-file-or-unknown reads require identical evidence. Unsupported sources are global barriers and make comparison incomplete.",
		example: "read a:1-10, read b:1-5, read a:11-20 => read a:1-20, read b:1-5",
	},
	{
		id: "search-dedupe",
		description: "Allowlist only: structured Grep/Glob with documented keys, or an entire literal rg command with only -n -i -w -l -F --no-heading flags, or grep -rn, with plain pattern/path tokens. Shell commands permit no quoting, expansion, chaining or redirects; only exact sh/bash/zsh -c/-lc argv wrappers are unwrapped. Merge identical successful searches across commuting events; retain every member.",
		example: "Grep(pattern=token, path=src), Read(b), Grep(pattern=token, path=src) => one search plus Read(b)",
	},
	{
		id: "edit-batch",
		description: "Allowlist only: structured Edit/MultiEdit with known keys and replace_all omitted or false; structured Write/write_file use exact content and stay separate. Batch consecutive successful replacements of one file only when sequential composition matches the other side. Failed/unknown observations never merge. Tests/runs retain normalized signatures and are global barriers; only explicitly empty write_stdin status polls may be ignored.",
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
