import { findPath, type CausalGraph } from "./causal.ts";
import type { ResolvedManifest } from "./manifest.ts";
import { fileOperations, stepLabel } from "./operations.ts";

/** A caption references missing evidence, a reversed cause or an unsupported claim. */
export interface CaptionFailure {
	reason: "caption-ref-absent" | "caption-reversed" | "caption-unsupported-claim" | "dropped-prerequisite";
	message: string;
	captionId: string;
	step?: string;
	cause?: string;
	effect?: string;
}

/** Validate caption presence and source causality, including every direct write prerequisite. */
export function checkCaptions(resolved: ResolvedManifest, graph: CausalGraph): CaptionFailure[] {
	const failures: CaptionFailure[] = [];
	const positions = new Map(resolved.steps.map((step, index) => [step.id, index]));
	const cwd = resolved.trace.run.workspace?.cwd;
	const label = (id: string) => stepLabel(graph.steps.get(id), cwd);
	const predecessors = new Map<string, Set<string>>();
	for (const edge of graph.edges) {
		const incoming = predecessors.get(edge.to) ?? new Set<string>();
		incoming.add(edge.from);
		predecessors.set(edge.to, incoming);
	}
	for (const caption of resolved.manifest.captions) {
		const refs = caption.kind === "shows" ? caption.refs : [caption.cause, caption.effect];
		for (const id of refs) {
			if (!positions.has(id)) {
				failures.push({
					reason: "caption-ref-absent",
					message: `Caption references absent ${label(id)}.`,
					captionId: caption.id,
					step: id,
				});
			}
		}
		if (caption.kind !== "because") continue;
		const { cause, effect } = caption;
		const causePosition = positions.get(cause);
		const effectPosition = positions.get(effect);
		if (causePosition !== undefined && effectPosition !== undefined && causePosition >= effectPosition) {
			failures.push({
				reason: "caption-reversed",
				message: `Caption puts ${label(cause)} after or at ${label(effect)}.`,
				captionId: caption.id,
				cause,
				effect,
			});
		}
		if (!findPath(graph, cause, effect)) {
			failures.push({
				reason: "caption-unsupported-claim",
				message: `No source causal path proves ${label(cause)} caused ${label(effect)}.`,
				captionId: caption.id,
				cause,
				effect,
			});
		}
		for (const id of predecessors.get(effect) ?? []) {
			const step = graph.steps.get(id)!;
			if (fileOperations(step, cwd).some((operation) => operation.kind === "write") && !positions.has(id)) {
				failures.push({
					reason: "dropped-prerequisite",
					message: `${label(effect)} is missing prerequisite ${label(id)}.`,
					captionId: caption.id,
					step: id,
					cause,
					effect,
				});
			}
		}
	}
	return failures;
}
