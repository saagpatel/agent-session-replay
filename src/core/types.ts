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
	/** Parse metadata (not part of the plumbline data model): count of non-blank
	 * transcript lines that failed to parse, so the UI can flag under-reporting. */
	malformed_lines?: number;
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
	/** The tool output reports failing tests, whatever the exit code said. */
	TEST_FAILURES: "tool.output.test_failures",
	/** The tool output's test summary reports success and no failures. */
	TEST_PASSES: "tool.output.test_passes",
	/** Minimal identity reported by a successful `git commit` shell result. */
	GIT_COMMIT: "tool.output.git_commit",
	/**
	 * Codex command results (`ExecResult[]`): one per inner command of an `exec`
	 * cell, in call order, or one for a plain-format command that yielded. A
	 * yielded command has a session_id and no exit_code yet.
	 */
	EXEC_RESULTS: "codex.exec.results",
	/** The exec cell's script ran to completion. */
	EXEC_COMPLETED: "codex.exec.completed",
	/**
	 * Every printed part of an exec cell's output after its header, in order
	 * (`ExecPart[]`), so a straight-line cell can match each part to its call.
	 */
	EXEC_PARTS: "codex.exec.parts",
	/** An `apply_patch` call's own output confirmed the patch applied. */
	PATCH_CONFIRMED: "codex.patch.confirmed",
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

/** One inner command result of a Codex `exec` cell (see `ATTR.EXEC_RESULTS`). */
export interface ExecResult {
	exit_code: number | null;
	session_id: string | null;
	test_failures: boolean;
	test_passes: boolean;
}

/**
 * One printed part of an exec cell's output: a command's result chunk, an
 * `apply_patch` result (`{}` when it applied), or any other printed text.
 */
export interface ExecPart {
	kind: "chunk" | "empty-object" | "other";
	result?: ExecResult;
	/** For `other`: the text reads like an error (`Script error: …`). */
	error?: boolean;
}

