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

import { ATTR, type ExecPart, type ExecResult, type Step, type Trace } from "../types.ts";
import {
	clipForDisplay,
	type DiffAction,
	type DiffStatus,
	type DiffStep,
	isFailure,
} from "./types.ts";

type Json = Record<string, unknown>;

const ERROR_MAX = 240;

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
/** A bare output redirect or heredoc operator; the next word is its operand. */
const BARE_OPERAND_OP = /^(?:\d+|&)?(?:>>?|>\||>&)$|^<<<?-?$/;

/**
 * The words that make up the command itself: env assignments stay for the
 * caller to strip, while unquoted redirects go, together with the operand of a
 * spaced output redirect or heredoc (`npm run build > build.log` is
 * `npm run build`). A spaced input redirect's file is kept only when asked
 * (`cat < src/a.ts` reads src/a.ts); otherwise it is dropped too.
 */
function commandWords(toks: Array<{ text: string; quoted: boolean }>, keepInput = false): string[] {
	const out: string[] = [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i] as { text: string; quoted: boolean };
		if (!t.quoted && BARE_OPERAND_OP.test(t.text)) {
			// A here-string's text is the program's input: keep it when asked, so
			// `python3 <<< 'print(1)'` and `<<< 'print(2)'` stay different.
			if (keepInput && t.text === "<<<" && toks[i + 1]) out.push("<<<", (toks[i + 1] as { text: string }).text);
			i++;
			continue;
		}
		if (!t.quoted && /^\d*<$/.test(t.text)) {
			// Keep `< file` as written when asked, so two different inputs differ.
			if (keepInput && toks[i + 1]) out.push("<", (toks[i + 1] as { text: string }).text);
			i++;
			continue;
		}
		// Glued input redirects and here-strings (`<in.txt`, `<<<x`) are input
		// too; a glued heredoc opener (`<<EOF`) only names its delimiter.
		const gluedHeredoc = /^<<-?['"]?[A-Za-z_]\w*['"]?$/.test(t.text);
		if (keepInput && !t.quoted && !gluedHeredoc && /^\d*</.test(t.text)) {
			out.push(t.text);
			continue;
		}
		if (!t.quoted && /^(?:\d*|&)[<>]/.test(t.text)) continue;
		out.push(t.text);
	}
	return out;
}

/** Tokens after any leading `NAME=value` env assignments. */
function withoutLeadingEnv(toks: Array<{ text: string; quoted: boolean }>): Array<{ text: string; quoted: boolean }> {
	let i = 0;
	while (i < toks.length - 1 && !toks[i]?.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]?.text ?? "")) i++;
	return toks.slice(i);
}

/** A sed range-print script: `12p`, `1,20p`, `5,$p` or `$p`. */
const SED_RANGE_PRINT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;

/**
 * The files of a plain `sed` read, or null. Only the exact form
 * `sed -n '<range>p' file…` counts: no other options, no redirects, no script
 * file. Anything else (`-i`, `-I`, `-f`, `--file`, `-e`, input redirects, other
 * scripts) is left as an unparsed command, never read as a read.
 */
function plainSedRead(toks: Array<{ text: string; quoted: boolean }>): string[] | null {
	const [cmd, flag, script, ...files] = toks;
	if (cmd?.text.replace(/^.*\//, "") !== "sed" || flag?.quoted || flag?.text !== "-n") return null;
	if (!script || !SED_RANGE_PRINT.test(script.text) || files.length === 0) return null;
	// The shell strips quotes and GNU sed reads options anywhere, so a quoted
	// `'--in-place'` or `'-i'` is still an option: any word starting with `-`
	// makes this not a plain read.
	if (files.some((f) => f.text.startsWith("-") || (!f.quoted && /^(?:\d+|&)?[<>|]/.test(f.text)))) return null;
	return files.map((f) => f.text);
}

/** The file an unquoted `>`/`>>` redirect writes to, if any. */
function redirectTarget(toks: Array<{ text: string; quoted: boolean }>): string | undefined {
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i] as { text: string; quoted: boolean };
		if (t.quoted) continue;
		if (t.text === ">" || t.text === ">>") return toks[i + 1]?.text;
		const glued = /^>>?([^&>].*)$/.exec(t.text);
		if (glued) return glued[1];
	}
	return undefined;
}

