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

import { parseJsonl } from "../jsonl.ts";
import { ATTR, type Run, type Step, type Trace } from "../types.ts";

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
	bash: "bash",
	apply_patch: "edit",
	write_file: "write",
	read_file: "read",
	web_search: "search",
};

/** A shell tool output carries this header; a non-zero code is a failed call. */
const EXIT_RE = /Process exited with code (\d+)/;

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

	const mergeOutput = (callId: string, output: string, when: string): void => {
		const step = toolSteps.get(callId);
		if (!step) return;
		step.ended_at = when;
		const m = EXIT_RE.exec(output);
		if (m && m[1] !== "0") {
			step.status = "error";
			step.attributes[ATTR.TOOL_ERROR] = truncate(output.trim(), ERROR_MAX);
		}
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
				mergeOutput(str(p["call_id"]) ?? "", str(p["output"]) ?? "", ts);
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
				mergeOutput(str(p["call_id"]) ?? "", str(p["output"]) ?? "", ts);
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
	return parseCodexEvents(parseJsonl(text));
}
