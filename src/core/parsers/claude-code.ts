/**
 * Parse a Claude Code session transcript into a plumbline-compatible Trace.
 *
 * Input is the raw event stream of a `<session>.jsonl` transcript, optionally
 * merged with its subagent sidechains (`<session>/subagents/agent-*.jsonl`).
 * The parser captures the observable execution layer (llm turns, tool calls
 * merged with their results by `tool_use_id`, subagent dispatch, hook/guard
 * verdicts, mode transitions, compaction boundaries) and enriches it with the
 * forensic signals real transcripts carry: guard-trip names, stale-read hints,
 * cache-token usage, and subagent telemetry.
 *
 * Real transcripts vary in shape and occasionally contain partial events, so the
 * parser is defensive throughout: a single malformed event never aborts the run.
 *
 * Logic is adapted from plumbline's `recorders/claude_code.py`; the schema and
 * `tool.result.kind` taxonomy are kept compatible on purpose.
 */

import { parseJsonl } from "../jsonl.ts";
import {
	ATTR,
	type Run,
	type Step,
	type StepStatus,
	type Trace,
} from "../types.ts";

const PLUMBLINE_VERSION = "0.1.0";
const HARNESS_NAME = "claude-code";
const EPOCH = "1970-01-01T00:00:00Z";
const SUMMARY_MAX = 600;
const PLAN_MAX = 2000;
const ERROR_MAX = 500;
const REASON_MAX = 300;

/** Final-turn stop_reason -> outcome status; only end_turn is a claimed completion. */
const STOP_REASON_STATUS: Record<string, string> = { end_turn: "completed" };

/** Tool name -> coarse result kind (typed detail lives in tool.arguments). */
const RESULT_KIND: Record<string, string> = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	MultiEdit: "edit",
	Bash: "bash",
	Agent: "agent",
	Glob: "glob",
	Grep: "grep",
};

/** A guard/hook denial surfaces as a tool_result error of this shape. */
const GUARD_RE = /^Blocked \(([^)]+)\):\s*([\s\S]*)$/;

type Json = Record<string, unknown>;

function asObj(v: unknown): Json {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Json)
		: {};
}
function asArr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) : s;
}

function contentBlocks(ev: Json): Json[] {
	const content = asObj(ev["message"])["content"];
	return Array.isArray(content) ? content.map(asObj) : [];
}

/** Joined text of a turn whether message.content is a plain string or block list. */
function contentText(ev: Json): string | undefined {
	const content = asObj(ev["message"])["content"];
	if (typeof content === "string") return content || undefined;
	const parts = (Array.isArray(content) ? content : [])
		.map(asObj)
		.filter((b) => b["type"] === "text" && typeof b["text"] === "string")
		.map((b) => b["text"] as string);
	return parts.length ? parts.join("\n") : undefined;
}

/** Text of a tool_result block, whose `content` is a string or a block list. */
function resultText(content: unknown): string | undefined {
	if (typeof content === "string") return content || undefined;
	const parts = (Array.isArray(content) ? content : [])
		.map(asObj)
		.map((b) => str(b["text"]))
		.filter((t): t is string => Boolean(t));
	return parts.length ? parts.join("\n") : undefined;
}

function attribution(ev: Json): Step["attribution"] | undefined {
	const pairs: Array<[keyof NonNullable<Step["attribution"]>, string]> = [
		["skill", "attributionSkill"],
		["mcp_server", "attributionMcpServer"],
		["mcp_tool", "attributionMcpTool"],
		["agent", "attributionAgent"],
	];
	const out: Record<string, string> = {};
	for (const [key, src] of pairs) {
		const value = str(ev[src]);
		if (value !== undefined) out[key] = value;
	}
	return Object.keys(out).length ? out : undefined;
}

