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

import { ATTR, type Step, type Trace } from "../types.ts";
import type { DiffAction, DiffStep } from "./types.ts";

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
 * Test-runner invocations, checked before the generic `run` bucket. The match
 * itself becomes the target, so flags and redirects never split two runs of the
 * same suite.
 */
const TEST_RE =
	/\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|node\s+--test\b|python3?\s+-m\s+(?:pytest|unittest)\b|pytest\b|cargo\s+(?:test|nextest)\b|go\s+test\b|vitest\b|jest\b|swift\s+test\b|make\s+test\b|xcodebuild\b.*\btest\b)/;
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
}

/** Classify one pipeline (`a | b`); a pipeline is judged by its first command. */
function classifyStage(
	stage: string,
	cwd: string | null | undefined,
): Classified[] {
	const test = TEST_RE.exec(stage);
	if (test) return [{ action: "test", target: test[0].replace(/\s+/g, " ") }];
	const first = (stage.split(/\s*\|\s*/)[0] ?? "").trim();
	const ws = words(first).filter((w) => !/^\d*[<>]/.test(w));
	const head = (ws[0] ?? "").replace(/^.*\//, "");
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

/** Split on `;`, `&&` and `||` outside quotes (`node -e "a; b"` stays whole). */
export function splitStages(line: string): string[] {
	const out: string[] = [];
	let quote: string | null = null;
	let cur = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote) {
			if (ch === "\\" && quote === '"') {
				cur += ch + (line[i + 1] ?? "");
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		const two = line.slice(i, i + 2);
		if (ch === ";" || two === "&&" || two === "||") {
			out.push(cur.trim());
			cur = "";
			if (ch !== ";") i++;
			continue;
		}
		cur += ch;
	}
	out.push(cur.trim());
	return out.filter(Boolean);
}

/**
 * Classify a shell command into one step per meaningful stage:
 * `cat package.json; rg --files; npm test` is a read, a search and a test.
 * Only the first line counts, so heredoc bodies are never parsed as commands.
 */
export function classifyCommand(
	cmd: string,
	cwd: string | null | undefined,
): Classified[] {
	const core = coreCommand(cmd);
	const firstLine = core.split("\n")[0] ?? "";
	const out: Classified[] = [];
	for (const stage of splitStages(firstLine)) {
		out.push(...classifyStage(stage.trim(), cwd));
		if (out.length >= MAX_STAGES) break;
	}
	return out.slice(0, MAX_STAGES);
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

/** Decode a JS/JSON string literal, or undefined when it does not parse. */
function jsString(lit: string): string | undefined {
	try {
		const v = JSON.parse(lit) as unknown;
		return typeof v === "string" ? v : undefined;
	} catch {
		return undefined;
	}
}

const CELL_CALL_RE = /tools\.([A-Za-z0-9_]+)\s*\(/g;
const STRING_LIT = String.raw`"(?:[^"\\]|\\.)*"`;

/**
 * Current Codex rollouts route tools through a JS `exec` cell, e.g.
 * `text(await tools.exec_command({cmd:"pnpm test"}))`. One cell may call several
 * tools; each call becomes its own step.
 */
function codexExecCell(input: string, cwd: string | null | undefined): Classified[] {
	const calls = [...input.matchAll(CELL_CALL_RE)];
	const out: Classified[] = [];
	calls.forEach((call, i) => {
		const tool = call[1] ?? "";
		const from = call.index ?? 0;
		const to = calls[i + 1]?.index ?? input.length;
		const body = input.slice(from, to);
		if (tool === "exec_command") {
			const lit = new RegExp(String.raw`\bcmd"?\s*:\s*(${STRING_LIT})`).exec(body)?.[1];
			const cmd = lit ? jsString(lit) : undefined;
			if (cmd !== undefined) out.push(...classifyCommand(cmd, cwd));
		} else if (tool === "apply_patch") {
			const lit = new RegExp(String.raw`\(\s*(${STRING_LIT})`).exec(body)?.[1];
			const patch = lit ? jsString(lit) : body;
			out.push(...patchTargets(patch ?? body, cwd));
		} else if (tool === "update_plan") {
			out.push({ action: "plan", target: null });
		} else if (/^web/.test(tool)) {
			out.push({ action: "web", target: null });
		} else if (tool !== "write_stdin") {
			out.push({ action: "other", target: tool });
		}
	});
	return out.slice(0, MAX_STAGES);
}

function classifyTool(step: Step, cwd: string | null | undefined): Classified[] {
	const name = str(step.attributes[ATTR.TOOL_NAME]) ?? "";
	const args = asObj(step.attributes[ATTR.TOOL_ARGS]);
	const file = str(args["file_path"]) ?? str(args["path"]) ?? str(args["notebook_path"]);
	const rel = file ? relPath(file, cwd) : null;
	switch (name) {
		case "Read":
		case "read_file":
			return [{ action: "read", target: rel }];
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
			return [{ action: "edit", target: rel }];
		case "Write":
			return [{ action: "write", target: rel }];
		case "Grep":
		case "Glob":
		case "LS":
			return [{ action: "search", target: null, note: name.toLowerCase() }];
		case "TodoWrite":
		case "ExitPlanMode":
		case "update_plan":
			return [{ action: "plan", target: null }];
		case "WebFetch":
		case "WebSearch":
		case "web_search":
			return [{ action: "web", target: null }];
		case "apply_patch": {
			const input = str(args["input"]) ?? str(args["patch"]) ?? "";
			const out = patchTargets(input, cwd);
			return out.length ? out : [{ action: "edit", target: null }];
		}
		case "exec": {
			const out = codexExecCell(str(args["input"]) ?? "", cwd);
			return out.length ? out : [{ action: "other", target: "exec" }];
		}
		default: {
			const cmd = commandOf(args);
			if (cmd !== undefined) return classifyCommand(cmd, cwd);
			return [{ action: "other", target: name || null }];
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
	status: DiffStep["status"],
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
	if (status !== "ok" && error) out.error = clip(error.trim(), ERROR_MAX);
	return out;
}

/**
 * Which sub-step of a compound step owns its failure: the test run if there is
 * one, else the last command, else the last sub-step.
 */
function failureOwner(parts: Classified[]): number {
	const test = parts.findIndex((p) => p.action === "test");
	if (test >= 0) return test;
	for (let i = parts.length - 1; i >= 0; i--)
		if (parts[i]?.action === "run") return i;
	return parts.length - 1;
}

function classifyStep(step: Step, cwd: string | null | undefined): Classified[] {
	if (step.kind === "tool_call") {
		const parts = classifyTool(step, cwd);
		if (step.attributes[ATTR.GUARD_TRIPPED]) {
			const guard = str(step.attributes[ATTR.GUARD_NAME]) ?? "guard";
			return [{ action: "blocked", target: `${guard}: ${parts[0]?.action ?? "call"}` }];
		}
		return parts;
	}
	if (step.kind === "agent")
		return [{ action: "delegate", target: str(step.attributes[ATTR.AGENT_TYPE]) ?? "subagent" }];
	if (step.kind === "compaction") return [{ action: "compaction", target: null }];
	if (step.kind === "hook" && step.attributes[ATTR.HOOK_VERDICT] === "deny")
		return [{ action: "blocked", target: str(step.attributes[ATTR.HOOK_EVENT]) ?? "hook" }];
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
	for (const step of trace.steps) {
		if (step.subagent_id) continue;
		const parts = rewritesAsEdits(classifyStep(step, cwd), seen);
		if (parts.length === 0) continue;
		const status = step.status ?? "ok";
		const owner = status === "ok" ? -1 : failureOwner(parts);
		const testsFailed = step.attributes[ATTR.TEST_FAILURES] === true;
		const error = str(step.attributes[ATTR.TOOL_ERROR]);
		parts.forEach((c, i) => {
			// A piped test run can exit 0 while its output reports failures.
			if (c.action === "test" && testsFailed && i !== owner) {
				out.push(make(step, out.length, c, "error", "output reports failing tests"));
				return;
			}
			out.push(make(step, out.length, c, i === owner ? status : "ok", error));
		});
	}
	return out;
}