/** `git branch` lists with no args or listing flags; anything else changes branches. */
const BRANCH_LIST_FLAGS = new Set([
	"-a",
	"-r",
	"-l",
	"-v",
	"-vv",
	"--all",
	"--remotes",
	"--list",
	"--show-current",
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
	"--points-at",
]);
function branchMutates(args: string[]): boolean {
	const first = args[0];
	return first !== undefined && !BRANCH_LIST_FLAGS.has(first) && !first.startsWith("--sort") && !first.startsWith("--format");
}

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

/** Optional accounting shared by every path that applies a normalization cap. */
interface NormalizationCoverage {
	truncated: boolean;
}
const READ_CMDS = new Set(["cat", "sed", "head", "tail", "nl", "less", "bat"]);
const SEARCH_CMDS = new Set(["rg", "grep", "find", "ls", "fd", "tree", "ag"]);

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
	return tokens(cmd).map((t) => t.text);
}

/** Shell words, remembering which were quoted (and so are data, not syntax). */
function tokens(cmd: string): Array<{ text: string; quoted: boolean }> {
	const out: Array<{ text: string; quoted: boolean }> = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cmd)) !== null)
		out.push({ text: m[1] ?? m[2] ?? m[3] ?? "", quoted: m[3] === undefined });
	return out;
}