function baseStep(
	stepId: string,
	kind: Step["kind"],
	ev: Json,
	subId: string | null,
	ts: string,
): Step {
	const step: Step = {
		step_id: stepId,
		parent_step_id: str(ev["parentUuid"]) ?? null,
		subagent_id: subId,
		kind,
		started_at: ts,
		attributes: {},
	};
	const attr = attribution(ev);
	if (attr) step.attribution = attr;
	return step;
}

function llmStep(
	ev: Json,
	subId: string | null,
	ts: string,
	idx: number,
): Step {
	const msg = asObj(ev["message"]);
	const usage = asObj(msg["usage"]);
	const attrs: Json = {};
	if (str(msg["model"])) attrs[ATTR.MODEL] = msg["model"];
	for (const [key, src] of [
		[ATTR.INPUT_TOKENS, "input_tokens"],
		[ATTR.OUTPUT_TOKENS, "output_tokens"],
		[ATTR.CACHE_READ_TOKENS, "cache_read_input_tokens"],
		[ATTR.CACHE_CREATION_TOKENS, "cache_creation_input_tokens"],
	] as const) {
		if (typeof usage[src] === "number") attrs[key] = usage[src];
	}
	if (str(msg["stop_reason"]))
		attrs[ATTR.FINISH_REASONS] = [msg["stop_reason"]];
	if (contentBlocks(ev).some((b) => b["type"] === "thinking"))
		attrs[ATTR.REASONING] = true;
	const step = baseStep(str(ev["uuid"]) ?? `ev${idx}`, "llm", ev, subId, ts);
	step.ended_at = str(ev["timestamp"]) ?? null;
	step.status = "ok";
	step.attributes = attrs;
	return step;
}

function toolStep(
	ev: Json,
	block: Json,
	subId: string | null,
	ts: string,
	blockId: string,
): Step {
	const name = str(block["name"]) ?? "";
	const input = asObj(block["input"]);
	let kind: Step["kind"];
	let attrs: Json;
	if (name === "Agent") {
		kind = "agent";
		attrs = { [ATTR.AGENT_TYPE]: str(input["subagent_type"]) ?? "unknown" };
		if (str(input["name"])) attrs[ATTR.AGENT_NAME] = input["name"];
		if (str(input["model"])) attrs[ATTR.AGENT_MODEL] = input["model"];
	} else {
		kind = "tool_call";
		attrs = {
			[ATTR.TOOL_NAME]: name,
			[ATTR.TOOL_CALL_ID]: blockId,
			[ATTR.TOOL_ARGS]: input,
			[ATTR.TOOL_RESULT_KIND]: RESULT_KIND[name] ?? "other",
		};
	}
	const step = baseStep(blockId, kind, ev, subId, ts);
	step.status = "ok";
	step.attributes = attrs;
	return step;
}

function mergeResult(
	toolSteps: Map<string, Step>,
	block: Json,
	ev: Json,
): void {
	const step = toolSteps.get(str(block["tool_use_id"]) ?? "");
	if (!step) return;
	const result = asObj(ev["toolUseResult"]);
	let status: StepStatus = "ok";
	if (result["interrupted"]) status = "interrupted";
	else if (block["is_error"]) status = "error";
	step.status = status;
	step.ended_at = str(ev["timestamp"]) ?? step.ended_at ?? null;

	if (block["is_error"]) {
		const msg = resultText(block["content"]);
		if (msg) {
			step.attributes[ATTR.TOOL_ERROR] = truncate(msg, ERROR_MAX);
			const m = GUARD_RE.exec(msg.trim());
			if (m) {
				step.attributes[ATTR.GUARD_TRIPPED] = true;
				step.attributes[ATTR.GUARD_NAME] = m[1];
				step.attributes[ATTR.GUARD_REASON] = truncate(
					(m[2] ?? "").trim(),
					REASON_MAX,
				);
			}
		}
	}
	if (result["staleReadFileStateHint"]) step.attributes[ATTR.STALE_READ] = true;

	if (step.kind === "agent") {
		if (str(result["agentId"]))
			step.attributes[ATTR.AGENT_SPAWNS] = result["agentId"];
		if (str(result["resolvedModel"]))
			step.attributes[ATTR.AGENT_MODEL] = result["resolvedModel"];
		if (typeof result["totalTokens"] === "number")
			step.attributes[ATTR.AGENT_TOTAL_TOKENS] = result["totalTokens"];
		if (typeof result["totalDurationMs"] === "number")
			step.attributes[ATTR.AGENT_DURATION_MS] = result["totalDurationMs"];
	}
}

