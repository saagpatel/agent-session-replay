import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Tool = { name: string; args: Record<string, unknown>; result?: string; error?: boolean };
type Pair = {
	slug: string;
	label: "equivalent" | "divergent";
	category: string;
	why: string;
	left: { harness: "claude-code" | "codex"; tools: Tool[] };
	right: { harness: "claude-code" | "codex"; tools: Tool[] };
};

const read = (file: string, offset?: number, limit?: number): Tool => ({
	name: "Read", args: { file_path: `/work/equiv/${file}`, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) },
});
const edit = (file: string, old_string: string, new_string: string): Tool => ({ name: "Edit", args: { file_path: `/work/equiv/${file}`, old_string, new_string } });
const multi = (file: string, edits: Array<[string, string]>): Tool => ({ name: "MultiEdit", args: { file_path: `/work/equiv/${file}`, edits: edits.map(([old_string, new_string]) => ({ old_string, new_string })) } });
const grep = (pattern: string, path = "/work/equiv/src"): Tool => ({ name: "Grep", args: { pattern, path } });
const bash = (command: string, error = false): Tool => ({ name: "Bash", args: { command }, ...(error ? { error: true, result: "synthetic command failure" } : {}) });
const cc = (...tools: Tool[]) => ({ harness: "claude-code" as const, tools });
const cx = (...tools: Tool[]) => ({ harness: "codex" as const, tools });
const sed = (file: string, start: number, end: number): Tool => bash(`sed -n '${start},${end}p' ${file}`);
const pairs: Pair[] = [
	{ slug: "chunked-bulk-read", label: "equivalent", category: "chunked-vs-bulk-reads", why: "Adjacent bounded reads cover the same lines as one bulk read.", left: cc(read("src/a.ts", 1, 20), read("src/a.ts", 21, 20)), right: cc(read("src/a.ts", 1, 40)) },
	{ slug: "multiedit-edit-chain", label: "equivalent", category: "multiedit-vs-edits", why: "The ordered replacements compose to the same file change.", left: cc(edit("src/a.ts", "alpha", "beta"), edit("src/a.ts", "beta", "gamma")), right: cc(multi("src/a.ts", [["alpha", "beta"], ["beta", "gamma"]])) },
	{ slug: "repeated-identical-search", label: "equivalent", category: "repeated-searches", why: "The same search is repeated with no intervening mutation.", left: cc(grep("needle"), grep("needle")), right: cc(grep("needle")) },
	{ slug: "read-order-permuted", label: "equivalent", category: "read-order-permuted-across-files", why: "Read-only observations of separate files commute.", left: cc(read("src/a.ts", 1, 12), read("src/b.ts", 1, 8)), right: cc(read("src/b.ts", 1, 8), read("src/a.ts", 1, 12)) },
	{ slug: "read-after-edit-vs-before", label: "divergent", category: "read-after-edit-vs-read-before-edit", why: "The read of the edited file occurs on opposite sides of the mutation.", left: cc(edit("src/a.ts", "old", "new"), read("src/a.ts", 1, 20)), right: cc(read("src/a.ts", 1, 20), edit("src/a.ts", "old", "new")) },
	{ slug: "test-before-fix-vs-after", label: "divergent", category: "test-before-vs-after-fix", why: "The test runs before the fix on one side and after it on the other.", left: cc(bash("pnpm test"), edit("src/a.ts", "bug", "fix")), right: cc(edit("src/a.ts", "bug", "fix"), bash("pnpm test")) },
	{ slug: "same-edit-different-file", label: "divergent", category: "same-edits-different-file", why: "The replacement targets different files.", left: cc(edit("src/a.ts", "old", "new")), right: cc(edit("src/b.ts", "old", "new")) },
	{ slug: "extra-failing-command", label: "divergent", category: "extra-failing-command", why: "Only the left run contains a command with an observed failure.", left: cc(bash("pnpm test", true)), right: cc() },
	{ slug: "extra-exploratory-read", label: "equivalent", category: "extra-exploratory-reads", why: "Convention: an additional successful read of an untouched file counts as exploratory.", left: cc(read("src/a.ts", 1, 8), read("src/b.ts", 1, 8)), right: cc(read("src/a.ts", 1, 8)) },
	{ slug: "unknown-range-same-read", label: "equivalent", category: "unknown-range-reads", why: "The same whole-file-or-unknown read request appears on both sides.", left: cc(read("src/a.ts")), right: cc(read("src/a.ts")) },
	{ slug: "unknown-range-vs-bounded", label: "divergent", category: "unknown-range-reads", why: "An unknown-range request does not prove equivalence to a bounded read.", left: cc(read("src/a.ts")), right: cc(read("src/a.ts", 1, 80)) },
	{ slug: "codex-sed-cc-offsets", label: "equivalent", category: "codex-sed-vs-cc-read-offsets", why: "The Codex literal sed range and Claude Code offset/limit identify the same lines.", left: cx(sed("src/a.ts", 21, 40)), right: cc(read("src/a.ts", 21, 20)) },
	{ slug: "interleaved-mutating-run", label: "divergent", category: "interleaved-reads-across-mutating-run", why: "The file observation crosses a command that may mutate the workspace on one side.", left: cc(read("src/a.ts", 1, 10), bash("node scripts/update.js"), read("src/a.ts", 11, 10)), right: cc(read("src/a.ts", 1, 20), bash("node scripts/update.js")) },
	{ slug: "adjacent-read-gap", label: "divergent", category: "adversarial-near-miss", why: "The bounded reads leave a line uncovered, so they cannot merge into the bulk range.", left: cc(read("src/a.ts", 1, 10), read("src/a.ts", 12, 9)), right: cc(read("src/a.ts", 1, 20)) },
	{ slug: "search-query-near-miss", label: "divergent", category: "adversarial-near-miss", why: "The repeated searches differ by one query character.", left: cc(grep("token")), right: cc(grep("tokens")) },
	{ slug: "edit-composition-near-miss", label: "divergent", category: "adversarial-near-miss", why: "The second replacement does not consume the first replacement's output.", left: cc(edit("src/a.ts", "alpha", "beta"), edit("src/a.ts", "bet", "gamma")), right: cc(edit("src/a.ts", "alpha", "gamma")) },
	{ slug: "read-search-mutation-order", label: "divergent", category: "order-guard", why: "A broad search and an edit are separated by different observed order; the search may see the changed file.", left: cc(grep("token"), edit("src/a.ts", "old", "new")), right: cc(edit("src/a.ts", "old", "new"), grep("token")) },
	{ slug: "distinct-file-read-around-edit", label: "equivalent", category: "order-guard", why: "A known successful edit to another file commutes with this read; the relative order does not change the observed work.", left: cc(read("src/b.ts", 1, 12), edit("src/a.ts", "old", "new")), right: cc(edit("src/a.ts", "old", "new"), read("src/b.ts", 1, 12)) },
	{ slug: "same-lines-overlapping-reads", label: "equivalent", category: "chunked-vs-bulk-reads", why: "Overlapping ranges have the same union as the single bounded read.", left: cc(read("src/a.ts", 1, 18), read("src/a.ts", 15, 16)), right: cc(read("src/a.ts", 1, 30)) },
	{ slug: "codex-sed-bulk-read", label: "equivalent", category: "codex-sed-vs-cc-read-offsets", why: "Equivalent inclusive sed and offset/limit ranges cover the same lines.", left: cx(sed("src/a.ts", 1, 25)), right: cc(read("src/a.ts", 1, 25)) },
	{ slug: "codex-two-seds-chunked", label: "equivalent", category: "chunked-vs-bulk-reads", why: "Adjacent Codex sed ranges coalesce to the same read as the Claude Code request.", left: cx(sed("src/a.ts", 1, 10), sed("src/a.ts", 11, 20)), right: cc(read("src/a.ts", 1, 20)) },
	{ slug: "search-between-read-chunks", label: "equivalent", category: "read-order-permuted-across-files", why: "Read and search observations commute; the same bounded range is covered in both runs.", left: cc(read("src/a.ts", 1, 10), grep("token"), read("src/a.ts", 11, 10)), right: cc(grep("token"), read("src/a.ts", 1, 20)) },
	{ slug: "extra-exploratory-reads", label: "equivalent", category: "extra-exploratory-reads", why: "Convention: an additional read-only search is exploratory.", left: cc(grep("token"), grep("helper")), right: cc(grep("token")) },
	{ slug: "reads-permuted-three-files", label: "equivalent", category: "read-order-permuted-across-files", why: "Three read-only observations commute across files.", left: cc(read("src/a.ts", 1, 4), read("src/b.ts", 1, 4), read("src/c.ts", 1, 4)), right: cc(read("src/c.ts", 1, 4), read("src/a.ts", 1, 4), read("src/b.ts", 1, 4)) },
	{ slug: "multi-edit-disjoint-replacements", label: "equivalent", category: "multiedit-vs-edits", why: "The identical ordered disjoint replacement list is preserved on both sides.", left: cc(edit("src/a.ts", "red", "blue"), edit("src/a.ts", "left", "right")), right: cc(multi("src/a.ts", [["red", "blue"], ["left", "right"]])) },
	{ slug: "identical-tests", label: "equivalent", category: "test-command", why: "Both runs execute the same test command with successful results.", left: cc(bash("pnpm test")), right: cx(bash("pnpm test")) },
	{ slug: "edit-status-diff", label: "divergent", category: "adversarial-near-miss", why: "The same edit has an observed failure on the left and success on the right.", left: cc({ ...edit("src/a.ts", "old", "new"), error: true, result: "synthetic edit failure" }), right: cc(edit("src/a.ts", "old", "new")) },
	{ slug: "read-range-one-line-different", label: "divergent", category: "adversarial-near-miss", why: "The ranges overlap but the right run also reads a line not covered on the left.", left: cc(read("src/a.ts", 1, 19)), right: cc(read("src/a.ts", 1, 20)) },
	{ slug: "read-edit-distinct-cross-harness", label: "equivalent", category: "order-guard", why: "Both runs read the same range using different tools before editing another file.", left: cc(read("src/b.ts", 1, 10), edit("src/a.ts", "old", "new")), right: cc(bash("sed -n '1,10p' src/b.ts"), edit("src/a.ts", "old", "new")) },
	{ slug: "different-search-options", label: "divergent", category: "adversarial-near-miss", why: "The search scope differs even though the query matches.", left: cc(grep("token", "/work/equiv/src")), right: cc(grep("token", "/work/equiv/test")) },
	{ slug: "read-after-edit-versus-read-first-cross", label: "divergent", category: "interleaved-reads-across-mutating-run", why: "The read crosses the same potentially mutating command across harnesses.", left: cc(bash("node scripts/update.js"), read("src/a.ts", 1, 12)), right: cx(sed("src/a.ts", 1, 12), bash("node scripts/update.js")) },
	{ slug: "same-edit-different-replacement", label: "divergent", category: "same-edits-different-file", why: "The file matches but the replacement result differs.", left: cc(edit("src/a.ts", "old", "new")), right: cc(edit("src/a.ts", "old", "better")) },
	{ slug: "repeated-search-across-read", label: "equivalent", category: "repeated-searches", why: "An intervening read commutes with the identical search, so duplicates collapse.", left: cc(grep("needle"), read("src/a.ts", 1, 5), grep("needle")), right: cc(grep("needle"), read("src/a.ts", 1, 5)) },
	{ slug: "two-identical-unknown-reads", label: "equivalent", category: "unknown-range-reads", why: "Identical unknown-range Read arguments remain comparable and are deduplicated as one event.", left: cc(read("src/a.ts"), read("src/a.ts")), right: cc(read("src/a.ts")) },
	{ slug: "different-unknown-read-file", label: "divergent", category: "unknown-range-reads", why: "Unknown ranges do not erase the known file identity.", left: cc(read("src/a.ts")), right: cc(read("src/b.ts")) },
	{ slug: "search-around-edit-barrier", label: "divergent", category: "order-guard", why: "Identical searches on opposite sides of an edit are not deduplicated across the mutation.", left: cc(grep("needle"), edit("src/a.ts", "old", "new"), grep("needle")), right: cc(grep("needle"), edit("src/a.ts", "old", "new")) },
	{ slug: "two-read-chunks-with-intervening-edit", label: "divergent", category: "order-guard", why: "The read chunks straddle a same-file mutation and cannot be treated as one bulk read.", left: cc(read("src/a.ts", 1, 10), edit("src/a.ts", "old", "new"), read("src/a.ts", 11, 10)), right: cc(edit("src/a.ts", "old", "new"), read("src/a.ts", 1, 20)) },
	{ slug: "edit-order", label: "divergent", category: "adversarial-near-miss", why: "The replacement order changes the sequential composition and is not commutative.", left: cc(edit("src/a.ts", "alpha", "beta"), edit("src/a.ts", "beta", "gamma")), right: cc(edit("src/a.ts", "beta", "gamma"), edit("src/a.ts", "alpha", "beta")) },
	{ slug: "read-permutation-with-search", label: "equivalent", category: "read-order-permuted-across-files", why: "Read and search observations are both read-only and commute across the pair.", left: cc(read("src/a.ts", 1, 10), grep("needle"), read("src/b.ts", 1, 10)), right: cc(read("src/b.ts", 1, 10), read("src/a.ts", 1, 10), grep("needle")) },
	{ slug: "codex-range-off-by-one", label: "divergent", category: "codex-sed-vs-cc-read-offsets", why: "The sed range ends one line earlier than the Claude Code read.", left: cx(sed("src/a.ts", 1, 19)), right: cc(read("src/a.ts", 1, 20)) },
];

