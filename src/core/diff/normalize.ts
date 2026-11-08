/**
 * Normalize a parsed Trace into harness-neutral steps for Run Diff.
 *
 * Claude Code and Codex express the same work differently: CC calls `Read` on a
 * file while Codex runs `sed -n` through a shell, CC calls `Edit` while Codex
 * sends an `apply_patch`, CC writes todos with `TodoWrite` while Codex calls
 * `update_plan`. This module maps both onto one small verb set (`DiffAction`)
 * plus a workspace-relative target, so an alignment can match them.
 *
 * Only main-context work is kept: llm turns carry no comparable action, and
 * subagent sidechains are summarized by their `delegate` step.
 */

import { ATTR, type ExecResult, type Step, type Trace } from "../types.ts";
import {
	type DiffAction,
	type DiffStatus,
	type DiffStep,
	isFailure,
} from "./types.ts";

type Json = Record<string, unknown>;

const ERROR_MAX = 240;
const TARGET_MAX = 80;

function asObj(v: unknown): Json {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Json)
		: {};
}
function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Test-runner invocations, matched only at the command position (after env
 * assignments and runner prefixes such as `npx` are stripped), so a test config
 * read (`cat jest.config.js`) or quoted data (`rg "npm test"`) is never a test.
 * The match itself becomes the target, so flags and redirects never split two
 * runs of the same suite.
 */
const TEST_RE =
	/^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?:[:\w-]*\b)?|node\s+--test\b|python3?\s+-m\s+(?:pytest|unittest)\b|pytest\b|cargo\s+(?:test|nextest)\b|go\s+test\b|vitest\b|jest\b|swift\s+test\b|make\s+test\b|xcodebuild\b.*\btest\b)/;
/** Wrappers that run the real command: stripped before the test check. */
const RUNNER_PREFIX =
	/^(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+exec|uv\s+run|poetry\s+run|timeout\s+\S+|time)\s+)+/;
/** Commands that only orient the shell; dropped so they never misalign runs. */
const NOISE_CMDS = new Set([
	"pwd",
	"cd",
	"echo",
	"printf",
	"true",
	"sleep",
	"clear",
	"set",
	"export",
	"which",
	"date",
]);
/** Commands that write a file when their output is redirected into it. */
const WRITE_CMDS = new Set(["cat", "printf", "echo"]);
const GIT_READS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"branch",
	"rev-parse",
	"blame",
	"ls-files",
	"grep",
]);
/** At most this many steps are taken from one compound command. */
const MAX_STAGES = 6;
const READ_CMDS = new Set(["cat", "sed", "head", "tail", "nl", "less", "bat"]);
const SEARCH_CMDS = new Set(["rg", "grep", "find", "ls", "fd", "tree", "ag"]);
/** Commands that take a subcommand worth keeping in the target ("git status"). */
const SUBCOMMAND_CMDS = new Set([
	"git",
	"pnpm",
	"npm",
	"yarn",
	"bun",
	"cargo",
	"go",
	"gh",
	"docker",
	"make",
	"uv",
	"swift",
]);