function systemStep(
	ev: Json,
	subId: string | null,
	ts: string,
	idx: number,
): Step | null {
	const subtype = str(ev["subtype"]) ?? "";
	if (
		subtype.includes("compact") ||
		ev["isCompactSummary"] ||
		ev["compactMetadata"]
	) {
		const meta = asObj(ev["compactMetadata"]);
		const attrs: Json = {
			[ATTR.COMPACT_REASON]: str(meta["trigger"]) ?? "unknown",
		};
		if (typeof meta["preTokens"] === "number")
			attrs[ATTR.COMPACT_BEFORE] = meta["preTokens"];
		if (typeof meta["postTokens"] === "number")
			attrs[ATTR.COMPACT_AFTER] = meta["postTokens"];
		const step = baseStep(
			str(ev["uuid"]) ?? `sys${idx}`,
			"compaction",
			ev,
			subId,
			ts,
		);
		step.attributes = attrs;
		return step;
	}

	const hookInfos = asArr(ev["hookInfos"]);
	const hookErrors = asArr(ev["hookErrors"]);
	const hasHook =
		hookInfos.length > 0 ||
		ev["preventedContinuation"] != null ||
		hookErrors.length > 0 ||
		subtype.includes("hook");
	if (hasHook) {
		const prevented = Boolean(ev["preventedContinuation"]);
		const verdict = prevented || hookErrors.length > 0 ? "deny" : "allow";
		const attrs: Json = {
			[ATTR.HOOK_EVENT]: subtype || "unknown",
			[ATTR.HOOK_VERDICT]: verdict,
			[ATTR.HOOK_PREVENTED]: prevented,
		};
		const commands = hookInfos
			.map((h) => str(asObj(h)["command"]))
			.filter((c): c is string => Boolean(c));
		if (commands.length) attrs[ATTR.HOOK_COMMANDS] = commands;
		const step = baseStep(
			str(ev["uuid"]) ?? `sys${idx}`,
			"hook",
			ev,
			subId,
			ts,
		);
		step.caused_by = str(ev["toolUseID"]) ?? null;
		step.attributes = attrs;
		return step;
	}
	return null;
}

function modeStep(
	ev: Json,
	etype: string,
	lastMode: string | null,
	seq: number,
	ts: string,
): { step: Step; to: string } {
	const to =
		etype === "permission-mode"
			? (str(ev["permissionMode"]) ?? "unknown")
			: (str(ev["mode"]) ?? "unknown");
	const kind = etype === "permission-mode" ? "permission_mode" : "mode";
	const attrs: Json = { [ATTR.MODE_KIND]: kind, [ATTR.MODE_TO]: to };
	if (lastMode !== null) attrs[ATTR.MODE_FROM] = lastMode;
	const step: Step = {
		step_id: `mode_${seq}`,
		parent_step_id: null,
		subagent_id: null,
		kind: "mode_change",
		started_at: ts,
		attributes: attrs,
	};
	return { step, to };
}

