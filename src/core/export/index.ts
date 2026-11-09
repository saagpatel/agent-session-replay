import type { Trace } from "../types.ts";
import { buildCausalGraph, evidencedOnly, happensBefore, type GraphDiagnostic } from "./causal.ts";
import { checkCaptions, type CaptionFailure } from "./caption-ref.ts";
import { parseManifest, resolveManifest, type ManifestError } from "./manifest.ts";
import { checkOrder, type OrderFailure } from "./order-check.ts";

/** Named failures across manifest, source graph, playback and caption checks. */
export type Failure = ManifestError | GraphDiagnostic | CaptionFailure | OrderFailure;

/** Check causal-order preservation plus caption-reference presence, not frame equality. */
export function validateExport(input: unknown, trace: Trace): { ok: boolean; failures: Failure[]; warnings: GraphDiagnostic[] } {
	const manifest = parseManifest(input);
	if ("errors" in manifest) return { ok: false, failures: manifest.errors, warnings: [] };
	const resolved = resolveManifest(manifest, trace);
	if ("errors" in resolved) return { ok: false, failures: resolved.errors, warnings: [] };
	const graph = buildCausalGraph(trace);
	const evidencedGraph = evidencedOnly(graph);
	const indices = new Map(trace.steps.map((step, index) => [step.step_id, index]));
	// A reversed source interval needs independence evidence for every cell it
	// crosses, including omitted cells. Preserving source order needs no such claim.
	const reversed: Array<[number, number]> = [];
	let latest = -1;
	for (const step of resolved.steps) {
		const index = indices.get(step.id)!;
		if (index < latest) reversed.push([index, latest]);
		latest = Math.max(latest, index);
	}
	const warnings: GraphDiagnostic[] = [];
	const diagnostics = graph.diagnostics.filter((diagnostic) => {
		if (diagnostic.reason === "external-parent" || diagnostic.reason === "unlinked-subagent-result" ||
			diagnostic.reason === "ambiguous-subagent-invocation" || diagnostic.reason === "uncertain-access") {
			warnings.push(diagnostic);
			return false;
		}
		if (diagnostic.reason !== "unresolved-operation") return true;
		const index = indices.get(diagnostic.step!)!;
		const dependedOn = reversed.some(([from, to]) => from <= index && index <= to) || manifest.captions.some((caption) => {
			if (caption.kind === "shows") return caption.refs.includes(diagnostic.step!);
			const causeIndex = indices.get(caption.cause)!;
			const effectIndex = indices.get(caption.effect)!;
			if (causeIndex < index && index < effectIndex) return true;
			const step = diagnostic.step!;
			return (step === caption.cause || happensBefore(evidencedGraph, caption.cause, step)) &&
				(step === caption.effect || happensBefore(evidencedGraph, step, caption.effect)) &&
				happensBefore(evidencedGraph, caption.cause, caption.effect);
		});
		if (!dependedOn) warnings.push(diagnostic);
		return dependedOn;
	});
	const failures: Failure[] = [
		...diagnostics,
		...checkOrder(resolved, graph),
		...checkCaptions(resolved, graph),
	];
	return { ok: failures.length === 0, failures, warnings };
}
