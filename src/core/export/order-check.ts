import { findPath, type CausalGraph } from "./causal.ts";
import type { ResolvedManifest } from "./manifest.ts";
export interface OrderFailure { reason: "reversed-causal-order" | "duplicate-step"; message: string; a: string; b: string; sceneA: string; sceneB: string; path?: string[] }
export function checkOrder(resolved: ResolvedManifest, graph: CausalGraph): OrderFailure[] {
	const failures: OrderFailure[] = [];
	for (let i = 0; i < resolved.ranges.length; i++) for (let j = i + 1; j < resolved.ranges.length; j++) {
		const a = resolved.ranges[i]!, b = resolved.ranges[j]!;
		if (Math.max(a.from, b.from) <= Math.min(a.to, b.to)) {
			const id = resolved.trace.steps[Math.max(a.from, b.from)]!.step_id;
			failures.push({ reason: "duplicate-step", message: `Step ${id} occurs in overlapping scene ranges.`, a: id, b: id, sceneA: a.sceneId, sceneB: b.sceneId });
		}
	}
	for (let i = 0; i < resolved.steps.length; i++) for (let j = i + 1; j < resolved.steps.length; j++) {
		const first = resolved.steps[i]!, second = resolved.steps[j]!;
		if (first.id === second.id) failures.push({ reason: "duplicate-step", message: `Step ${first.id} plays more than once.`, a: first.id, b: second.id, sceneA: first.sceneId, sceneB: second.sceneId });
		else {
			const path = findPath(graph, second.id, first.id);
			if (path) failures.push({ reason: "reversed-causal-order", message: `Step ${second.id} must play before step ${first.id}.`, a: second.id, b: first.id, sceneA: second.sceneId, sceneB: first.sceneId, path });
		}
	}
	return failures;
}
