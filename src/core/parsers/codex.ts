/**
 * Parse a Codex session rollout (`~/.codex/.../rollout-*.jsonl`) into the same
 * plumbline-compatible Trace the Claude Code parser emits, so the detector engine
 * and UI work unchanged across both tools — the cross-tool wedge.
 *
 * Codex rollout shape (reverse-engineered from real transcripts, read-only):
 *   envelope: { timestamp, type, payload }
 *   type "session_meta"  -> run metadata (id, cwd, cli_version, originator)
 *   type "turn_context"  -> per-turn model + approval_policy + sandbox + mode
 *   type "response_item" payload.type:
 *     message (role assistant/user, content[].text)  -> llm turn / plan
 *     reasoning                                       -> flags next llm turn
 *     function_call / function_call_output (call_id)  -> tool_call (+ exit-code error)
 *     custom_tool_call / *_output (call_id)           -> tool_call (e.g. apply_patch)
 *     web_search_call (status)                        -> standalone tool_call
 *   type "event_msg" payload.type:
 *     token_count.info.total_token_usage              -> cumulative usage (per-turn delta)
 *     context_compacted / task_complete
 *   type "compacted"     -> compaction boundary
 *
 * Defensive throughout: a single malformed event never aborts the run.
 */

import { literalExecCalls } from "../diff/normalize.ts";
import { isCommitCommand } from "../shell-evidence.ts";
import { parseJsonlWithStats } from "../jsonl.ts";
import { hasTestFailures, hasTestPasses } from "../test-signal.ts";
import {
	ATTR,
	type ExecPart,
	type ExecResult,
	type Run,
	type Step,
	type Trace,
} from "../types.ts";

const PLUMBLINE_VERSION = "0.1.0";
const HARNESS_NAME = "codex";
const EPOCH = "1970-01-01T00:00:00Z";
const SUMMARY_MAX = 600;
const PLAN_MAX = 2000;
const ERROR_MAX = 500;

/** Codex tool name -> coarse result kind. */
const RESULT_KIND: Record<string, string> = {
	exec_command: "bash",
	shell: "bash",
	local_shell: "bash",
	local_shell_call: "bash",
	bash: "bash",
	apply_patch: "edit",
	write_file: "write",
	read_file: "read",
	web_search: "search",
};

/**
 * A legacy shell tool output carries this header before its `Output:` body; a
 * non-zero code is a failed call. Only the header is searched, so a command
 * that prints an old log containing the phrase is never misread.
 */
const EXIT_RE = /Process exited with code (\d+)/;
const HEADER_MAX = 400;
/** A plain-format command that yielded before exiting. */
const RUNNING_RE = /Process running with session ID (\w+)/;

function legacyExit(raw: unknown): RegExpExecArray | null {
	if (typeof raw !== "string") return null;
	const header = (raw.split(/\nOutput:/)[0] ?? "").slice(0, HEADER_MAX);
	return EXIT_RE.exec(header);
}

/** Every numeric `exit_code` anywhere inside a parsed JSON value. */
function nestedExitCodes(v: unknown, out: number[] = []): number[] {
	if (Array.isArray(v)) for (const x of v) nestedExitCodes(x, out);
	else if (typeof v === "object" && v !== null)
		for (const [k, x] of Object.entries(v as Json)) {
			if (k === "exit_code" && typeof x === "number") out.push(x);
			else nestedExitCodes(x, out);
		}
	return out;
}

type Json = Record<string, unknown>;

function asObj(v: unknown): Json {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Json)
		: {};
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number {
	return typeof v === "number" ? v : 0;
}
function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) : s;
}

/** Tool output text: a plain string, or (current rollouts) a list of text parts. */
function outputText(v: unknown): string {
	if (typeof v === "string") return v;
	return (Array.isArray(v) ? v : [])
		.map(asObj)
		.map((b) => str(b["text"]))
		.filter((t): t is string => Boolean(t))
		.join("\n");
}

/**
 * Current `exec` cells report each inner command as its own JSON chunk
 * (`{"chunk_id", "exit_code" | "session_id", "output"}`), one text part each,
 * in call order. Parse those parts only, never free text that merely contains
 * an `exit_code` key.
 */
