import type { CausalGraph } from "./causal.ts";
import type { ResolvedManifest } from "./manifest.ts";
import { stepLabel } from "./operations.ts";

/** A repeated step or a dependency reversed by playback. */
export type OrderFailure =
	| { reason: "reversed-causal-order"; message: string; a: string; b: string; sceneA: string; sceneB: string; path: string[] }
	| { reason: "duplicate-step"; message: string; a: string; b: string; sceneA: string; sceneB: string };

/** Check played-step uniqueness and all exported pairs' causal playback order. */
export function checkOrder(resolved: ResolvedManifest, graph: CausalGraph): OrderFailure[] {
	const failures: OrderFailure[] = [];
	const label = (id: string) => stepLabel(graph.steps.get(id), resolved.trace.run.workspace?.cwd);
	// One BFS per distinct exported source, discarding its index after checking
	// earlier playback positions. Valid chains take quadratic, not cubic, work.
	const positions = new Map<string, number[]>();
	resolved.steps.forEach((step, index) => {
		const indices = positions.get(step.id) ?? [];
		indices.push(index);
		positions.set(step.id, indices);
	});
	for (const [id, indices] of positions) {
		const parents = new Map<string, string | undefined>([[id, undefined]]);
		const queue = [id];
		for (let k = 0; k < queue.length; k++) {
			for (const next of graph.adjacency.get(queue[k]!) ?? []) {
				if (parents.has(next)) continue;
				parents.set(next, queue[k]!);
				queue.push(next);
			}
		}
		for (const j of indices) {
			for (let i = 0; i < j; i++) {
				const first = resolved.steps[i]!;
				const second = resolved.steps[j]!;
				if (first.id === second.id) {
					failures.push({
						reason: "duplicate-step",
						message: `${label(first.id)} plays more than once.`,
						a: first.id,
						b: second.id,
						sceneA: first.sceneId,
						sceneB: second.sceneId,
					});
					continue;
				}
				if (parents.has(first.id)) {
					// Only a violation needs a witness; BFS parents retain shortest paths.
					const path = [first.id];
					let parent = parents.get(first.id);
					while (parent !== undefined) {
						path.push(parent);
						parent = parents.get(parent);
					}
					path.reverse();
					failures.push({
						reason: "reversed-causal-order",
						message: `${label(second.id)} must play before ${label(first.id)}.`,
						a: second.id,
						b: first.id,
						sceneA: second.sceneId,
						sceneB: first.sceneId,
						path,
					});
				}
			}
		}
	}
	return failures;
}
