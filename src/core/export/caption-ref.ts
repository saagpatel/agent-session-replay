import { fileOperation, findPath, type CausalGraph } from "./causal.ts";
import type { ResolvedManifest } from "./manifest.ts";
export interface CaptionFailure { reason: "caption-ref-absent" | "caption-reversed" | "caption-unsupported-claim" | "dropped-prerequisite"; message: string; captionId: string; step?: string }
export function checkCaptions(resolved: ResolvedManifest, graph: CausalGraph): CaptionFailure[] {
	const failures: CaptionFailure[] = [];
	const positions = new Map(resolved.steps.map((s, i) => [s.id, i]));
	for (const caption of resolved.manifest.captions) {
		const refs = caption.kind === "shows" ? caption.refs : [caption.cause, caption.effect];
		for (const id of refs) if (!positions.has(id)) failures.push({ reason: "caption-ref-absent", message: `Caption ${caption.id} references absent step ${id}.`, captionId: caption.id, step: id });
		if (caption.kind !== "because") continue;
		const { cause, effect } = caption;
		if (positions.has(cause) && positions.has(effect) && positions.get(cause)! >= positions.get(effect)!) failures.push({ reason: "caption-reversed", message: `Caption ${caption.id} puts step ${cause} after step ${effect}.`, captionId: caption.id });
		if (!findPath(graph, cause, effect)) failures.push({ reason: "caption-unsupported-claim", message: `No causal path proves step ${cause} caused step ${effect}.`, captionId: caption.id });
		for (const id of new Set(graph.edges.filter(e => e.to === effect).map(e => e.from))) {
			const step = graph.steps.get(id);
			if (step && fileOperation(step)?.kind === "write" && !positions.has(id)) failures.push({ reason: "dropped-prerequisite", message: `Step ${effect} is missing prerequisite step ${id}.`, captionId: caption.id, step: id });
		}
	}
	return failures;
}
