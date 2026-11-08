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
	/^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|node\s+--test\b|python3?\s+-m\s+(?:pytest|unittest)\b|pytest\b|cargo\s+(?:test|nextest)\b|go\s+test\b|vitest\b|jest\b|swift\s+test\b|make\s+test\b|xcodebuild\b.*\btest\b)/;
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
	const first = (stage.split(/\s*\|\s*/)[0] ?? "").trim();
	const ws = words(first).filter((w) => !/^\d*[<>]/.test(w));
	while (ws.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0] ?? "")) ws.shift();
	const test = TEST_RE.exec(ws.join(" ").replace(RUNNER_PREFIX, ""));
	if (test) return [{ action: "test", target: test[0].replace(/\s+/g, " ") }];
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

/** How a compound command's stages were chained. */
type Chain = "single" | "seq" | "and" | "mixed";

/**
 * Split on `;`, `&&` and `||` outside quotes (`node -e "a; b"` stays whole),
 * keeping the separators.
 */
function splitWithSeps(line: string): { stages: string[]; seps: string[] } {
	const stages: string[] = [];
	const seps: string[] = [];
	let quote: string | null = null;
	let cur = "";
	const flush = (sep: string | null) => {
		const t = cur.trim();
		if (t) {
			stages.push(t);
			if (sep) seps.push(sep);
		}
		cur = "";
	};
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
 * Only the first line counts, so heredoc bodies are never parsed as commands.
 */
function commandParts(cmd: string, cwd: string | null | undefined): CommandParts {
	const core = coreCommand(cmd);
	const { stages, seps } = splitWithSeps(core.split("\n")[0] ?? "");
	const parts: Classified[] = [];
	const kept: string[] = [];
	let lastKept = -1;
	stages.forEach((stage, i) => {
		const got = classifyStage(stage, cwd);
		if (got.length === 0) return;
		// The separator that decides whether this stage ran after the previous kept one.
		if (lastKept >= 0) kept.push(seps[i - 1] ?? ";");
		parts.push(...got);
		lastKept = i;
	});
	return { parts: parts.slice(0, MAX_STAGES), chain: parts.length > 1 ? chainOf(kept) : "single" };
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
 * One unit of work with its own result: a shell command (possibly several
 * stages), a single tool call, or one call inside a Codex `exec` cell.
 */
interface Unit {
	parts: Classified[];
	chain: Chain;
	result: DiffStatus | "pending";
	testFailures: boolean;
	/** A yielded command waiting on this session's final result. */
	sessionId?: string;
	/** A `write_stdin` poll of this session; carries no steps of its own. */
	pollOf?: string;
}

/** Calls in an exec cell that write one result chunk each. */
const CHUNKED = new Set(["exec_command", "write_stdin"]);

function chunkResult(r: ExecResult | undefined): Pick<Unit, "result" | "testFailures" | "sessionId"> {
	if (!r) return { result: "unknown", testFailures: false };
	const testFailures = r.test_failures;
	if (r.exit_code !== null) return { result: r.exit_code === 0 ? "ok" : "error", testFailures };
	if (r.session_id) return { result: "pending", testFailures, sessionId: r.session_id };
	return { result: "unknown", testFailures };
}

/**
 * Current Codex rollouts route tools through a JS `exec` cell, e.g.
 * `text(await tools.exec_command({cmd:"pnpm test"}))`. One cell may call several
 * tools; each call becomes its own unit, matched in order to its own result
 * chunk when the parser recorded one chunk per call.
 */
function codexExecCell(step: Step, input: string, cwd: string | null | undefined): Unit[] {
	const calls = [...input.matchAll(CELL_CALL_RE)];
	const raw = step.attributes[ATTR.EXEC_RESULTS];
	const results = Array.isArray(raw) ? (raw as ExecResult[]) : [];
	const chunked = calls.filter((c) => CHUNKED.has(c[1] ?? "")).length;
	const perCall = results.length > 0 && results.length === chunked;
	const fallback = stepResult(step);
	let k = 0;
	const out: Unit[] = [];
	calls.forEach((call, i) => {
		const tool = call[1] ?? "";
		const body = input.slice(call.index ?? 0, calls[i + 1]?.index ?? input.length);
		// Without one chunk per call, the cell's own result only speaks for a
		// lone command (or for all of them when the cell succeeded).
		const res = CHUNKED.has(tool)
			? perCall
				? chunkResult(results[k++])
				: fallback.result === "ok" || chunked === 1
					? fallback
					: { result: "unknown" as const, testFailures: fallback.testFailures }
			: { result: "ok" as const, testFailures: false };
		if (tool === "exec_command") {
			const lit = new RegExp(String.raw`\bcmd"?\s*:\s*(${STRING_LIT})`).exec(body)?.[1];
			const cmd = lit ? jsString(lit) : undefined;
			if (cmd !== undefined) out.push({ ...commandParts(cmd, cwd), ...res });
		} else if (tool === "write_stdin") {
			const session = /\bsession_id"?\s*:\s*"?([\w-]+)/.exec(body)?.[1];
			if (session) out.push({ parts: [], chain: "single", ...res, pollOf: session });
		} else if (tool === "apply_patch") {
			const lit = new RegExp(String.raw`\(\s*(${STRING_LIT})`).exec(body)?.[1];
			const patch = lit ? jsString(lit) : body;
			out.push({ parts: patchTargets(patch ?? body, cwd), chain: "single", ...res });
		} else if (tool === "update_plan") {
			out.push({ parts: [{ action: "plan", target: null }], chain: "single", ...res });
		} else if (/^web/.test(tool)) {
			out.push({ parts: [{ action: "web", target: null }], chain: "single", ...res });
		} else {
			out.push({ parts: [{ action: "other", target: tool }], chain: "single", ...res });
		}
	});
	return out;
}

function stepResult(step: Step): { result: DiffStatus; testFailures: boolean } {
	return {
		result: step.status ?? "ok",
		testFailures: step.attributes[ATTR.TEST_FAILURES] === true,
	};
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
			const cmd = commandOf(args);
			if (cmd !== undefined) {
				const { parts, chain } = commandParts(cmd, cwd);
				return one(parts, chain);
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
 * Give each part of a unit a result, inventing none. A known result covers a
 * single-part unit. In a failed compound command only the evidence decides:
 * a test whose output reports failures failed (later stages may not have run);
 * in a `;` chain the exit status is the last stage's; otherwise the failing
 * stage is unknown. Commands with no evidence of their own stay `unknown`.
 */
export function resolveStatuses(
	parts: Classified[],
	chain: Chain,
	result: DiffStatus | "pending",
	testFailures: boolean,
): DiffStatus[] {
	const n = parts.length;
	const out: DiffStatus[] = parts.map(() => "ok");
	const tests = parts.flatMap((c, i) => (c.action === "test" ? [i] : []));
	const flaggedTest = testFailures && tests.length === 1 ? (tests[0] as number) : -1;
	if (result === "pending" || result === "unknown") {
		parts.forEach((c, i) => {
			if (n === 1 || isCommand(c)) out[i] = "unknown";
		});
		if (flaggedTest >= 0) out[flaggedTest] = "error";
		return out;
	}
	if (result === "ok") {
		// A piped test can exit 0 while its output reports failures.
		if (flaggedTest >= 0) out[flaggedTest] = "error";
		else if (testFailures) for (const t of tests) out[t] = "unknown";
		return out;
	}
	// error / interrupted
	if (n === 1) return [result];
	if (flaggedTest >= 0) {
		out[flaggedTest] = result;
		for (let i = flaggedTest + 1; i < n; i++) {
			// After `&&` nothing ran; after `;` later stages ran with unknown results.
			if (chain !== "seq" || isCommand(parts[i] as Classified)) out[i] = "unknown";
		}
		// A `;` chain exits with its last stage's status.
		if (chain === "seq" && n - 1 > flaggedTest) out[n - 1] = result;
		return out;
	}
	if (chain === "seq") {
		out[n - 1] = result;
		for (let i = 0; i < n - 1; i++) if (isCommand(parts[i] as Classified)) out[i] = "unknown";
		return out;
	}
	if (!parts.some(isCommand)) {
		out[n - 1] = result;
		return out;
	}
	// Some stage of an `&&`/mixed chain failed and nothing says which.
	return parts.map(() => "unknown");
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
				if (!waiting || unit.result === "pending") continue;
				const { unit: orig, steps } = waiting;
				const statuses = resolveStatuses(
					orig.parts,
					orig.chain,
					unit.result,
					orig.testFailures || unit.testFailures,
				);
				steps.forEach((d, i) => {
					d.status = statuses[i] ?? "unknown";
					if (isFailure(d.status) && error) d.error = clip(error.trim(), ERROR_MAX);
				});
				pending.delete(unit.pollOf);
				continue;
			}
			const parts = rewritesAsEdits(unit.parts, seen);
			if (parts.length === 0) continue;
			const statuses = resolveStatuses(parts, unit.chain, unit.result, unit.testFailures);
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
			out.push(...made);
			if (unit.result === "pending" && unit.sessionId)
				pending.set(unit.sessionId, { unit: { ...unit, parts }, steps: made });
		}
	}
	return out;
}
