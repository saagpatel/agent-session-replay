/**
 * Trace schema, drop-in compatible with the plumbline agent-trace schema
 * (`{ plumbline_version, run, steps[] }`, an OTel-shaped decision DAG).
 *
 * We enrich through the open `attributes` bag rather than forking the schema, so
 * a plumbline-recorded trace loads here unchanged and our parser output stays
 * gradeable by plumbline's offline scorer.
 */

/** Standard execution layer (`llm`/`tool_call`/`agent`) plus the harness-control overlay. */
export type StepKind =
	| "llm"
	| "tool_call"
	| "agent"
	| "decision"
	| "hook"
	| "memory"
	| "compaction"
	| "mode_change";

export type StepStatus = "ok" | "error" | "interrupted";

export interface Attribution {
	skill?: string;
	mcp_server?: string;
	mcp_tool?: string;
	agent?: string;
}

/**
 * Open attribute bag keyed by OTel `gen_ai.*` and plumbline `harness.*`
 * conventions. The well-known keys our parser emits are enumerated in `ATTR`.
 */
export type Attributes = Record<string, unknown>;

export interface Step {
	step_id: string;
	parent_step_id?: string | null;
	/** The step that triggered this one (a hook's gated call; a result's origin). */
	caused_by?: string | null;
	/** null = root/main context; any value = a subagent sidechain. */
	subagent_id?: string | null;
	kind: StepKind;
	started_at: string;
	ended_at?: string | null;
	status?: StepStatus;
	attribution?: Attribution;
	attributes: Attributes;
}

export interface RunHarness {
	name: string;
	version?: string | null;
	entrypoint?: string | null;
}

export interface RunWorkspace {
	cwd?: string | null;
	git_branch?: string | null;
}

export interface RunPlan {
	source: string;
	statement: string;
}

export interface RunOutcome {
	status: string;
	summary?: string | null;
}

export interface Run {
	run_id: string;
	harness: RunHarness;
	started_at: string;
	ended_at?: string | null;
	model?: string | null;
	workspace?: RunWorkspace;
	plan?: RunPlan;
	outcome?: RunOutcome;
}

export interface Trace {
	plumbline_version: string;
	run: Run;
	steps: Step[];
}

/**
 * Well-known attribute keys. Centralized so the parser, detectors, and UI share
 * one source of truth and never drift on a stringly-typed key.
 */
export const ATTR = {
	// standard / output layer (OTel gen_ai.*)
	MODEL: "gen_ai.request.model",
	INPUT_TOKENS: "gen_ai.usage.input_tokens",
	OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
	CACHE_READ_TOKENS: "gen_ai.usage.cache_read_input_tokens",
	CACHE_CREATION_TOKENS: "gen_ai.usage.cache_creation_input_tokens",
	FINISH_REASONS: "gen_ai.response.finish_reasons",
	REASONING: "agent.reasoning",
	TOOL_NAME: "gen_ai.tool.name",
	TOOL_CALL_ID: "gen_ai.tool.call.id",
	TOOL_ARGS: "tool.arguments",
	TOOL_RESULT_KIND: "tool.result.kind",
	TOOL_ERROR: "tool.error.message",
	// subagent overlay
	AGENT_TYPE: "agent.type",
	AGENT_NAME: "agent.name",
	AGENT_MODEL: "agent.model",
	AGENT_SPAWNS: "agent.spawns_subagent_id",
	AGENT_TOTAL_TOKENS: "agent.total_tokens",
	AGENT_DURATION_MS: "agent.total_duration_ms",
	// harness-control overlay
	HOOK_EVENT: "harness.hook.event",
	HOOK_VERDICT: "harness.hook.verdict",
	HOOK_PREVENTED: "harness.hook.prevented_continuation",
	HOOK_COMMANDS: "harness.hook.commands",
	GUARD_NAME: "harness.guard.name",
	GUARD_REASON: "harness.guard.reason",
	GUARD_TRIPPED: "harness.guard.tripped",
	STALE_READ: "harness.stale_read",
	MODE_KIND: "harness.mode.kind",
	MODE_TO: "harness.mode.to",
	MODE_FROM: "harness.mode.from",
	COMPACT_REASON: "harness.compaction.reason",
	COMPACT_BEFORE: "harness.compaction.tokens_before",
	COMPACT_AFTER: "harness.compaction.tokens_after",
} as const;