function buildRun(events: Json[]): Run {
	let runId = "unknown";
	let version: string | undefined;
	let entrypoint: string | undefined;
	let cwd: string | undefined;
	let gitBranch: string | undefined;
	let model: string | undefined;
	let planText: string | undefined;
	let outSummary: string | undefined;
	let outStop: string | undefined;
	let started: string | undefined;
	let ended: string | undefined;

	for (const ev of events) {
		if (runId === "unknown" && str(ev["sessionId"]))
			runId = ev["sessionId"] as string;
		version ??= str(ev["version"]);
		entrypoint ??= str(ev["entrypoint"]);
		cwd ??= str(ev["cwd"]);
		gitBranch ??= str(ev["gitBranch"]);
		const ts = str(ev["timestamp"]);
		if (ts) {
			started ??= ts;
			ended = ts;
		}
		if (ev["type"] === "assistant" && !ev["isSidechain"]) {
			const msg = asObj(ev["message"]);
			model ??= str(msg["model"]);
			outSummary = contentText(ev) ?? outSummary;
			outStop = str(msg["stop_reason"]) ?? outStop;
		}
		if (planText === undefined && ev["type"] === "user" && !ev["isSidechain"]) {
			planText = contentText(ev);
		}
	}

	const run: Run = {
		run_id: runId,
		harness: {
			name: HARNESS_NAME,
			version: version ?? null,
			entrypoint: entrypoint ?? null,
		},
		started_at: started ?? EPOCH,
		ended_at: ended ?? null,
		model: model ?? null,
	};
	if (cwd || gitBranch)
		run.workspace = { cwd: cwd ?? null, git_branch: gitBranch ?? null };
	if (planText)
		run.plan = {
			source: "user_prompt",
			statement: truncate(planText, PLAN_MAX),
		};
	if (outStop !== undefined || outSummary !== undefined) {
		run.outcome = {
			status: STOP_REASON_STATUS[outStop ?? ""] ?? "unknown",
			summary: outSummary ? truncate(outSummary, SUMMARY_MAX) : null,
		};
	}
	return run;
}

/** Normalize a list of raw Claude Code events (main + merged subagents) into a Trace. */
export function parseClaudeCodeEvents(rawEvents: readonly unknown[]): Trace {
	const events = rawEvents.map(asObj);
	const run = buildRun(events);
	const steps: Step[] = [];
	const toolSteps = new Map<string, Step>();
	let lastTs = run.started_at;
	let lastMode: string | null = null;
	let modeSeq = 0;

	events.forEach((ev, idx) => {
		const ts = str(ev["timestamp"]) ?? lastTs;
		if (str(ev["timestamp"])) lastTs = ev["timestamp"] as string;
		const subId = ev["isSidechain"] ? (str(ev["agentId"]) ?? null) : null;
		const etype = str(ev["type"]);

		if (etype === "assistant") {
			steps.push(llmStep(ev, subId, ts, idx));
			contentBlocks(ev).forEach((block, j) => {
				if (block["type"] === "tool_use") {
					const blockId = str(block["id"]) ?? `ev${idx}_tu${j}`;
					const step = toolStep(ev, block, subId, ts, blockId);
					steps.push(step);
					if (str(block["id"])) toolSteps.set(block["id"] as string, step);
				}
			});
		} else if (etype === "user") {
			contentBlocks(ev).forEach((block) => {
				if (block["type"] === "tool_result") mergeResult(toolSteps, block, ev);
			});
		} else if (etype === "system") {
			const step = systemStep(ev, subId, ts, idx);
			if (step) steps.push(step);
		} else if (etype === "permission-mode" || etype === "mode") {
			modeSeq += 1;
			const { step, to } = modeStep(ev, etype, lastMode, modeSeq, ts);
			lastMode = to;
			steps.push(step);
		}
	});

	// Stable sort: equal timestamps keep insertion (~event) order.
	steps.sort((a, b) =>
		a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0,
	);
	return { plumbline_version: PLUMBLINE_VERSION, run, steps };
}

/** Parse raw transcript text (main + optional subagent sidechain texts) into a Trace. */
export function parseClaudeCodeTranscript(
	mainText: string,
	subagentTexts: readonly string[] = [],
): Trace {
	const events = parseJsonl(mainText);
	for (const sub of subagentTexts) events.push(...parseJsonl(sub));
	return parseClaudeCodeEvents(events);
}