/** Split a stage into pipeline commands on `|` outside quotes. */
function pipeline(stage: string): string[] {
	const out: string[] = [];
	let quote: string | null = null;
	let cur = "";
	for (const ch of stage) {
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "|") {
			out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	out.push(cur.trim());
	return out;
}

/** Where a shell command runs: the workspace root and its effective directory. */
interface Where {
	root: string | null;
	/** Absolute working directory, or null when there is no workspace root. */
	dir: string | null;
	/** A dynamic `cd` or workdir moved the command somewhere unknown. */
	lost?: boolean;
}

/** Join and normalize an absolute directory with a relative path (`.`, `..`). */
function joinPath(dir: string, rel: string): string {
	const parts = dir.split("/").filter(Boolean);
	for (const seg of rel.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return `/${parts.join("/")}`;
}

/** A `cd` argument whose target cannot be known statically. */
function dynamicCd(arg: string | undefined): boolean {
	return !arg || /[$`~*]/.test(arg) || arg === "-";
}

/** The directory a `cd` argument leads to, or null when it is not static. */
function cdTo(where: Where, arg: string | undefined): string | null {
	if (dynamicCd(arg)) return null;
	if (!arg) return null;
	if (arg.startsWith("/")) return joinPath("/", arg);
	return where.dir ? joinPath(where.dir, arg) : null;
}

/**
 * A file argument made workspace-relative from where the command ran, or null
 * when a relative path's directory is unknown (a dynamic `cd` or workdir):
 * the file is then never named, rather than credited to the wrong path.
 */
function resolveIn(file: string, where: Where): string | null {
	const f = file.trim().replace(/^["']|["']$/g, "");
	if (f.startsWith("/")) return relPath(f, where.root);
	if (where.lost) return null;
	if (!where.dir) return relPath(f, where.root);
	return relPath(joinPath(where.dir, f), where.root);
}

/** A file part whose location is unknown: no target, and never a known result. */
function located(action: "read" | "write", target: string | null): Classified {
	return target === null ? { action, target: null, unlocated: true } : { action, target };
}

/** `workdir` null means one was given but could not be read (it is unknown). */
function whereFor(root: string | null | undefined, workdir: string | null | undefined): Where {
	const base = root ?? null;
	if (workdir === null) return { root: base, dir: null, lost: true };
	if (!workdir) return { root: base, dir: base };
	const dir = workdir.startsWith("/") ? joinPath("/", workdir) : base ? joinPath(base, workdir) : null;
	return { root: base, dir };
}

/** Drop `cd x &&`, env assignments and `bash -lc` wrappers to reach the real command. */
function coreCommand(cmd: string): string {
	let c = cmd.trim();
	const wrapped = /^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(c);
	if (wrapped?.[2]) c = wrapped[2].trim();
	for (;;) {
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
	/** A command that feeds a pipe: the pipeline's exit status is the last command's. */
	piped?: boolean;
	/** A file read or written in an unknown directory: no target, no known result. */
	unlocated?: boolean;
	/** False for a shell stage before the last one (dropped stages included). */
	last?: boolean;
}

/** Classify one pipeline (`a | b`); a pipeline is judged by its first command. */
function classifyStage(stage: string, where: Where, coverage?: NormalizationCoverage): Classified[] {
	const cmds = pipeline(stage);
	// A pipeline exits with its last command's status, so the command that
	// feeds it never owns that status (`npm run build | grep -q ERROR`).
	const base = classifyFirst(stage, where, coverage).map((c) =>
		cmds.length > 1 ? { ...c, piped: true } : c,
	);
	// `… | tee f` also writes f, after the command that feeds it; tee owns the
	// pipeline's status only when it is the last command.
	const teeAt = cmds.findIndex((c, i) => i > 0 && words(c)[0] === "tee");
	const teeInto = teeAt > 0 ? words(cmds[teeAt] as string).slice(1).find((w) => !w.startsWith("-")) : undefined;
	if (teeInto && !teeInto.startsWith("/dev/")) {
		const write = located("write", resolveIn(teeInto, where));
		return [...base, teeAt === cmds.length - 1 ? write : { ...write, piped: true }];
	}
	return base;
}

/** Classify a stage by the first command of its pipeline. */
function classifyFirst(stage: string, where: Where, coverage?: NormalizationCoverage): Classified[] {
	const cmds = pipeline(stage);
	const first = cmds[0] ?? "";
	const toks = tokens(first);
	const ws = commandWords(toks);
	while (ws.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0] ?? "")) ws.shift();
	const test = TEST_RE.exec(ws.join(" ").replace(RUNNER_PREFIX, ""));
	if (test) {
		// `pnpm run test` and `pnpm test` are one suite; `test:unit` is another.
		const target = test[0].replace(/\s+run\s+/, " ").replace(/\s+/g, " ");
		const piped = cmds.length > 1;
		return [piped ? { action: "test", target, piped } : { action: "test", target }];
	}
	const head = (ws[0] ?? "").replace(/^.*\//, "");
	// `cat > f <<EOF`, `printf … > f`, `echo … >> f`, `… | tee f`: writing a file.
	// Only unquoted redirects count: `echo "==> Building"` writes nothing.
	const into = WRITE_CMDS.has(head) ? redirectTarget(toks) : undefined;
	if (into && !into.startsWith("/dev/")) return [located("write", resolveIn(into, where))];
	if (!head || NOISE_CMDS.has(head)) return [];
	// sed fails closed: only `sed -n '<range>p' file…` is a read.
	const sedRead = head === "sed" ? plainSedRead(withoutLeadingEnv(toks)) : null;
	if (READ_CMDS.has(head) && (head !== "sed" || sedRead !== null)) {
		// A read also reads the file on its stdin (`cat < src/a.ts`).
		const readWords = commandWords(toks, true);
		while (readWords.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(readWords[0] ?? "")) readWords.shift();
		const files = sedRead ?? fileArgs(readWords);
		if (files.length === 0) return [{ action: "read", target: null, note: head }];
		if (coverage && files.length > MAX_STAGES) coverage.truncated = true;
		return files
			.slice(0, MAX_STAGES)
			.map((f) => located("read", resolveIn(f, where)));
	}
	// Read-only git inspection is a read of repo state, not a command that changes it.
	if (head === "git" && GIT_READS.has(ws[1] ?? "") && !(ws[1] === "branch" && branchMutates(ws.slice(2))))
		return [{ action: "read", target: `git ${ws[1]}` }];
	// Searches align regardless of tool (rg vs Grep vs find).
	if (SEARCH_CMDS.has(head)) return [{ action: "search", target: null, note: head }];
	// Scripts and tools are not parsed further: the full command (env and
	// redirects aside) is the target, so `npm run build` and `npm run lint`
	// never share a signature.
	const full = commandWords(withoutLeadingEnv(toks), true);
	return [{ action: "run", target: full.join(" ").replace(/\s+/g, " ").trim() }];
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
	/**
	 * The command is one test run and nothing else that prints (a `cd` aside),
	 * so any test summary in its output came from that run.
	 */
	solo: boolean;
}

/**
 * Classify a shell command into one step per meaningful stage:
 * `cat package.json; rg --files; npm test` is a read, a search and a test.
 * Every line counts; heredoc bodies are data, never commands.
 */
function commandParts(
	cmd: string,
	root: string | null | undefined,
	workdir?: string | null,
	coverage?: NormalizationCoverage,
): CommandParts {
	const core = coreCommand(cmd);
	const where = whereFor(root, workdir);
	const { stages: raw, seps } = splitWithSeps(core);
	// Shell control flow (`if npm test; then …`) decides what ran by itself, so
	// such scripts never hand their exit status to one stage.
	const control = raw.some((x) => CONTROL_RE.test(x));
	// Loop and case headers (`for f in a b`) are not commands themselves.
	const stages = raw.map((x) => (/^(?:for|case|select)\s/.test(x) ? "" : x.replace(CONTROL_RE, "").trim()));
	const parts: Classified[] = [];
	let printing = 0;
	stages.forEach((stage, i) => {
		const last = i === stages.length - 1;
		// A `cd` moves where the following stages run; it stays a stage, so a
		// failing `cd dir && npm test` never runs (or fails) the test.
		const w = words(stage);
		if (w[0] === "cd") {
			const to = cdTo(where, w[1]);
			// A dynamic target (`cd $DIR`, `cd -`, `cd ~x`) loses the directory;
			// without a workspace root, a static relative cd just stays relative.
			if (dynamicCd(w[1])) where.lost = true;
			where.dir = to;
		}
		else if (stage) printing++;
		for (const c of classifyStage(stage, where, coverage)) parts.push(last ? c : { ...c, last });
	});
	if (coverage && parts.some((c, i) => i >= MAX_STAGES && c.action !== "test" && c.last === false))
		coverage.truncated = true;
	const solo = !control && printing === 1 && parts.length === 1 && parts[0]?.action === "test";
	// Every separator counts, including those around dropped stages: the
	// `|| true` in `false && npm test || true` decides what the exit status means.
	return {
		// Cap noisy scripts, but never drop a test run or the final stage: they
		// decide the run's outcome and what the exit status means.
		parts: parts.filter((c, i) => i < MAX_STAGES || c.action === "test" || c.last !== false),
		chain: control ? "mixed" : parts.length > 1 || stages.length > 1 ? chainOf(seps) : "single",
		solo,
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
	coverage?: NormalizationCoverage,
): Classified[] {
	const out: Classified[] = [];
	for (const m of patch.matchAll(/\*\*\* (Update|Add|Delete) File:\s*([^\s"\\]+)/g)) {
		const file = relPath(m[2] ?? "", cwd);
		out.push({ action: m[1] === "Add" ? "write" : "edit", target: file });
	}
	if (coverage && out.length > MAX_STAGES) coverage.truncated = true;
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
	// Only an unescaped `${` makes a template dynamic; `\${` is literal text.
	if (q === "`" && /(?:^|[^\\])(?:\\\\)*\$\{/.test(body)) return undefined;
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

/** The argument text of the call that opens `body` (between its matching parens). */
function callArgs(body: string, masked: string): { text: string; masked: string } | null {
	const open = masked.indexOf("(");
	if (open < 0) return null;
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		const ch = masked[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return { text: body.slice(open + 1, i), masked: masked.slice(open + 1, i) };
		}
	}
	return null;
}

/** Split masked text on commas at nesting depth 0, as [start, end) ranges. */
function topLevelRanges(masked: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 0) {
			out.push([start, i]);
			start = i + 1;
		}
	}
	out.push([start, masked.length]);
	return out.filter(([x, y]) => masked.slice(x, y).trim() !== "");
}

/** Exactly one static string literal and nothing else, or undefined. */
function soleLiteral(text: string): string | undefined {
	const t = text.trim();
	const lit = new RegExp(String.raw`^(?:${STRING_LIT})$`, "s").exec(t)?.[0];
	return lit === undefined ? undefined : jsString(lit);
}

/**
 * A call argument read exactly, or reported as present-but-unknown.
 *
 * With a `key`, the call's only argument must be one object literal whose
 * top-level properties all have plain names. The key must appear exactly once,
 * as `key: "literal"`. A spread, a computed key or method, a duplicate, a
 * shorthand (`{workdir}`) or a non-literal value all leave the call's argument
 * unknown (`found` without a value), since any of them can change what runs.
 * Without a key, the only argument must be one string literal (a patch).
 */
function exactLiteralArg(body: string, key: string | null): { found: boolean; value?: string } {
	const masked = maskCode(body);
	const args = callArgs(body, masked);
	if (!args) return { found: true };
	const ranges = topLevelRanges(args.masked);
	if (key === null) {
		if (ranges.length !== 1) return { found: true };
		const value = soleLiteral(args.text);
		return value === undefined ? { found: true } : { found: true, value };
	}
	const obj = args.masked.trim();
	if (ranges.length !== 1 || !obj.startsWith("{") || !obj.endsWith("}")) return { found: true };
	const lead = args.masked.indexOf("{");
	const close = args.masked.lastIndexOf("}");
	const innerMasked = args.masked.slice(lead + 1, close);
	const innerText = args.text.slice(lead + 1, close);
	let value: string | undefined;
	let hits = 0;
	for (const [x, y] of topLevelRanges(innerMasked)) {
		const m = innerMasked.slice(x, y);
		const t = innerText.slice(x, y);
		const named = /^\s*([A-Za-z_$][\w$]*)\s*(:)?/.exec(m);
		const quoted = /^\s*(["'])\s*\1\s*:/.exec(m);
		let name: string | undefined;
		let colonAt = -1;
		if (named && named[1] && !["get", "set", "async"].includes(named[1])) {
			name = named[1];
			if (!named[2]) {
				// `{workdir}`: a shorthand names the key but hides its value.
				if (m.trim() !== name) return { found: true };
				if (name === key) return { found: true };
				continue;
			}
			colonAt = named[0].length;
		} else if (quoted) {
			const keyText = /^\s*(["'])(.*?)\1\s*:/s.exec(t);
			// An escaped key (`"\u0063md"`) can spell any name: never guess it.
			if (!keyText || (keyText[2] ?? "").includes("\\")) return { found: true };
			name = keyText[2];
			colonAt = keyText[0].length;
		} else {
			// Spread, computed key, method or anything else: cannot be read exactly.
			return { found: true };
		}
		if (name !== key) continue;
		hits++;
		value = soleLiteral(t.slice(colonAt));
	}
	if (hits === 0) return { found: false };
	if (hits > 1 || value === undefined) return { found: true };
	return { found: true, value };
}

/** Literal, straight-line calls for branch reconstruction and commit evidence.
 * This stricter reader does not change Run Diff's normalization contract.
 */
export function literalExecCalls(input: string): Array<{
	name: string;
	command?: string;
	workdir?: string;
	patch?: string;
	path?: string;
	content?: string;
}> | null {
	// Unsupported JS escapes must never turn executable shell syntax into data.
	const literal = (text: string): string | undefined => {
		const t = text.trim();
		if (t.startsWith('"')) {
			try { const v: unknown = JSON.parse(t); return typeof v === "string" ? v : undefined; }
			catch { return undefined; }
		}
		if (/\\(?![\\'"`ntr])/.test(t)) return undefined;
		return soleLiteral(t);
	};
	const masked = maskCode(input);
	const out: NonNullable<ReturnType<typeof literalExecCalls>> = [];
	let offset = 0;
	while (masked.slice(offset).trim()) {
		const start = /^\s*(?:text\s*\(\s*await\s+|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+)tools\.([A-Za-z0-9_]+)\s*\(/.exec(masked.slice(offset));
		if (!start) return null;
		const open = offset + start[0].length - 1;
		let end = open + 1;
		let depth = 1;
		for (; end < masked.length && depth; end++) {
			if (masked[end] === "(") depth++;
			if (masked[end] === ")") depth--;
		}
		if (depth) return null;
		const tail = start[1]
			? new RegExp(String.raw`^\s*;\s*text\s*\(\s*${start[1].replaceAll("$", "\\$")}\s*\)\s*;?`)
			: /^\s*\)\s*;?/;
		const finish = tail.exec(masked.slice(end));
		if (!finish) return null;
		const body = input.slice(open - 1, end);
		const name = start[2]!;
		if (name === "apply_patch") {
			const patch = literal(callArgs(body, maskCode(body))?.text ?? "");
			if (patch === undefined) return null;
			out.push({ name, patch });
		} else {
			const args = callArgs(body, maskCode(body));
			if (!args) return null;
			const text = args.text.trim();
			if (!text.startsWith("{") || !text.endsWith("}")) return null;
			const inner = text.slice(1, -1);
			const values = new Map<string, string | undefined>();
			for (const [a, b] of topLevelRanges(maskCode(inner))) {
				const prop = /^\s*(?:([A-Za-z_$][\w$]*)|(["'])([A-Za-z_$][\w$]*)\2)\s*:\s*([\s\S]*)$/.exec(inner.slice(a, b));
				const key = prop?.[1] ?? prop?.[3];
				if (!prop || !key || values.has(key)) return null;
				const raw = prop[4]!.trim();
				const value = literal(raw);
				if (value === undefined && !/^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(raw)) return null;
				values.set(key, value);
			}
			const workdir = values.get("workdir");
			if (values.has("workdir") && workdir === undefined) return null;
			const command = values.get("cmd");
			if (name === "exec_command" && command === undefined) return null;
			out.push({ name, command, workdir, path: values.get("path") ?? values.get("file_path"), content: values.get("content") });
		}
		offset = end + finish[0].length;
	}
	return out.length ? out : null;
}

/**
 * One unit of work with its own result: a shell command (possibly several
 * stages), a single tool call, or one call inside a Codex `exec` cell.
 */
interface Unit {
	parts: Classified[];
	chain: Chain;
	/** See `CommandParts.solo`: only then can a test summary speak for the test. */
	solo?: boolean;
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
 * The cell's code with every comment and string body blanked to spaces (quote
 * marks kept, length unchanged), so a call that appears in a comment, a patch
 * body or a string is never read as a call, and indices still line up with the
 * original text for reading literal arguments.
 */
export function maskCode(code: string): string {
	let out = "";
	let i = 0;
	while (i < code.length) {
		const ch = code[i] as string;
		const next = code[i + 1];
		if (ch === "/" && next === "/") {
			const end = code.indexOf("\n", i);
			const stop = end < 0 ? code.length : end;
			out += " ".repeat(stop - i);
			i = stop;
		} else if (ch === "/" && next === "*") {
			const end = code.indexOf("*/", i + 2);
			const stop = end < 0 ? code.length : end + 2;
			out += code.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop;
		} else if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1;
			while (j < code.length && code[j] !== ch) j += code[j] === "\\" ? 2 : 1;
			const stop = Math.min(j + 1, code.length);
			out += ch + code.slice(i + 1, stop - 1).replace(/[^\n]/g, " ") + (stop - 1 > i ? ch : "");
			i = stop;
		} else {
			out += ch;
			i++;
		}
	}
	return out.slice(0, code.length);
}

/** Anything that makes a cell's flow non-linear or its printing ambiguous. */
const COMPLEX_RE =
	/\b(?:if|else|for|while|do|switch|case|try|catch|finally|function|class|return|yield|new|Promise)\b|=>|\?|&&|\|\||\.then\s*\(/;

/**
 * Whether a masked cell is straight-line: no branches, loops, functions,
 * promises or short-circuits, and every tool call is a top-level awaited
 * statement that prints its own result exactly once, either inline
 * (`text(await tools.x(…))`) or right after (`const r = await tools.x(…);
 * text(r)`), with nothing else printed. Only then does the n-th printed part
 * belong to the n-th call.
 */
function straightLine(masked: string, calls: RegExpMatchArray[]): boolean {
	if (calls.length === 0 || COMPLEX_RE.test(masked)) return false;
	const prints = [...masked.matchAll(/\btext\s*\(/g)].length;
	if (prints !== calls.length) return false;
	let depth = 0;
	let k = 0;
	for (let i = 0; i < masked.length && k < calls.length; i++) {
		const at = calls[k]?.index ?? -1;
		if (i === at) {
			if (depth !== 0) return false;
			const before = masked.slice(Math.max(0, at - 40), at);
			const end = calls[k + 1]?.index ?? masked.length;
			const after = masked.slice(at, end);
			const inline = /text\(\s*(?:String\(\s*)?await\s+$/.test(before);
			const name = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+$/.exec(before)?.[1];
			const later = name
				? [...after.matchAll(/\btext\(\s*(?:String\(\s*)?([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
				: [];
			if (!inline && !(name && later.length === 1 && later[0] === name)) return false;
			k++;
		}
		const ch = masked[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
	}
	return k === calls.length;
}

/** The result one printed part proves for the call it belongs to. */
function partResult(tool: string, part: ExecPart | undefined, completed: boolean): UnitResult {
	if (!part || !completed) return UNKNOWN;
	if (CHUNKED.has(tool)) return part.kind === "chunk" ? chunkResult(part.result) : UNKNOWN;
	// A patch applied only when its own result is the `{}` apply_patch prints.
	if (tool === "apply_patch") return part.kind === "empty-object" ? OK : UNKNOWN;
	return part.kind === "other" && part.error ? UNKNOWN : OK;
}

const OK: UnitResult = { result: "ok", testFailures: false, testPasses: false };

/**
 * Current Codex rollouts route tools through a JS `exec` cell, e.g.
 * `text(await tools.exec_command({cmd:"pnpm test"}))`. Each call becomes its
 * own unit, and fails closed: results are read only from a straight-line cell
 * that ran to completion, where the n-th printed part is the n-th call's own
 * result. Any other cell keeps its calls visible with unknown results, except
 * that a cell failing on `apply_patch` marks its single patch failed.
 */
function codexExecCell(step: Step, input: string, cwd: string | null | undefined, coverage?: NormalizationCoverage): Unit[] {
	const masked = maskCode(input);
	const calls = [...masked.matchAll(CELL_CALL_RE)];
	const rawParts = step.attributes[ATTR.EXEC_PARTS];
	const printed = Array.isArray(rawParts) ? (rawParts as ExecPart[]) : [];
	const completed = step.attributes[ATTR.EXEC_COMPLETED] === true;
	const linear = straightLine(masked, calls) && printed.length === calls.length;
	const patches = calls.filter((c) => c[1] === "apply_patch").length;
	const patchFailed =
		!completed && patches === 1 && /apply_patch|patch rejected/i.test(String(step.attributes[ATTR.TOOL_ERROR] ?? ""));
	const out: Unit[] = [];
	calls.forEach((call, i) => {
		const tool = call[1] ?? "";
		const body = input.slice(call.index ?? 0, calls[i + 1]?.index ?? input.length);
		const res: UnitResult =
			tool === "apply_patch" && patchFailed
				? { result: "error", testFailures: false, testPasses: false }
				: linear
					? partResult(tool, printed[i], completed)
					: UNKNOWN;
		if (tool === "exec_command") {
			const cmd = exactLiteralArg(body, "cmd");
			// A workdir that is present but not one static literal is unknown.
			const wd = exactLiteralArg(body, "workdir");
			const workdir = wd.found ? (wd.value ?? null) : undefined;
			const unit = cmd.value !== undefined
				? { ...commandParts(cmd.value, cwd, workdir, coverage), ...res }
				: // A command we cannot read statically still happened: keep it, unresolved.
					{ parts: [{ action: "run" as const, target: null, note: "unparsed command" }], chain: "single" as const, ...res };
			out.push(unit);
		} else if (tool === "write_stdin") {
			const session = /\bsession_id["']?\s*:\s*["']?([\w-]+)/.exec(body)?.[1];
			if (session) out.push({ parts: [], chain: "single", ...res, pollOf: session });
		} else if (tool === "apply_patch") {
			const patch = exactLiteralArg(body, null).value ?? "";
			const parts = patchTargets(patch, cwd, coverage);
			out.push({ parts: parts.length ? parts : [{ action: "edit", target: null }], chain: "single", ...res });
		} else if (tool === "update_plan") {
			out.push({ parts: [{ action: "plan", target: null }], chain: "single", ...res });
		} else if (/^web/.test(tool)) {
			out.push({ parts: [{ action: "web", target: null }], chain: "single", ...res });
		} else {
			out.push({ parts: [{ action: "other", target: tool }], chain: "single", ...res });
		}
	});
	// Evidence only ever comes from a call's own part; never share it.
	if (!linear)
		for (const u of out) {
			u.solo = false;
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

function toolUnits(step: Step, cwd: string | null | undefined, coverage?: NormalizationCoverage): Unit[] {
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
			const parts = patchTargets(input, cwd, coverage);
			// A patch counts as applied only when its own output said so.
			const own = stepResult(step);
			const result: DiffStatus =
				own.result !== "ok" ? own.result : step.attributes[ATTR.PATCH_CONFIRMED] === true ? "ok" : "unknown";
			return [
				{ parts: parts.length ? parts : [{ action: "edit", target: null }], chain: "single", ...own, result },
			];
		}
		case "exec": {
			const units = codexExecCell(step, str(args["input"]) ?? "", cwd, coverage);
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
				// The first workdir field actually given; an empty string is not one.
				const raw = [args["workdir"], args["working_directory"], args["cwd"]].find(
					(v) => v !== undefined && v !== null && v !== "",
				);
				const workdir = raw === undefined ? undefined : (str(raw) ?? null);
				return [{ ...commandParts(cmd, cwd, workdir, coverage), ...yieldedOr(step) }];
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
	// The full target identifies the step; only the label is clipped, so two
	// long paths that share a prefix never collapse into one signature.
	const target = c.target;
	const shown = target ? clipForDisplay(target) : null;
	const out: DiffStep = {
		index,
		stepId: step.step_id,
		action: c.action,
		target,
		label: shown
			? `${VERB[c.action]} ${shown}`
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

/**
 * Give each part of a unit a result, inventing none.
 *
 * Exit status: a single command owns it; an `&&` chain that succeeded ran every
 * stage successfully; a `;` chain only reports its last stage; a mixed chain
 * (`a && b || c`) says nothing about any one stage; a piped test reports the
 * pipe's last command, not the test. A failing summary line marks the test
 * failed whatever the exit said, but only when the unit is that test run alone
 * (`solo`). Everything else without evidence is `unknown`.
 */
export function resolveStatuses(
	parts: Classified[],
	chain: Chain,
	result: DiffStatus | "pending",
	testFailures: boolean,
	solo = false,
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
		if (c.unlocated) return "unknown";
		if (owns(i)) return result as DiffStatus;
		// No other part is vouched for: a `;` chain keeps going after a failed
		// stage (`cat missing.ts; true`, `echo x > missing/f; true`).
		return "unknown";
	});
	// A failing summary speaks for the test only when nothing else could have
	// printed it (`cat old.log; npm test` could).
	if (solo && testFailures) out[0] = failedResult ? (result as DiffStatus) : "error";
	return out;
}

/**
 * The test summary a unit's output carries, tied to its test only when the unit
 * is that test run alone (`CommandParts.solo`). A passing summary is recorded, never promoted to
 * an exit status: "passed" needs both (see `runVerdict`).
 */
function summaries(
	parts: Classified[],
	testFailures: boolean,
	testPasses: boolean,
	solo = false,
): Array<DiffStep["summary"]> {
	const sum = testFailures ? "fail" : testPasses ? "pass" : undefined;
	return parts.map(() => (solo ? sum : undefined));
}

function stepUnits(step: Step, cwd: string | null | undefined, coverage?: NormalizationCoverage): Unit[] {
	if (step.kind === "tool_call") {
		if (step.attributes[ATTR.GUARD_TRIPPED]) {
			const first = toolUnits(step, cwd, coverage)[0]?.parts[0];
			const guard = str(step.attributes[ATTR.GUARD_NAME]) ?? "guard";
			return [
				{
					parts: [{ action: "blocked", target: `${guard}: ${first?.action ?? "call"}` }],
					chain: "single",
					...stepResult(step),
				},
			];
		}
		return toolUnits(step, cwd, coverage);
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

/**
 * Report caps using the same classifiers as normalizeTrace, without changing its
 * output. Main-context sources must be checked even when they emit no DiffSteps.
 */
export function sourceNormalizationTruncated(step: Step, cwd?: string | null): boolean {
	if (step.subagent_id) return false;
	const coverage: NormalizationCoverage = { truncated: false };
	stepUnits(step, cwd, coverage);
	return coverage.truncated;
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
				const statuses = resolveStatuses(orig.parts, orig.chain, unit.result, orig.testFailures, orig.solo);
				const sums = summaries(orig.parts, orig.testFailures, orig.testPasses, orig.solo);
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
			const statuses = resolveStatuses(parts, unit.chain, unit.result, unit.testFailures, unit.solo);
			const sums = summaries(parts, unit.testFailures, unit.testPasses, unit.solo);
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
