import { ATTR, type Step, type Trace } from "../types.ts";

export type EdgeKind = "caused-by" | "parent" | "spawn" | "consumer" | "file-read" | "test-write";
export interface Edge { from: string; to: string; kind: EdgeKind; evidence: string }
export interface GraphDiagnostic { reason: "dangling-parent" | "causal-cycle"; message: string }
export interface CausalGraph { edges: Edge[]; diagnostics: GraphDiagnostic[]; steps: Map<string, Step> }

/** Parsers merge results into calls; Claude emits hook causes and possibly
 * dangling event parents, while Codex emits neither parents nor result steps. */
export function fileOperation(step: Step): { kind: "write" | "read" | "test"; path?: string } | undefined {
	if (step.kind !== "tool_call") return;
	const name = step.attributes[ATTR.TOOL_NAME], args = step.attributes[ATTR.TOOL_ARGS];
	if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) return;
	const a = args as Record<string, unknown>;
	const path = typeof a.file_path === "string" ? a.file_path : typeof a.path === "string" ? a.path : undefined;
	if (/^(write|write_file|edit|edit_file|multiedit)$/i.test(name) && path) return { kind: "write", path };
	if (/^(read|read_file)$/i.test(name) && path) return { kind: "read", path };
	if (/^(test|run_tests)$/i.test(name)) return { kind: "test" };
	if (/^(bash|shell|exec_command)$/i.test(name)) {
		const command = typeof a.command === "string" ? a.command : a.cmd;
		if (typeof command === "string" && /^(?:npm test|pnpm test|yarn test|pytest|cargo test)(?:\s+[\w./-]+)*\s*$/.test(command)) return { kind: "test" };
	}
}
export function buildCausalGraph(trace: Trace): CausalGraph {
	const steps = new Map(trace.steps.map(s => [s.step_id, s]));
	const edges: Edge[] = [], diagnostics: GraphDiagnostic[] = [];
	const add = (from: string, to: string, kind: EdgeKind, evidence: string) => {
		if (!steps.has(from) || !steps.has(to)) { diagnostics.push({ reason: "dangling-parent", message: `Step ${to} references missing step ${from}.` }); return; }
		if (!edges.some(e => e.from === from && e.to === to && e.kind === kind)) edges.push({ from, to, kind, evidence });
	};
	for (const s of trace.steps) {
		if (s.parent_step_id) add(s.parent_step_id, s.step_id, "parent", "parent_step_id");
		if (s.caused_by) add(s.caused_by, s.step_id, "caused-by", "caused_by");
	}
	for (const spawn of trace.steps) {
		const child = spawn.attributes[ATTR.AGENT_SPAWNS];
		if (typeof child !== "string") continue;
		const chain = trace.steps.filter(s => s.subagent_id === child);
		if (!chain.length) { diagnostics.push({ reason: "dangling-parent", message: `Step ${spawn.step_id} references missing subagent ${child}.` }); continue; }
		add(spawn.step_id, chain[0]!.step_id, "spawn", ATTR.AGENT_SPAWNS);
		const last = chain[chain.length - 1]!;
		for (const consumer of trace.steps) if (consumer.step_id !== last.step_id && (consumer.caused_by === last.step_id || consumer.parent_step_id === last.step_id)) add(last.step_id, consumer.step_id, "consumer", "explicit child endpoint reference");
	}
	const writes = new Map<string, Step>(), pending = new Map<string, Step>();
	for (const s of trace.steps) {
		const op = fileOperation(s);
		if (op?.kind === "write" && op.path) { writes.set(op.path, s); pending.set(s.step_id, s); }
		if (op?.kind === "read" && op.path) { const w = writes.get(op.path); if (w) add(w.step_id, s.step_id, "file-read", `matching tool argument ${op.path}`); }
		if (op?.kind === "test") { for (const w of pending.values()) add(w.step_id, s.step_id, "test-write", "write before next test"); pending.clear(); }
	}
	const graph = { edges, diagnostics, steps };
	for (const s of trace.steps) if (findPath(graph, s.step_id, s.step_id)) { diagnostics.push({ reason: "causal-cycle", message: `Causal cycle includes step ${s.step_id}.` }); break; }
	return graph;
}
export function findPath(graph: CausalGraph, from: string, to: string): string[] | undefined {
	const queue: string[][] = [[from]], seen = new Set([from]);
	for (let i = 0; i < queue.length; i++) for (const edge of graph.edges) if (edge.from === queue[i]![queue[i]!.length - 1]) {
		const path = [...queue[i]!, edge.to];
		if (edge.to === to) return path;
		if (!seen.has(edge.to)) { seen.add(edge.to); queue.push(path); }
	}
}
export function happensBefore(graph: CausalGraph, a: string, b: string): boolean { return !!findPath(graph, a, b); }