function execResults(v: unknown): { results: ExecResult[]; aggregateExits: number[] } {
	const results: ExecResult[] = [];
	const aggregateExits: number[] = [];
	for (const part of Array.isArray(v) ? v : []) {
		const text = str(asObj(part)["text"])?.trim();
		if (!text || !/^[[{]/.test(text)) continue;
		if (!text.includes('"chunk_id"') && !text.includes("exit_code")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			continue;
		}
		const chunk = asObj(parsed);
		if (!("chunk_id" in chunk)) {
			// Possibly an aggregate the cell printed itself (e.g. Promise.allSettled):
			// evidence that some command failed, but not which one. The caller
			// decides whether the cell's code makes it one.
			aggregateExits.push(...nestedExitCodes(parsed));
			continue;
		}
		const exit = chunk["exit_code"];
		const session = chunk["session_id"];
		const body = str(chunk["output"]) ?? "";
		results.push({
			exit_code: typeof exit === "number" ? exit : null,
			session_id:
				typeof session === "number" || typeof session === "string"
					? String(session)
					: null,
			test_failures: hasTestFailures(body),
			test_passes: hasTestPasses(body),
		});
	}
	return { results, aggregateExits };
}

/** The header an exec cell's output starts with. */
const CELL_HEADER_RE = /^Script (?:completed|failed)\b/;
const ERROR_TEXT_RE = /\b(?:error|failed|rejected|invalid)\b/i;

/**
 * An exec cell's printed parts after its header, in order. Each is kept as
 * evidence for exactly one call; the normalizer decides whether the cell is
 * simple enough to match parts to calls.
 */
function execParts(v: unknown): ExecPart[] {
	const out: ExecPart[] = [];
	(Array.isArray(v) ? v : []).forEach((part, i) => {
		const text = (str(asObj(part)["text"]) ?? "").trim();
		if (i === 0 && CELL_HEADER_RE.test(text)) return;
		if (text === "{}") {
			out.push({ kind: "empty-object" });
			return;
		}
		if (text.startsWith("{") && text.includes('"chunk_id"')) {
			const [result] = execResults([part]).results;
			if (result) {
				out.push({ kind: "chunk", result });
				return;
			}
		}
		out.push({ kind: "other", error: ERROR_TEXT_RE.test(text) });
	});
	return out;
}

/** A legacy `apply_patch` output that says it applied. */
const PATCH_OK_RE = /^(?:Success\b|Done!)|"exit_code"\s*:\s*0\b/;
const GIT_COMMIT_RE = /^\[(.+?)(?: \(root-commit\))? ([0-9a-fA-F]{4,40})\] .+$/m;
/** Only a completed literal call's own successful output can claim a commit. */
function execCellCommitOutput(input: string, rawOutput: unknown): { output: string; call: number } | null {
	const calls = literalExecCalls(input);
	if (!calls || !Array.isArray(rawOutput) || rawOutput.length !== calls.length + 1) return null;
	const header = str(asObj(rawOutput[0])["text"])?.trimStart() ?? "";
	if (!/^Script completed\b/.test(header)) return null;
	for (const [i, call] of calls.entries()) {
		if (call.name !== "exec_command" || !isCommitCommand({ cmd: call.command })) continue;
		try {
			const chunk = asObj(JSON.parse(str(asObj(rawOutput[i + 1])["text"]) ?? ""));
			if (typeof chunk["chunk_id"] === "string" && chunk["exit_code"] === 0 && typeof chunk["output"] === "string" && GIT_COMMIT_RE.test(chunk["output"]))
				return { output: chunk["output"], call: i };
		} catch { /* Unparseable output is not commit evidence. */ }
	}
	return null;
}

/** Joined text of a Codex message payload (content[] of {type, text}). */
function messageText(payload: Json): string | undefined {
	const content = payload["content"];
	if (typeof content === "string") return content || undefined;
	const parts = (Array.isArray(content) ? content : [])
		.map(asObj)
		.map((b) => str(b["text"]))
		.filter((t): t is string => Boolean(t));
	return parts.length ? parts.join("\n") : undefined;
}

function toolStep(
	name: string,
	callId: string,
	args: unknown,
	ts: string,
	idx: number,
): Step {
	return {
		step_id: callId || `tool${idx}`,
		parent_step_id: null,
		subagent_id: null,
		kind: "tool_call",
		started_at: ts,
		status: "ok",
		attributes: {
			[ATTR.TOOL_NAME]: name,
			[ATTR.TOOL_CALL_ID]: callId,
			[ATTR.TOOL_ARGS]: args,
			[ATTR.TOOL_RESULT_KIND]: RESULT_KIND[name] ?? "other",
		},
	};
}

/** function_call arguments arrive as a JSON string; parse defensively. */
function parseArgs(raw: unknown): unknown {
	const s = str(raw);
	if (s === undefined) return raw ?? {};
	try {
		return JSON.parse(s);
	} catch {
		return { raw: s };
	}
}

function compactionStep(id: string, ts: string): Step {
	return {
		step_id: id,
		parent_step_id: null,
		subagent_id: null,
		kind: "compaction",
		started_at: ts,
		attributes: { [ATTR.COMPACT_REASON]: "context" },
	};
}

/** Normalize a list of raw Codex rollout envelopes into a Trace. */
export function parseCodexEvents(rawEvents: readonly unknown[]): Trace {
	const events = rawEvents.map(asObj);
	const steps: Step[] = [];
	const toolSteps = new Map<string, Step>();

	let runId = "unknown";
	let version: string | undefined;
	let originator: string | undefined;
	let cwd: string | undefined;
	let model: string | undefined;
	let planText: string | undefined;
	let outSummary: string | undefined;
	let outStatus: string | undefined;
	let started: string | undefined;
	let ended: string | undefined;

	let lastTs = EPOCH;
	let pendingReasoning = false;
	let lastLlm: Step | null = null;
	let currentModel: string | undefined;
	// Codex reports cumulative token usage in separate token_count events. We
	// attribute each turn's consumption as (cumulative now - cumulative when the
	// turn's llm step began), so multiple token_counts per turn stay idempotent
	// and a token_count before the first llm step can't inflate it.
	const prevUsage = { in: 0, out: 0, cache: 0 };
	const llmBaseline = { in: 0, out: 0, cache: 0 };
	let lastComposite: string | null = null;
	let prevModel: string | undefined;
	let modeSeq = 0;

	const mergeOutput = (
		callId: string,
		rawOutput: unknown,
		when: string,
		status?: unknown,
	): void => {
		const step = toolSteps.get(callId);
		if (!step) return;
		const output = outputText(rawOutput);
		step.ended_at = when;
		if (status === "incomplete" || status === "failed") step.status = "error";
		// A legacy string output carries its exit code in the header; current
		// exec cells (a list of parts) carry one JSON chunk per inner command.
		const m = legacyExit(rawOutput);
		const parsed = m ? { results: [], aggregateExits: [] } : execResults(rawOutput);
		const { results } = parsed;
		// JSON a cell prints is only a result aggregate when the cell itself fanned
		// out tool calls (`Promise.allSettled([tools.exec_command(…), …])`); any
		// other printed JSON with an `exit_code` key is just data.
		const input = String(asObj(step.attributes[ATTR.TOOL_ARGS])["input"] ?? "");
		const fansOut = /\bPromise\s*\.\s*(?:all|allSettled|race|any)\b/.test(input) && /\btools\./.test(input);
		const aggregateExits = fansOut ? parsed.aggregateExits : [];
		if (results.length) step.attributes[ATTR.EXEC_RESULTS] = results;
		// A plain-format command still running reports a session to poll instead
		// of an exit code; record it like a yielded exec-cell chunk.
		const running = typeof rawOutput === "string" && !m ? RUNNING_RE.exec(rawOutput) : null;
		if (running?.[1])
			step.attributes[ATTR.EXEC_RESULTS] = [
				{
					exit_code: null,
					session_id: running[1],
					test_failures: hasTestFailures(output),
					test_passes: hasTestPasses(output),
				},
			];
		if (!m && /^Script completed\b/.test(output.trimStart()))
			step.attributes[ATTR.EXEC_COMPLETED] = true;
		if (Array.isArray(rawOutput) && step.attributes[ATTR.TOOL_NAME] === "exec")
			step.attributes[ATTR.EXEC_PARTS] = execParts(rawOutput);
		if (step.attributes[ATTR.TOOL_NAME] === "apply_patch" && PATCH_OK_RE.test(output.trim()))
			step.attributes[ATTR.PATCH_CONFIRMED] = true;
		const failedInner = [
			...results.map((r) => r.exit_code),
			...aggregateExits,
		].some((code) => code !== null && code !== 0);
		// A cell whose script threw (`Script failed … Script error: …`) failed.
		const scriptFailed = !m && /^Script failed\b/.test(output.trimStart());
		if ((m && m[1] !== "0") || failedInner || scriptFailed) {
			step.status = "error";
			step.attributes[ATTR.TOOL_ERROR] = truncate(output.trim(), ERROR_MAX);
		}
		const successfulShellResult = m
			? m[1] === "0"
			: results.length > 0 && results.every((result) => result.exit_code === 0);
		const toolName = str(step.attributes[ATTR.TOOL_NAME]);
		const cellCommit = toolName === "exec" ? execCellCommitOutput(input, rawOutput) : null;
		const commitOutput =
			toolName === "exec"
				? cellCommit?.output
				: step.status === "ok" && successfulShellResult && step.attributes[ATTR.TOOL_RESULT_KIND] === "bash" && isCommitCommand(asObj(step.attributes[ATTR.TOOL_ARGS]))
					? output
					: null;
		if (commitOutput && !step.attributes[ATTR.GIT_COMMIT]) {
			const commitMatch = commitOutput.match(GIT_COMMIT_RE);
			if (commitMatch) {
				step.attributes[ATTR.GIT_COMMIT] = {
					branch: commitMatch[1],
					short: commitMatch[2],
				};
				if (cellCommit) step.attributes[ATTR.GIT_COMMIT_CALL] = cellCommit.call;
			}
		}
		if (hasTestFailures(output)) step.attributes[ATTR.TEST_FAILURES] = true;
		else if (hasTestPasses(output)) step.attributes[ATTR.TEST_PASSES] = true;
	};

	events.forEach((ev, idx) => {
		const ts = str(ev["timestamp"]) ?? lastTs;
		if (str(ev["timestamp"])) lastTs = ev["timestamp"] as string;
		started ??= ts;
		ended = ts;

		const etype = str(ev["type"]);
		const p = asObj(ev["payload"]);
		const ptype = str(p["type"]);

		if (etype === "session_meta") {
			if (runId === "unknown" && str(p["id"])) runId = p["id"] as string;
			version ??= str(p["cli_version"]);
			originator ??= str(p["originator"]);
			cwd ??= str(p["cwd"]);
			return;
		}

		if (etype === "turn_context") {
			const m = str(p["model"]);
			model ??= m;
			if (m) currentModel = m;
			const composite = JSON.stringify({
				model: m ?? null,
				approval: str(p["approval_policy"]) ?? null,
				sandbox: str(asObj(p["sandbox_policy"])["type"]) ?? null,
				collab: str(asObj(p["collaboration_mode"])["mode"]) ?? null,
			});
			if (lastComposite !== null && composite !== lastComposite) {
				modeSeq += 1;
				const attrs: Json = {
					[ATTR.MODE_KIND]: "turn_context",
					[ATTR.MODE_TO]: m ?? "unknown",
				};
				if (prevModel !== undefined) attrs[ATTR.MODE_FROM] = prevModel;
				const approval = str(p["approval_policy"]);
				if (approval) attrs["harness.approval_policy"] = approval;
				const sandbox = str(asObj(p["sandbox_policy"])["type"]);
				if (sandbox) attrs["harness.sandbox"] = sandbox;
				steps.push({
					step_id: `mode_${modeSeq}`,
					parent_step_id: null,
					subagent_id: null,
					kind: "mode_change",
					started_at: ts,
					attributes: attrs,
				});
			}
			lastComposite = composite;
			prevModel = m;
			return;
		}

		if (etype === "compacted") {
			steps.push(compactionStep(`compact${idx}`, ts));
			return;
		}

		if (etype === "response_item") {
			if (ptype === "message") {
				const role = str(p["role"]);
				const text = messageText(p);
				if (role === "assistant") {
					const attrs: Json = {};
					if (currentModel) attrs[ATTR.MODEL] = currentModel;
					if (pendingReasoning) attrs[ATTR.REASONING] = true;
					pendingReasoning = false;
					const step: Step = {
						step_id: `item${idx}`,
						parent_step_id: null,
						subagent_id: null,
						kind: "llm",
						started_at: ts,
						ended_at: ts,
						status: "ok",
						attributes: attrs,
					};
					steps.push(step);
					lastLlm = step;
					llmBaseline.in = prevUsage.in;
					llmBaseline.out = prevUsage.out;
					llmBaseline.cache = prevUsage.cache;
					if (text) outSummary = text;
				} else if (role === "user") {
					planText ??= text;
				}
			} else if (ptype === "reasoning") {
				pendingReasoning = true;
			} else if (ptype === "function_call") {
				const callId = str(p["call_id"]) ?? `call${idx}`;
				const step = toolStep(
					str(p["name"]) ?? "",
					callId,
					parseArgs(p["arguments"]),
					ts,
					idx,
				);
				steps.push(step);
				toolSteps.set(callId, step);
			} else if (ptype === "function_call_output") {
				mergeOutput(str(p["call_id"]) ?? "", p["output"], ts);
			} else if (ptype === "local_shell_call") {
				// Current Codex rollouts use a nested action and persist the output
				// with the item's `id` (the call_id is optional in older records).
				const itemId = str(p["id"]);
				const callId = str(p["call_id"]) ?? itemId ?? `call${idx}`;
				const step = toolStep(
					"local_shell_call",
					callId,
					asObj(p["action"]),
					ts,
					idx,
				);
				if (p["status"] === "incomplete") step.status = "error";
				steps.push(step);
				toolSteps.set(callId, step);
				if (itemId) toolSteps.set(itemId, step);
			} else if (ptype === "local_shell_call_output") {
				mergeOutput(
					str(p["call_id"]) ?? str(p["id"]) ?? "",
					p["output"],
					ts,
					p["status"],
				);
			} else if (ptype === "custom_tool_call") {
				const callId = str(p["call_id"]) ?? `call${idx}`;
				const step = toolStep(
					str(p["name"]) ?? "",
					callId,
					{ input: str(p["input"]) ?? "" },
					ts,
					idx,
				);
				if (str(p["status"]) && p["status"] !== "completed")
					step.status = "error";
				steps.push(step);
				toolSteps.set(callId, step);
			} else if (ptype === "custom_tool_call_output") {
				mergeOutput(str(p["call_id"]) ?? "", p["output"], ts);
			} else if (ptype === "web_search_call") {
				const action = asObj(p["action"]);
				const step = toolStep(
					"web_search",
					str(p["call_id"]) ?? `search${idx}`,
					{ query: str(action["query"]), queries: action["queries"] },
					ts,
					idx,
				);
				if (str(p["status"]) && p["status"] !== "completed")
					step.status = "error";
				step.ended_at = ts;
				steps.push(step);
			}
			return;
		}

		if (etype === "event_msg") {
			if (ptype === "token_count") {
				const usage = asObj(asObj(p["info"])["total_token_usage"]);
				if (Object.keys(usage).length === 0) return;
				const curIn = num(usage["input_tokens"]);
				const curOut = num(usage["output_tokens"]);
				const curCache = num(usage["cached_input_tokens"]);
				// Credit this turn from the baseline captured at its llm step.
				if (lastLlm) {
					const dIn = Math.max(0, curIn - llmBaseline.in);
					const dOut = Math.max(0, curOut - llmBaseline.out);
					const dCache = Math.max(0, curCache - llmBaseline.cache);
					if (dIn) lastLlm.attributes[ATTR.INPUT_TOKENS] = dIn;
					if (dOut) lastLlm.attributes[ATTR.OUTPUT_TOKENS] = dOut;
					if (dCache) lastLlm.attributes[ATTR.CACHE_READ_TOKENS] = dCache;
				}
				// Always advance the cumulative so the next turn's baseline is right.
				prevUsage.in = curIn;
				prevUsage.out = curOut;
				prevUsage.cache = curCache;
			} else if (ptype === "context_compacted") {
				steps.push(compactionStep(`compact${idx}`, ts));
			} else if (ptype === "task_complete") {
				outStatus = "completed";
				const last = str(p["last_agent_message"]);
				if (last) outSummary = last;
			}
		}
	});

	const run: Run = {
		run_id: runId,
		harness: {
			name: HARNESS_NAME,
			version: version ?? null,
			entrypoint: originator ?? null,
		},
		started_at: started ?? EPOCH,
		ended_at: ended ?? null,
		model: model ?? null,
	};
	if (cwd) run.workspace = { cwd, git_branch: null };
	if (planText)
		run.plan = {
			source: "user_prompt",
			statement: truncate(planText, PLAN_MAX),
		};
	if (outStatus !== undefined || outSummary !== undefined) {
		run.outcome = {
			status: outStatus ?? "unknown",
			summary: outSummary ? truncate(outSummary, SUMMARY_MAX) : null,
		};
	}

	steps.sort((a, b) =>
		a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0,
	);
	return { plumbline_version: PLUMBLINE_VERSION, run, steps };
}

/** Parse raw Codex rollout text into a Trace. */
export function parseCodexTranscript(text: string): Trace {
	const { records, malformed } = parseJsonlWithStats(text);
	return { ...parseCodexEvents(records), malformed_lines: malformed };
}
