/**
 * Synthetic transcript builders for Run Diff tests. Every path, id and command
 * here is invented; no real transcript content is used.
 *
 * The builders emit raw harness events (Claude Code JSONL lines and Codex
 * rollout envelopes) so tests exercise the real parsers end to end.
 */

export const WORKSPACE_CC = "/work/a/fixture-repo";
export const WORKSPACE_CODEX = "/work/b/fixture-repo";

type Json = Record<string, unknown>;

// ---- Claude Code ---------------------------------------------------------

export type CcTool =
	| { name: "Read" | "Edit" | "Write"; file: string; error?: string }
	| { name: "Bash"; command: string; error?: string; output?: string }
	| { name: "Grep"; pattern: string; error?: string }
	| { name: "TodoWrite"; error?: string };

/** One Claude Code session doing `tools` in order, then ending its turn. */
export function ccEvents(
	prompt: string,
	tools: CcTool[],
	opts: { cwd?: string; finished?: boolean } = {},
): Json[] {
	const cwd = opts.cwd ?? WORKSPACE_CC;
	let t = 0;
	const ts = () => `2026-10-01T10:00:${String(t++).padStart(2, "0")}.000Z`;
	const base = { sessionId: "cc-fixture", cwd, gitBranch: "main" };
	const out: Json[] = [
		{
			...base,
			type: "user",
			uuid: "u0",
			timestamp: ts(),
			message: { role: "user", content: prompt },
		},
	];
	tools.forEach((tool, i) => {
		const id = `toolu_${i}`;
		const input: Json =
			tool.name === "Bash"
				? { command: tool.command }
				: tool.name === "Grep"
					? { pattern: tool.pattern }
					: tool.name === "TodoWrite"
						? { todos: [] }
						: { file_path: `${cwd}/${tool.file}` };
		out.push({
			...base,
			type: "assistant",
			uuid: `a${i}`,
			timestamp: ts(),
			message: {
				role: "assistant",
				model: "claude-fixture",
				stop_reason: "tool_use",
				content: [{ type: "tool_use", id, name: tool.name, input }],
			},
		});
		out.push({
			...base,
			type: "user",
			uuid: `r${i}`,
			timestamp: ts(),
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: id,
						is_error: Boolean(tool.error),
						content: tool.error ?? ("output" in tool && tool.output ? tool.output : "ok"),
					},
				],
			},
		});
	});
	out.push({
		...base,
		type: "assistant",
		uuid: "final",
		timestamp: ts(),
		message: {
			role: "assistant",
			model: "claude-fixture",
			stop_reason: opts.finished === false ? "max_tokens" : "end_turn",
			content: [{ type: "text", text: "Done." }],
		},
	});
	return out;
}

// ---- Codex ---------------------------------------------------------------

export type CodexTool =
	| { kind: "shell"; command: string; exit?: number }
	| { kind: "exec-cell"; command: string; exit?: number }
	| { kind: "patch"; file: string; add?: boolean }
	| { kind: "plan" };

/** One Codex rollout doing `tools` in order. */
export function codexEvents(
	prompt: string,
	tools: CodexTool[],
	opts: { cwd?: string; finished?: boolean } = {},
): Json[] {
	const cwd = opts.cwd ?? WORKSPACE_CODEX;
	let t = 0;
	const ts = () => `2026-10-01T11:00:${String(t++).padStart(2, "0")}.000Z`;
	const env = (type: string, payload: Json): Json => ({
		timestamp: ts(),
		type,
		payload,
	});
	const out: Json[] = [
		env("session_meta", {
			id: "codex-fixture",
			cwd,
			originator: "codex_cli",
			cli_version: "0.0.0",
		}),
		env("turn_context", {
			cwd,
			model: "gpt-fixture",
			approval_policy: "never",
			sandbox_policy: { type: "workspace-write" },
		}),
		env("response_item", {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: prompt }],
		}),
	];
	tools.forEach((tool, i) => {
		const callId = `call_${i}`;
		const exitOut = (code: number) =>
			`Process exited with code ${code}\nOutput:\n${code ? "error: fixture failure" : "ok"}`;
		if (tool.kind === "shell") {
			out.push(
				env("response_item", {
					type: "function_call",
					name: "shell",
					call_id: callId,
					arguments: JSON.stringify({ command: ["bash", "-lc", tool.command] }),
				}),
				env("response_item", {
					type: "function_call_output",
					call_id: callId,
					output: exitOut(tool.exit ?? 0),
				}),
			);
		} else if (tool.kind === "exec-cell") {
			out.push(
				env("response_item", {
					type: "custom_tool_call",
					name: "exec",
					call_id: callId,
					status: "completed",
					input: `text(await tools.exec_command({cmd:${JSON.stringify(tool.command)}}))`,
				}),
				env("response_item", {
					type: "custom_tool_call_output",
					call_id: callId,
					output: exitOut(tool.exit ?? 0),
				}),
			);
		} else if (tool.kind === "patch") {
			const verb = tool.add ? "Add" : "Update";
			out.push(
				env("response_item", {
					type: "custom_tool_call",
					name: "apply_patch",
					call_id: callId,
					status: "completed",
					input: `*** Begin Patch\n*** ${verb} File: ${cwd}/${tool.file}\n+x\n*** End Patch`,
				}),
				env("response_item", {
					type: "custom_tool_call_output",
					call_id: callId,
					output: "Success",
				}),
			);
		} else {
			out.push(
				env("response_item", {
					type: "function_call",
					name: "update_plan",
					call_id: callId,
					arguments: JSON.stringify({ plan: [] }),
				}),
				env("response_item", {
					type: "function_call_output",
					call_id: callId,
					output: "Plan updated",
				}),
			);
		}
	});
	out.push(
		env("response_item", {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "Done." }],
		}),
	);
	if (opts.finished !== false)
		out.push(env("event_msg", { type: "task_complete", last_agent_message: "Done." }));
	return out;
}

/** Render events as JSONL text, the way they sit on disk. */
export function toJsonl(events: Json[]): string {
	return events.map((e) => JSON.stringify(e)).join("\n");
}
