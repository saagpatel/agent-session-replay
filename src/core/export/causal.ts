import { ATTR, type Step, type Trace } from "../types.ts";
import { operationEvidence, stepLabel } from "./operations.ts";

/** The source evidence supporting an edge's direction. */
export type EdgeKind = "caused-by" | "parent" | "spawn" | "consumer" | "file-read" | "test-write" | "unresolved-write";

/** An evidenced dependency between two source steps. */
export interface Edge {
	from: string;
	to: string;
	kind: EdgeKind;
	evidence: string;
}

/** Invalid source graphs and evidence gaps; unresolved operations are scoped by the validator. */
export interface GraphDiagnostic {
	reason: "dangling-parent" | "external-parent" | "causal-cycle" | "unlinked-subagent-result" | "ambiguous-subagent-invocation" | "unresolved-operation";
	message: string;
	step?: string;
	parent?: string;
	subagentId?: string;
	path?: string[];
}

/** Source nodes and a once-built adjacency index in deterministic edge order. */
export interface CausalGraph {
	edges: Edge[];
	diagnostics: GraphDiagnostic[];
	steps: Map<string, Step>;
	adjacency: Map<string, string[]>;
}

/** Exclude conservative barriers and unassigned child steps from causal proofs. */
export function evidencedOnly(graph: CausalGraph): CausalGraph {
	const ambiguous = new Set(graph.diagnostics.filter((diagnostic) => diagnostic.reason === "ambiguous-subagent-invocation")
		.map((diagnostic) => diagnostic.step));
	const edges = graph.edges.filter((edge) => edge.kind !== "unresolved-write" &&
		!ambiguous.has(edge.from) && !ambiguous.has(edge.to));
	const adjacency = new Map<string, string[]>();
	for (const edge of edges) {
		const neighbors = adjacency.get(edge.from) ?? [];
		if (!neighbors.includes(edge.to)) neighbors.push(edge.to);
		adjacency.set(edge.from, neighbors);
	}
	return { ...graph, edges, adjacency };
}

/**
 * Build evidenced dependencies and conservative unresolved-operation barriers,
 * never timestamp or source adjacency alone.
 * Parsers merge a tool call/result pair into one Step, so no separate result
 * edge is needed. Claude parents can reference non-Step user events; only hooks
 * set caused_by. Codex sets neither. Synthetic traces may explicitly supply both.
 * Data edges describe recorded accesses/invocations, not successful file contents.
 */