function ccEvents(tools: Tool[]) {
	const cwd = "/work/equiv";
	const out: Record<string, unknown>[] = [{ sessionId: "fixture-cc", cwd, type: "user", uuid: "u", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Inspect the synthetic workspace." } }];
	tools.forEach((tool, i) => {
		const id = `call-${i}`;
		out.push({ sessionId: "fixture-cc", cwd, type: "assistant", uuid: `a-${i}`, timestamp: `2026-01-01T00:00:${String(i + 1).padStart(2, "0")}Z`, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: tool.name, input: tool.args }] } });
		out.push({ sessionId: "fixture-cc", cwd, type: "user", uuid: `r-${i}`, timestamp: `2026-01-01T00:01:${String(i + 1).padStart(2, "0")}Z`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: tool.error ?? false, content: tool.result ?? (tool.name === "Bash" && /\btest\b/.test(String(tool.args.command)) ? "ℹ tests 1\nℹ pass 1\nℹ fail 0" : "synthetic result") }] } });
	});
	out.push({ sessionId: "fixture-cc", cwd, type: "assistant", uuid: "done", timestamp: "2026-01-01T00:02:00Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } });
	return out;
}

function codexEvents(tools: Tool[]) {
	const cwd = "/work/equiv";
	const out: Record<string, unknown>[] = [
		{ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: "fixture-codex", cwd, originator: "codex_cli", cli_version: "0.0.0" } },
		{ type: "turn_context", timestamp: "2026-01-01T00:00:01Z", payload: { cwd, model: "fixture" } },
		{ type: "response_item", timestamp: "2026-01-01T00:00:02Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the synthetic workspace." }] } },
	];
	tools.forEach((tool, i) => {
		const call = `call-${i}`;
		if (tool.name === "Bash") {
			const command = String(tool.args.command);
			out.push({ type: "response_item", timestamp: `2026-01-01T00:00:${String(i + 3).padStart(2, "0")}Z`, payload: { type: "function_call", name: "shell", call_id: call, arguments: JSON.stringify({ command: ["bash", "-lc", command] }) } });
			const exit = tool.error ? 1 : 0;
			const body = tool.result ?? (exit ? "error: synthetic command failure" : /\btest\b/.test(command) ? "ℹ tests 1\nℹ pass 1\nℹ fail 0" : "synthetic result");
			out.push({ type: "response_item", timestamp: `2026-01-01T00:01:${String(i + 3).padStart(2, "0")}Z`, payload: { type: "function_call_output", call_id: call, output: `Process exited with code ${exit}\nOutput:\n${body}` } });
		} else {
			const names: Record<string, string> = { Read: "read_file", Edit: "Edit", MultiEdit: "MultiEdit", Grep: "search" };
			const arguments_ = tool.name === "Read" ? { file_path: tool.args.file_path } : tool.args;
			out.push({ type: "response_item", timestamp: `2026-01-01T00:00:${String(i + 3).padStart(2, "0")}Z`, payload: { type: "function_call", name: names[tool.name] ?? tool.name, call_id: call, arguments: JSON.stringify(arguments_) } });
			out.push({ type: "response_item", timestamp: `2026-01-01T00:01:${String(i + 3).padStart(2, "0")}Z`, payload: { type: "function_call_output", call_id: call, output: tool.error ? "Process exited with code 1\nOutput:\nsynthetic failure" : "synthetic result" } });
		}
	});
	out.push({ type: "event_msg", timestamp: "2026-01-01T00:03:00Z", payload: { type: "task_complete", last_agent_message: "Done." } });
	return out;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outArg = process.argv.indexOf("--out-dir");
const fixtureRoot = outArg >= 0 ? join(root, process.argv[outArg + 1] ?? "") : join(root, "fixtures/run-diff/equivalence");
for (const [index, pair] of pairs.entries()) {
	const dir = join(fixtureRoot, `${String(index + 1).padStart(2, "0")}-${pair.slug}`);
	await mkdir(dir, { recursive: true });
	for (const side of ["left", "right"] as const) {
		const events = pair[side].harness === "claude-code" ? ccEvents(pair[side].tools) : codexEvents(pair[side].tools);
		await writeFile(join(dir, `${side}.jsonl`), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	}
	await writeFile(join(dir, "label.json"), `${JSON.stringify({ label: pair.label, why: pair.why, category: pair.category }, null, 2)}\n`);
}
if (pairs.length !== 40) throw new Error(`Expected 40 pairs, found ${pairs.length}`);
console.log(`Generated ${pairs.length} deterministic equivalence fixture pairs.`);
