import type { Trace } from "../types.ts";
import { buildCausalGraph, type GraphDiagnostic } from "./causal.ts";
import { checkCaptions, type CaptionFailure } from "./caption-ref.ts";
import { parseManifest, resolveManifest, type ManifestError } from "./manifest.ts";
import { checkOrder, type OrderFailure } from "./order-check.ts";
export type Failure = ManifestError | GraphDiagnostic | CaptionFailure | OrderFailure;
export function validateExport(input: unknown, trace: Trace): { ok: boolean; failures: Failure[] } {
	const manifest = parseManifest(input);
	if ("errors" in manifest) return { ok: false, failures: manifest.errors };
	const resolved = resolveManifest(manifest, trace);
	if ("errors" in resolved) return { ok: false, failures: resolved.errors };
	const graph = buildCausalGraph(trace);
	const failures: Failure[] = [...graph.diagnostics, ...checkOrder(resolved, graph), ...checkCaptions(resolved, graph)];
	return { ok: failures.length === 0, failures };
}