export function buildCausalGraph(trace: Trace): CausalGraph {
	const steps = new Map(trace.steps.map((step) => [step.step_id, step]));
	const edges: Edge[] = [];
	const diagnostics: GraphDiagnostic[] = [];
	const adjacency = new Map<string, string[]>();
	const edgeKeys = new Set<string>();
	const cwd = trace.run.workspace?.cwd;
	const label = (id: string) => stepLabel(steps.get(id), cwd);
	const resultEventSteps = new Map<string, Set<string>>();
	for (const step of trace.steps) {
		const uuids = step.attributes[ATTR.CLAUDE_RESULT_EVENT_UUIDS];
		if (!Array.isArray(uuids)) continue;
		for (const uuid of uuids) {
			if (typeof uuid !== "string" || !uuid) continue;
			const contributors = resultEventSteps.get(uuid) ?? new Set<string>();
			contributors.add(step.step_id);
			resultEventSteps.set(uuid, contributors);
		}
	}
	const add = (from: string, to: string, kind: EdgeKind, evidence: string) => {
		if (!steps.has(from) || !steps.has(to)) {
			const parentKind = steps.get(to)?.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND];
			const external = kind === "parent" && (parentKind === "user" || parentKind === "system" || parentKind === "summary");
			diagnostics.push({
				reason: external ? "external-parent" : "dangling-parent",
				message: external ? `${label(to)} references an event outside the source steps.`
					: `${label(to)} references a parent absent from the source trace.`,
				step: to,
				parent: from,
			});
			return;
		}
		const key = JSON.stringify([from, to, kind]);
		if (edgeKeys.has(key)) return;
		edgeKeys.add(key);
		edges.push({ from, to, kind, evidence });
		const neighbors = adjacency.get(from) ?? [];
		if (!neighbors.includes(to)) neighbors.push(to);
		adjacency.set(from, neighbors);
	};

	for (const step of trace.steps) {
		if (step.parent_step_id) {
			const contributors = !steps.has(step.parent_step_id) && resultEventSteps.get(step.parent_step_id);
			if (contributors) {
				for (const id of contributors) add(id, step.step_id, "parent", "result-event");
			}
			// Matched contributors do not account for missing calls in the same batch.
			if (!contributors || step.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND] === "unmatched-tool-result") {
				add(step.parent_step_id, step.step_id, "parent", "parent_step_id");
			}
		}
		if (step.caused_by) add(step.caused_by, step.step_id, "caused-by", "caused_by");
	}

	const sidechains = new Map<string, Step[]>();
	for (const step of trace.steps) {
		if (step.subagent_id == null) continue;
		const chain = sidechains.get(step.subagent_id) ?? [];
		chain.push(step);
		sidechains.set(step.subagent_id, chain);
	}
	const indices = new Map(trace.steps.map((step, index) => [step.step_id, index]));
	const invocations = new Map<string, Step[]>();
	for (const spawn of trace.steps) {
		const child = spawn.attributes[ATTR.AGENT_SPAWNS];
		if (typeof child !== "string") continue;
		const calls = invocations.get(child) ?? [];
		calls.push(spawn);
		invocations.set(child, calls);
	}
	const segments = new Map<string, Step[]>();
	const incompleteInvocations = new Set<string>();
	for (const [child, chain] of sidechains) {
		const calls = invocations.get(child) ?? [];
		const start = (step: Step) => step.attributes[ATTR.CLAUDE_TIMESTAMP_INFERRED] === true
			? NaN : Date.parse(step.started_at);
		const ordered = [...calls].sort((a, b) => start(a) - start(b));
		const knownStarts = ordered.every((call) => Number.isFinite(start(call)));
		for (const step of chain) {
			const time = start(step);
			// Equal invocation starts cannot be disambiguated by source order.
			let index = -1;
			if (knownStarts && Number.isFinite(time)) {
				for (let candidate = ordered.length - 1; candidate >= 0; candidate--) {
					if (start(ordered[candidate]!) <= time) {
						index = candidate;
						break;
					}
				}
			}
			const call = ordered[index];
			const next = ordered[index + 1];
			const resultTime = Date.parse(call?.ended_at ?? "");
			const hasResult = call && (call.ended_at != null ||
				Array.isArray(call.attributes[ATTR.CLAUDE_RESULT_EVENT_UUIDS]) ||
				["completed", "launched"].includes(String(call.attributes[ATTR.CLAUDE_AGENT_RESULT_KIND])));
			const end = Date.parse(step.ended_at ?? "");
			if (!call || (index > 0 && start(ordered[index - 1]!) === start(call)) ||
				(hasResult && (!Number.isFinite(resultTime) || time > resultTime)) ||
				(next && Number.isFinite(end) && end > start(next))) {
				// Dropping ambiguous work must not turn a partial segment into
				// evidence of completion. Only the affected invocations lose it.
				for (const candidate of ordered) {
					if (!knownStarts || !Number.isFinite(time) || (call && start(candidate) === start(call)) ||
						(next && candidate === next && Number.isFinite(end) && end > start(next))) {
						incompleteInvocations.add(candidate.step_id);
					}
				}
				diagnostics.push({
					reason: "ambiguous-subagent-invocation",
					message: `${label(step.step_id)} cannot be assigned to one subagent invocation from recorded timestamps.`,
					step: step.step_id,
					subagentId: child,
				});
				continue;
			}
			const segment = segments.get(call.step_id) ?? [];
			segment.push(step);
			segments.set(call.step_id, segment);
		}
	}
	for (const spawn of trace.steps) {
		const child = spawn.attributes[ATTR.AGENT_SPAWNS];
		if (typeof child !== "string") continue;
		const chain = sidechains.get(child);
		if (!chain?.length) {
			diagnostics.push({
				reason: "dangling-parent",
				message: `${label(spawn.step_id)} references a subagent absent from the source trace.`,
				step: spawn.step_id,
				subagentId: child,
			});
			continue;
		}
		const segment = segments.get(spawn.step_id) ?? [];
		for (const step of segment) add(spawn.step_id, step.step_id, "spawn", ATTR.AGENT_SPAWNS);
		const last = segment.at(-1);
		if (!last) {
			diagnostics.push({
				reason: "unlinked-subagent-result",
				message: `${label(spawn.step_id)} has no assigned child steps proving a completed result.`,
				step: spawn.step_id,
				subagentId: child,
			});
			continue;
		}
		const lastIndex = indices.get(last.step_id)!;
		const resultTime = Date.parse(spawn.ended_at ?? "");
		const completed = spawn.attributes[ATTR.CLAUDE_AGENT_RESULT_KIND] === "completed" &&
			!incompleteInvocations.has(spawn.step_id) && Number.isFinite(resultTime) && segment.every((step) => {
				const end = Date.parse(step.ended_at ?? "");
				return Number.isFinite(end) && end <= resultTime;
			});
		const referencesResult = (step: Step) => Boolean(step.parent_step_id &&
			!steps.has(step.parent_step_id) && resultEventSteps.get(step.parent_step_id)?.has(spawn.step_id));
		const candidates = completed ? trace.steps.filter((step, index) =>
			index > lastIndex &&
			(step.subagent_id ?? null) === (spawn.subagent_id ?? null) &&
			(step.caused_by === last.step_id || step.parent_step_id === last.step_id || referencesResult(step)),
		) : [];
		const consumers = candidates.filter((step, index) => index === 0 || referencesResult(step));
		if (consumers.length) {
			for (const consumer of consumers) {
				// A completed result covers every child step, including parallel
				// tools with no dependency on the final step in source order.
				const resultReference = referencesResult(consumer);
				for (const step of resultReference ? segment : [last]) add(step.step_id, consumer.step_id, "consumer", resultReference
					? "parent references Agent result-event"
					: "first later parent-context step explicitly referencing subagent endpoint");
			}
		} else {
			diagnostics.push({
				reason: "unlinked-subagent-result",
				message: `${label(last.step_id)} has no evidenced later consumer in its parent context.`,
				step: last.step_id,
				subagentId: child,
			});
		}
	}

	const operations = trace.steps.map((step) => ({ step, evidence: operationEvidence(step, cwd) }));
	type Writer = { id: string; start: number; end: number; confirmed: boolean };
	const interval = (step: Step) => {
		const start = step.attributes[ATTR.CLAUDE_TIMESTAMP_INFERRED] === true ? NaN : Date.parse(step.started_at);
		const end = Date.parse(step.ended_at ?? "");
		return Number.isFinite(start) && Number.isFinite(end) && end < start
			? { start: NaN, end: NaN } : { start, end };
	};
	const writes = new Map<string, Writer[]>();
	for (const { step, evidence } of operations) {
		const name = step.attributes[ATTR.TOOL_NAME];
		const writer: Writer = {
			id: step.step_id, ...interval(step),
			// Exec completion proves invocation, not its individual write results.
			confirmed: step.status === "ok" && !evidence.unresolved && name !== "exec" &&
				(name !== "apply_patch" || step.attributes[ATTR.PATCH_CONFIRMED] === true),
		};
		for (const path of new Set(evidence.operations.filter((operation) => operation.kind === "write")
			.map((operation) => operation.path).filter((path) => path !== undefined))) {
			const writers = writes.get(path) ?? [];
			writers.push(writer);
			writes.set(path, writers);
		}
	}
	// Unknown starts stay eligible; known future starts can be skipped per path.
	for (const writers of writes.values()) writers.sort((a, b) =>
		(Number.isFinite(a.start) ? a.start : -Infinity) - (Number.isFinite(b.start) ? b.start : -Infinity));
	const observe = (writers: Writer[], step: Step, kind: "file-read" | "test-write", evidence: string) => {
		const { start, end } = interval(step);
		const possible: Writer[] = [];
		let replacement: Writer | undefined;
		let previous: Writer | undefined;
		for (const writer of writers) {
			if (Number.isFinite(end) && Number.isFinite(writer.start) && writer.start > end) break;
			if (writer.id === step.step_id) continue;
			possible.push(writer);
			if (!writer.confirmed || !Number.isFinite(writer.start) || !Number.isFinite(writer.end) ||
				!Number.isFinite(start) || writer.end > start) continue;
			previous = replacement;
			replacement = writer;
		}
		for (const writer of possible) {
			// A replacement must finish before this observer starts, and start
			// after this writer finishes. Keep two candidates to avoid self-retirement
			// for zero-duration writes. Missing timestamps cannot prove either bound.
			const later = replacement?.id === writer.id ? previous : replacement;
			if (later && Number.isFinite(writer.end) && writer.end <= later.start) continue;
			add(writer.id, step.step_id, kind, evidence);
		}
	};
	const allWrites = new Set<string>();
	const barriers = new Set<string>();
	for (const { step, evidence } of operations) {
		if (evidence.unresolved) {
			diagnostics.push({
				reason: "unresolved-operation",
				message: `Operations in ${label(step.step_id)} are unresolved: ${evidence.reason}`,
				step: step.step_id,
			});
			for (const writer of allWrites) add(writer, step.step_id, "unresolved-write", "earlier write before a possible global mutation");
		}
		if (evidence.unresolved || evidence.operations.some((operation) => operation.kind !== "write")) {
			for (const barrier of barriers) add(barrier, step.step_id, "unresolved-write", "possible global mutation before a later read/test");
		}
		for (const operation of evidence.operations) {
			if (operation.kind === "write" && operation.path) {
				allWrites.add(step.step_id);
			}
			if (operation.kind === "read" && operation.path) {
				observe(writes.get(operation.path) ?? [], step, "file-read", `matching tool argument path ${operation.path}`);
			}
			if (operation.kind === "test") {
				for (const writers of writes.values()) observe(writers, step, "test-write", "possible current write before test invocation");
			}
		}
		if (evidence.unresolved) {
			barriers.add(step.step_id);
			allWrites.add(step.step_id);
		}
	}

	const graph = { edges, diagnostics, steps, adjacency };
	// Kahn's algorithm keeps acyclic validation linear; BFS produces a witness
	// only if the source graph contains a cycle.
	const indegree = new Map(trace.steps.map((step) => [step.step_id, 0]));
	for (const neighbors of adjacency.values()) {
		for (const id of neighbors) indegree.set(id, indegree.get(id)! + 1);
	}
	const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
	for (let index = 0; index < ready.length; index++) {
		for (const id of adjacency.get(ready[index]!) ?? []) {
			const degree = indegree.get(id)! - 1;
			indegree.set(id, degree);
			if (degree === 0) ready.push(id);
		}
	}
	if (ready.length !== steps.size) {
		for (const [id, degree] of indegree) {
			if (degree === 0) continue;
			const path = findPath(graph, id, id);
			if (!path) continue;
			diagnostics.push({ reason: "causal-cycle", message: `Causal cycle includes ${label(id)}.`, step: id, path });
			break;
		}
	}
	return graph;
}

/** Find a shortest nonempty path by BFS, breaking ties by stable adjacency order. */
export function findPath(graph: CausalGraph, from: string, to: string): string[] | undefined {
	if (!graph.steps.has(from) || !graph.steps.has(to)) return undefined;
	const queue = [from];
	const parents = new Map<string, string | undefined>([[from, undefined]]);
	for (let index = 0; index < queue.length; index++) {
		const current = queue[index]!;
		for (const next of graph.adjacency.get(current) ?? []) {
			if (next === to) {
				const path = [current];
				let parent = parents.get(current);
				while (parent !== undefined) {
					path.push(parent);
					parent = parents.get(parent);
				}
				return [...path.reverse(), to];
			}
			if (parents.has(next)) continue;
			parents.set(next, current);
			queue.push(next);
		}
	}
	return undefined;
}

/** Whether a nonempty causal path proves that a precedes b. */
export function happensBefore(graph: CausalGraph, a: string, b: string): boolean {
	return findPath(graph, a, b) !== undefined;
}