/** Make a path comparable across worktrees: strip the run's cwd, else keep the tail. */
export function relPath(path: string, cwd: string | null | undefined): string {
	let p = path.trim().replace(/^["']|["']$/g, "");
	if (cwd) {
		const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
		if (p.startsWith(base)) return p.slice(base.length) || ".";
		if (p === cwd) return ".";
	}
	p = p.replace(/^\.\//, "");
	if (p.startsWith("/")) {
		const parts = p.split("/").filter(Boolean);
		return parts.slice(-2).join("/");
	}
	return p;
}

/** Split a shell command into words, honoring simple quotes. Good enough for heads. */
function words(cmd: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
	return out;
}

/** Drop `cd x &&`, env assignments and `bash -lc` wrappers to reach the real command. */
function coreCommand(cmd: string): string {
	let c = cmd.trim();
	const wrapped = /^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(c);
	if (wrapped?.[2]) c = wrapped[2].trim();
	for (;;) {
		const cd = /^cd\s+\S+\s*(&&|;)\s*/.exec(c);
		if (cd) {
			c = c.slice(cd[0].length);
			continue;
		}
		const env = /^[A-Z_][A-Z0-9_]*=\S*\s+/.exec(c);
		if (env) {
			c = c.slice(env[0].length);
			continue;
		}
		break;
	}
	return c;
}

/** Path-looking arguments of a read command (`sed -n 1,80p src/a.ts` -> [src/a.ts]). */
function fileArgs(ws: string[]): string[] {
	return ws
		.slice(1)
		.filter(
			(w) =>
				w.length > 0 &&
				!w.startsWith("-") &&
				!/^[\d,]+p?$/.test(w) &&
				!/[|<>$`]/.test(w) &&
				!/^[\d+]?[sy]\//.test(w), // sed scripts
		);
}

interface Classified {
	action: DiffAction;
	target: string | null;
	/** Shown in the label but not part of the alignment signature. */
	note?: string;
	/** A test piped into another command: its exit status is that command's. */
	piped?: boolean;
	/** False for a shell stage before the last one (dropped stages included). */
	last?: boolean;
}

/** Classify one pipeline (`a | b`); a pipeline is judged by its first command. */
function classifyStage(
	stage: string,
	cwd: string | null | undefined,
): Classified[] {
	const first = (stage.split(/\s*\|\s*/)[0] ?? "").trim();
	const ws = words(first).filter((w) => !/^\d*[<>]/.test(w));
	while (ws.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0] ?? "")) ws.shift();
	const test = TEST_RE.exec(ws.join(" ").replace(RUNNER_PREFIX, ""));
	if (test) {
		// `pnpm run test` and `pnpm test` are one suite; `test:unit` is another.
		const target = test[0].replace(/\s+run\s+/, " ").replace(/\s+/g, " ");
		const piped = /\|(?!\|)/.test(stage.replace(/\|\|/g, ""));
		return [piped ? { action: "test", target, piped } : { action: "test", target }];
	}
	const head = (ws[0] ?? "").replace(/^.*\//, "");
	// `cat > f <<EOF`, `printf … > f`, `echo … >> f`, `… | tee f`: writing a file.
	const into = WRITE_CMDS.has(head) ? /(?:^|[^\d&>])>>?\s*([^\s&|;<>]+)/.exec(first)?.[1] : undefined;
	if (into && !into.startsWith("/dev/")) return [{ action: "write", target: relPath(into, cwd) }];
	const teeInto = /\|\s*tee\s+(?:-a\s+)?([^\s&|;<>-][^\s&|;<>]*)/.exec(stage)?.[1];
	if (teeInto && !teeInto.startsWith("/dev/") && !TEST_RE.test(ws.join(" ")))
		return [{ action: "write", target: relPath(teeInto, cwd) }];
	if (!head || NOISE_CMDS.has(head)) return [];
	if (READ_CMDS.has(head) && !/\s-i\b/.test(first)) {
		const files = fileArgs(ws);
		if (files.length === 0) return [{ action: "read", target: null, note: head }];
		return files
			.slice(0, MAX_STAGES)
			.map((f) => ({ action: "read" as const, target: relPath(f, cwd) }));
	}
	// Read-only git inspection is a read of repo state, not a command that changes it.
	if (head === "git" && GIT_READS.has(ws[1] ?? ""))
		return [{ action: "read", target: `git ${ws[1]}` }];
	// Searches align regardless of tool (rg vs Grep vs find).
	if (SEARCH_CMDS.has(head)) return [{ action: "search", target: null, note: head }];
	const sub = ws[1];
	const target =
		SUBCOMMAND_CMDS.has(head) && sub && !sub.startsWith("-")
			? `${head} ${sub}`
			: head;
	return [{ action: "run", target }];
}

/** Shell keywords that start or end control flow; stripped from a stage's head. */
const CONTROL_RE = /^(?:(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|!|\{|\}|\(|\))(?:\s+|$))+/;

/** How a compound command's stages were chained. */
type Chain = "single" | "seq" | "and" | "mixed";

/**
 * Split a shell script into stages on `;`, `&&`, `||` and newlines outside
 * quotes (`node -e "a; b"` stays whole), keeping the separators. A newline
 * separates like `;`. Heredoc bodies are skipped, line continuations joined,
 * and comment lines dropped.
 */
function splitWithSeps(script: string): { stages: string[]; seps: string[] } {
	const text = script.replace(/\\\r?\n/g, " ");
	const stages: string[] = [];
	const seps: string[] = [];
	let quote: string | null = null;
	let cur = "";
	// Delimiter of a heredoc opened on the current line, outside quotes.
	let heredoc: string | null = null;
	const flush = (sep: string | null) => {
		const t = cur.trim();
		if (t && !t.startsWith("#")) {
			stages.push(t);
			if (sep) seps.push(sep);
		} else if (sep && seps.length === stages.length && stages.length > 0) {
			// An empty or comment stage: keep the stronger separator before it.
			seps[seps.length - 1] = seps[seps.length - 1] === ";" ? sep : (seps[seps.length - 1] as string);
		}
		cur = "";
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (quote) {
			if (ch === "\\" && quote === '"') {
				cur += ch + (text[i + 1] ?? "");
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			cur += ch;
			continue;
		}
		if (ch === "<" && text.startsWith("<<", i)) {
			// A here-string (`<<<`) carries no body; a heredoc's body follows the line.
			if (text.startsWith("<<<", i)) {
				cur += "<<<";
				i += 2;
				continue;
			}
			const op = /^<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(text.slice(i));
			if (op) {
				heredoc = op[2] as string;
				cur += op[0];
				i += op[0].length - 1;
				continue;
			}
		}
		if (ch === "\n") {
			flush(";");
			if (heredoc) {
				// Skip the body up to the delimiter line.
				const delim = heredoc;
				heredoc = null;
				let j = i + 1;
				while (j < text.length) {
					const nl = text.indexOf("\n", j);
					const end = nl < 0 ? text.length : nl;
					const bodyLine = text.slice(j, end);
					j = end + 1;
					if (bodyLine.trim() === delim) break;
				}
				i = j - 1;
			}
			continue;
		}
		if (ch === "#" && cur.trim() === "") {
			// A comment runs to the end of the line.
			const nl = text.indexOf("\n", i);
			i = (nl < 0 ? text.length : nl) - 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		const two = text.slice(i, i + 2);
		if (ch === ";" || two === "&&" || two === "||") {
			flush(ch === ";" ? ";" : two);
			if (ch !== ";") i++;
			continue;
		}
		cur += ch;
	}
	flush(null);
	return { stages, seps: seps.slice(0, Math.max(0, stages.length - 1)) };
}

export function splitStages(line: string): string[] {
	return splitWithSeps(line).stages;
}

function chainOf(seps: string[]): Chain {
	if (seps.length === 0) return "single";
	if (seps.every((x) => x === ";")) return "seq";
	if (seps.every((x) => x === "&&")) return "and";
	return "mixed";
}

interface CommandParts {
	parts: Classified[];
	chain: Chain;
}

/**
 * Classify a shell command into one step per meaningful stage:
 * `cat package.json; rg --files; npm test` is a read, a search and a test.
 * Every line counts; heredoc bodies are data, never commands.
 */
function commandParts(cmd: string, cwd: string | null | undefined): CommandParts {
	const core = coreCommand(cmd);
	const { stages: raw, seps } = splitWithSeps(core);
	// Shell control flow (`if npm test; then …`) decides what ran by itself, so
	// such scripts never hand their exit status to one stage.
	const control = raw.some((x) => CONTROL_RE.test(x));
	// Loop and case headers (`for f in a b`) are not commands themselves.
	const stages = raw.map((x) => (/^(?:for|case|select)\s/.test(x) ? "" : x.replace(CONTROL_RE, "").trim()));
	const parts: Classified[] = [];
	stages.forEach((stage, i) => {
		const last = i === stages.length - 1;
		for (const c of classifyStage(stage, cwd)) parts.push(last ? c : { ...c, last });
	});
	// Every separator counts, including those around dropped stages: the
	// `|| true` in `false && npm test || true` decides what the exit status means.
	return {
		// Cap noisy scripts, but never drop a test run or the final stage: they
		// decide the run's outcome and what the exit status means.
		parts: parts.filter((c, i) => i < MAX_STAGES || c.action === "test" || c.last !== false),
		chain: control ? "mixed" : parts.length > 1 || stages.length > 1 ? chainOf(seps) : "single",
	};
}

export function classifyCommand(
	cmd: string,
	cwd: string | null | undefined,
): Classified[] {
	return commandParts(cmd, cwd).parts;
}

/** Pull the shell command out of the many shapes Codex and CC record. */
function commandOf(args: unknown): string | undefined {
	const a = asObj(args);
	const cmd = a["cmd"] ?? a["command"];
	if (typeof cmd === "string") return cmd;
	if (Array.isArray(cmd)) {
		const parts = cmd.filter((x): x is string => typeof x === "string");
		// ["bash", "-lc", "<script>"] -> the script
		if (parts.length >= 3 && /sh$/.test(parts[0] ?? "") && /^-l?c$/.test(parts[1] ?? ""))
			return parts.slice(2).join(" ");
		return parts.join(" ");
	}
	return undefined;
}

/** Files a patch touches: Add is a write; Update and Delete are edits. */
function patchTargets(
	patch: string,
	cwd: string | null | undefined,
): Classified[] {
	const out: Classified[] = [];
	for (const m of patch.matchAll(/\*\*\* (Update|Add|Delete) File:\s*([^\s"\\]+)/g)) {
		const file = relPath(m[2] ?? "", cwd);
		out.push({ action: m[1] === "Add" ? "write" : "edit", target: file });
	}
	return out.slice(0, MAX_STAGES);
}

/**
 * Decode a static JS string literal ("…", '…' or a template literal without
 * `${}`), or undefined when it is not one. Nothing is evaluated.
 */
function jsString(lit: string): string | undefined {
	const q = lit[0];
	if (!q || lit.at(-1) !== q || lit.length < 2) return undefined;
	const body = lit.slice(1, -1);
	if (q === "`" && body.includes("${")) return undefined;
	if (q === '"') {
		try {
			const v = JSON.parse(lit) as unknown;
			return typeof v === "string" ? v : undefined;
		} catch {
			// fall through to the generic unescape (JS allows escapes JSON does not)
		}
	}
	if (q !== '"' && q !== "'" && q !== "`") return undefined;
	const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };
	return body.replace(/\\(.)/gs, (_, c: string) => ESC[c] ?? c);
}

const CELL_CALL_RE = /tools\.([A-Za-z0-9_]+)\s*\(/g;
const STRING_LIT = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\`(?:[^\`\\]|\\.)*\``;

/** The first string-literal argument after `key:` (or the first positional one). */
function literalArg(body: string, key: string | null): { found: boolean; value?: string } {
	const re = key
		? new RegExp(String.raw`\b${key}["']?\s*:\s*(${STRING_LIT})`, "s")
		: new RegExp(String.raw`\(\s*(${STRING_LIT})`, "s");
	const lit = re.exec(body)?.[1];
	if (lit === undefined) return { found: false };
	const value = jsString(lit);
	return value === undefined ? { found: true } : { found: true, value };
}

/**
 * Whether a cell prints each chunked call's result right where it is awaited,
 * in call order: `text(await tools.x(…))`, or `const r = await tools.x(…);
 * text(r)` before the next call. Only then can result chunks be matched to calls
 * by position; concurrent or reordered printing leaves them unattributed.
 */
function printsInCallOrder(input: string, calls: RegExpMatchArray[]): boolean {
	if (/\bPromise\s*\.\s*(?:all|allSettled|race|any)\b/.test(input)) return false;
	let printed = 0;
	for (let i = 0; i < calls.length; i++) {
		const call = calls[i] as RegExpMatchArray;
		if (!CHUNKED.has(call[1] ?? "")) continue;
		const at = call.index ?? 0;
		const before = input.slice(Math.max(0, at - 40), at);
		const segment = input.slice(at, calls[i + 1]?.index ?? input.length);
		if (/text\(\s*(?:String\(\s*)?await\s+$/.test(before)) {
			printed++;
			continue;
		}
		const name = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+$/.exec(before)?.[1];
		if (!name) return false;
		const prints = [...segment.matchAll(/\btext\(\s*(?:String\(\s*)?([A-Za-z_$][\w$]*)/g)];
		if (prints.length !== 1 || prints[0]?.[1] !== name) return false;
		printed++;
	}
	return printed > 0;
}

/**
 * One unit of work with its own result: a shell command (possibly several
 * stages), a single tool call, or one call inside a Codex `exec` cell.
 */
interface Unit {
	parts: Classified[];
	chain: Chain;
	result: DiffStatus | "pending";
	testFailures: boolean;
	testPasses: boolean;
	/** A yielded command waiting on this session's final result. */
	sessionId?: string;
	/** A `write_stdin` poll of this session; carries no steps of its own. */
	pollOf?: string;
}

type UnitResult = Pick<Unit, "result" | "testFailures" | "testPasses" | "sessionId">;

/** Calls in an exec cell that write one result chunk each. */
const CHUNKED = new Set(["exec_command", "write_stdin"]);

const UNKNOWN: UnitResult = { result: "unknown", testFailures: false, testPasses: false };

function chunkResult(r: ExecResult | undefined): UnitResult {
	if (!r) return UNKNOWN;
	const evidence = { testFailures: r.test_failures, testPasses: r.test_passes };
	if (r.exit_code !== null) return { result: r.exit_code === 0 ? "ok" : "error", ...evidence };
	if (r.session_id) return { result: "pending", ...evidence, sessionId: r.session_id };
	return { result: "unknown", ...evidence };
}

/**
 * Current Codex rollouts route tools through a JS `exec` cell, e.g.
 * `text(await tools.exec_command({cmd:"pnpm test"}))`. One cell may call several
 * tools; each call becomes its own unit. A command's result comes only from its
 * own result chunk, matched by position when the cell provably prints in call
 * order. A cell that merely finished running says nothing about its commands.
 */
function codexExecCell(step: Step, input: string, cwd: string | null | undefined): Unit[] {
	const calls = [...input.matchAll(CELL_CALL_RE)];
	const raw = step.attributes[ATTR.EXEC_RESULTS];
	const results = Array.isArray(raw) ? (raw as ExecResult[]) : [];
	const chunked = calls.filter((c) => CHUNKED.has(c[1] ?? "")).length;
	const perCall = results.length === chunked && chunked > 0 && printsInCallOrder(input, calls);
	const cell = stepResult(step);
	// Non-command calls (patches, plans) throw on failure, so a script that ran
	// to completion vouches for them; otherwise a failed cell only for a lone call.
	const completed = step.attributes[ATTR.EXEC_COMPLETED] === true;
	const plain: UnitResult = completed
		? { result: "ok", testFailures: false, testPasses: false }
		: cell.result === "ok" || calls.length === 1
			? { result: cell.result, testFailures: false, testPasses: false }
			: UNKNOWN;
	// Cell-wide test evidence can only speak for a lone test in the cell.
	const cellEvidence = { testFailures: cell.testFailures, testPasses: cell.testPasses };
	let k = 0;
	const out: Unit[] = [];
	calls.forEach((call, i) => {
		const tool = call[1] ?? "";
		const body = input.slice(call.index ?? 0, calls[i + 1]?.index ?? input.length);
		const res: UnitResult = CHUNKED.has(tool)
			? perCall
				? chunkResult(results[k++])
				: { ...UNKNOWN, ...cellEvidence }
			: plain;
		if (tool === "exec_command") {
			const cmd = literalArg(body, "cmd");
			if (cmd.value !== undefined) out.push({ ...commandParts(cmd.value, cwd), ...res });
			// A command we cannot read statically still happened: keep it, unresolved.
			else out.push({ parts: [{ action: "run", target: null, note: "unparsed command" }], chain: "single", ...res });
		} else if (tool === "write_stdin") {
			const session = /\bsession_id["']?\s*:\s*["']?([\w-]+)/.exec(body)?.[1];
			if (session) out.push({ parts: [], chain: "single", ...res, pollOf: session });
		} else if (tool === "apply_patch") {
			const patch = literalArg(body, null).value ?? body;
			const parts = patchTargets(patch, cwd);
			out.push({ parts: parts.length ? parts : [{ action: "edit", target: null }], chain: "single", ...res });
		} else if (tool === "update_plan") {
			out.push({ parts: [{ action: "plan", target: null }], chain: "single", ...res });
		} else if (/^web/.test(tool)) {
			out.push({ parts: [{ action: "web", target: null }], chain: "single", ...res });
		} else {
			out.push({ parts: [{ action: "other", target: tool }], chain: "single", ...res });
		}
	});
	// Cell-wide evidence only counts when the cell holds exactly one test.
	const tests = out.flatMap((u) => u.parts.filter((c) => c.action === "test"));
	if (!perCall && tests.length !== 1)
		for (const u of out) {
			u.testFailures = false;
			u.testPasses = false;
		}
	return out;
}

function stepResult(step: Step): { result: DiffStatus; testFailures: boolean; testPasses: boolean } {
	// Parsers start a call as ok and settle it when its result arrives; a call
	// whose result never arrived (a run cut off mid-command) proves nothing.
	const awaited = step.kind === "tool_call" || step.kind === "agent";
	const settled = Boolean(step.ended_at) || (step.status ?? "ok") !== "ok";
	return {
		result: awaited && !settled ? "unknown" : (step.status ?? "ok"),
		testFailures: step.attributes[ATTR.TEST_FAILURES] === true,
		testPasses: step.attributes[ATTR.TEST_PASSES] === true,
	};
}

/** A plain-format command's result: pending when it yielded, else the step's own. */
function yieldedOr(step: Step): UnitResult {
	const raw = step.attributes[ATTR.EXEC_RESULTS];
	const only = Array.isArray(raw) && raw.length === 1 ? (raw[0] as ExecResult) : undefined;
	return only ? chunkResult(only) : stepResult(step);
}

function toolUnits(step: Step, cwd: string | null | undefined): Unit[] {
	const name = str(step.attributes[ATTR.TOOL_NAME]) ?? "";
	const args = asObj(step.attributes[ATTR.TOOL_ARGS]);
	const file = str(args["file_path"]) ?? str(args["path"]) ?? str(args["notebook_path"]);
	const rel = file ? relPath(file, cwd) : null;
	const one = (parts: Classified[], chain: Chain = "single"): Unit[] => [
		{ parts, chain, ...stepResult(step) },
	];
	switch (name) {
		case "Read":
		case "read_file":
			return one([{ action: "read", target: rel }]);
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
			return one([{ action: "edit", target: rel }]);
		case "Write":
			return one([{ action: "write", target: rel }]);
		case "Grep":
		case "Glob":
		case "LS":
			return one([{ action: "search", target: null, note: name.toLowerCase() }]);
		case "TodoWrite":
		case "ExitPlanMode":
		case "update_plan":
			return one([{ action: "plan", target: null }]);
		case "WebFetch":
		case "WebSearch":
		case "web_search":
			return one([{ action: "web", target: null }]);
		case "apply_patch": {
			const input = str(args["input"]) ?? str(args["patch"]) ?? "";
			const parts = patchTargets(input, cwd);
			return one(parts.length ? parts : [{ action: "edit", target: null }]);
		}
		case "exec": {
			const units = codexExecCell(step, str(args["input"]) ?? "", cwd);
			return units.length ? units : one([{ action: "other", target: "exec" }]);
		}
		default: {
			// A plain-format poll of a yielded command: its result settles that command.
			if (name === "write_stdin") {
				const session = args["session_id"];
				if (typeof session === "number" || typeof session === "string")
					return [{ parts: [], chain: "single", ...yieldedOr(step), pollOf: String(session) }];
			}
			const cmd = commandOf(args);
			if (cmd !== undefined) {
				const { parts, chain } = commandParts(cmd, cwd);
				return [{ parts, chain, ...yieldedOr(step) }];
			}
			return one([{ action: "other", target: name || null }]);
		}
	}
}

const VERB: Record<DiffAction, string> = {
	read: "read",
	search: "search",
	edit: "edit",
	write: "write",
	test: "test",
	run: "run",
	plan: "update plan",
	delegate: "delegate",
	web: "web lookup",
	compaction: "compact context",
	blocked: "blocked",
	other: "call",
};

function make(
	step: Step,
	index: number,
	c: Classified,
	status: DiffStatus,
	error: string | undefined,
): DiffStep {
	const target = c.target ? clip(c.target, TARGET_MAX) : null;
	const out: DiffStep = {
		index,
		stepId: step.step_id,
		action: c.action,
		target,
		label: target
			? `${VERB[c.action]} ${target}`
			: c.note
				? `${VERB[c.action]} (${c.note})`
				: VERB[c.action],
		status,
		startedAt: step.started_at,
		signature: `${c.action}:${target ?? ""}`,
	};
	if (c.note) out.note = c.note;
	if (isFailure(status) && error) out.error = clip(error.trim(), ERROR_MAX);
	return out;
}

const isCommand = (c: Classified): boolean =>
	c.action === "test" || c.action === "run";

/**
 * Give each part of a unit a result, inventing none.
 *
 * Exit status: a single command owns it; an `&&` chain that succeeded ran every
 * stage successfully; a `;` chain only reports its last stage; a mixed chain
 * (`a && b || c`) says nothing about any one stage; a piped test reports the
 * pipe's last command, not the test. A failing summary line from the test
 * runner marks its test failed whatever the exit said, when the unit holds one
 * test. Everything else without evidence is `unknown`.
 */
export function resolveStatuses(
	parts: Classified[],
	chain: Chain,
	result: DiffStatus | "pending",
	testFailures: boolean,
): DiffStatus[] {
	const n = parts.length;
	const known = result === "ok" || result === "error" || result === "interrupted";
	const failedResult = result === "error" || result === "interrupted";
	// Which parts the exit status speaks for directly.
	const owns = (i: number): boolean => {
		const c = parts[i] as Classified;
		if (!known || c.piped) return false;
		// An `&&` chain that succeeded ran every stage successfully.
		if (chain === "and") return result === "ok";
		if (chain === "mixed") return false;
		// Otherwise the status is the last stage's (`;` chain, or one stage that
		// expanded to several parts like `cat a b`, where a failure is the last).
		return c.last !== false && (result === "ok" || i === n - 1);
	};
	const out: DiffStatus[] = parts.map((c, i) => {
		if (owns(i)) return result as DiffStatus;
		// Reads and searches that ran before a stage that is known to have run.
		if (!isCommand(c) && known && !failedResult && chain !== "mixed") return "ok";
		return "unknown";
	});
	const tests = parts.flatMap((c, i) => (c.action === "test" ? [i] : []));
	if (tests.length === 1) {
		const t = tests[0] as number;
		if (testFailures) {
			out[t] = failedResult ? (result as DiffStatus) : "error";
			// After a failed stage of an `&&` chain nothing else ran.
			if (chain === "and") for (let i = t + 1; i < n; i++) out[i] = "unknown";
		}
	}
	return out;
}

/**
 * The test summary a unit's output carries, tied to its test part only when the
 * unit holds exactly one test. A passing summary is recorded, never promoted to
 * an exit status: "passed" needs both (see `runVerdict`).
 */
function summaries(
	parts: Classified[],
	testFailures: boolean,
	testPasses: boolean,
): Array<DiffStep["summary"]> {
	const tests = parts.flatMap((c, i) => (c.action === "test" ? [i] : []));
	return parts.map((_, i) =>
		tests.length === 1 && tests[0] === i
			? testFailures
				? "fail"
				: testPasses
					? "pass"
					: undefined
			: undefined,
	);
}

function stepUnits(step: Step, cwd: string | null | undefined): Unit[] {
	if (step.kind === "tool_call") {
		if (step.attributes[ATTR.GUARD_TRIPPED]) {
			const first = toolUnits(step, cwd)[0]?.parts[0];
			const guard = str(step.attributes[ATTR.GUARD_NAME]) ?? "guard";
			return [
				{
					parts: [{ action: "blocked", target: `${guard}: ${first?.action ?? "call"}` }],
					chain: "single",
					...stepResult(step),
				},
			];
		}
		return toolUnits(step, cwd);
	}
	const single = (c: Classified): Unit[] => [{ parts: [c], chain: "single", ...stepResult(step) }];
	if (step.kind === "agent")
		return single({ action: "delegate", target: str(step.attributes[ATTR.AGENT_TYPE]) ?? "subagent" });
	if (step.kind === "compaction") return single({ action: "compaction", target: null });
	if (step.kind === "hook" && step.attributes[ATTR.HOOK_VERDICT] === "deny")
		return single({ action: "blocked", target: str(step.attributes[ATTR.HOOK_EVENT]) ?? "hook" });
	return [];
}

/**
 * A whole-file write to a file the run already read or edited replaces it, so it
 * is an edit (Claude Code rewrites with `Write` where Codex patches).
 */
function rewritesAsEdits(parts: Classified[], seen: Set<string>): Classified[] {
	return parts.map((c) => {
		if (c.action === "write" && c.target && seen.has(c.target))
			return { ...c, action: "edit" };
		if ((c.action === "read" || c.action === "edit" || c.action === "write") && c.target)
			seen.add(c.target);
		return c;
	});
}

/** Steps worth comparing, in order. One source step may yield several. */
export function normalizeTrace(trace: Trace): DiffStep[] {
	const cwd = trace.run.workspace?.cwd ?? null;
	const out: DiffStep[] = [];
	const seen = new Set<string>();
	// Yielded commands waiting for a later write_stdin poll to report their exit.
	const pending = new Map<string, { unit: Unit; steps: DiffStep[]; error?: string }>();
	for (const step of trace.steps) {
		if (step.subagent_id) continue;
		const error = str(step.attributes[ATTR.TOOL_ERROR]);
		for (const unit of stepUnits(step, cwd)) {
			if (unit.pollOf !== undefined) {
				const waiting = pending.get(unit.pollOf);
				if (!waiting) continue;
				// Test summaries can arrive in any poll; keep them all.
				waiting.unit.testFailures ||= unit.testFailures;
				waiting.unit.testPasses ||= unit.testPasses;
				if (unit.result === "pending") continue;
				const { unit: orig, steps } = waiting;
				const statuses = resolveStatuses(orig.parts, orig.chain, unit.result, orig.testFailures);
				const sums = summaries(orig.parts, orig.testFailures, orig.testPasses);
				steps.forEach((d, i) => {
					d.status = statuses[i] ?? "unknown";
					const sum = sums[i];
					if (sum) d.summary = sum;
					if (isFailure(d.status) && error) d.error = clip(error.trim(), ERROR_MAX);
				});
				pending.delete(unit.pollOf);
				continue;
			}
			const parts = rewritesAsEdits(unit.parts, seen);
			if (parts.length === 0) continue;
			const statuses = resolveStatuses(parts, unit.chain, unit.result, unit.testFailures);
			const sums = summaries(parts, unit.testFailures, unit.testPasses);
			const made = parts.map((c, i) =>
				make(
					step,
					out.length + i,
					c,
					statuses[i] ?? "unknown",
					isFailure(statuses[i] ?? "ok") && !error && unit.testFailures
						? "output reports failing tests"
						: error,
				),
			);
			made.forEach((d, i) => {
				const sum = sums[i];
				if (sum) d.summary = sum;
			});
			out.push(...made);
			if (unit.result === "pending" && unit.sessionId)
				pending.set(unit.sessionId, { unit: { ...unit, parts }, steps: made });
		}
	}
	return out;
}
