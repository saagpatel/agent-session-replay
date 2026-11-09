import { findPath, type CausalGraph } from "./causal.ts";
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
	for (let i = 0; i < resolved.steps.length; i++) {
		for (let j = i + 1; j < resolved.steps.length; j++) {
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
			const path = findPath(graph, second.id, first.id);
			if (path) {
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
	return failures;
}
