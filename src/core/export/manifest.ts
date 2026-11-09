import type { Trace } from "../types.ts";

export interface Scene { id: string; range: { from: string; to: string }; steps: string[]; durationMs?: number }
export type Caption = { id: string; sceneId: string; kind: "shows"; text: string; refs: string[] } | { id: string; sceneId: string; kind: "because"; text: string; cause: string; effect: string };
export interface Manifest { version: 1; source: { runId: string; stepCount: number; digest: string }; title: string; scenes: Scene[]; captions: Caption[] }
export interface ResolvedManifest { manifest: Manifest; trace: Trace; steps: { id: string; sceneId: string }[]; ranges: { sceneId: string; from: number; to: number }[] }
export interface ManifestError { reason: "invalid-manifest" | "source-mismatch" | "unknown-step" | "invalid-range"; message: string }
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const keys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every(k => allowed.includes(k));
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);

/** Stable browser-safe hash of ordered IDs and kinds; not a security hash. */
export function traceDigest(trace: Trace): string {
	let hash = 0xcbf29ce484222325n;
	for (const b of new TextEncoder().encode(JSON.stringify(trace.steps.map(s => [s.step_id, s.kind])))) hash = BigInt.asUintN(64, (hash ^ BigInt(b)) * 0x100000001b3n);
	return hash.toString(16).padStart(16, "0");
}
export function parseManifest(json: unknown): Manifest | { errors: ManifestError[] } {
	let v: unknown = json;
	try { if (typeof json === "string") v = JSON.parse(json); } catch { return { errors: [{ reason: "invalid-manifest", message: "Manifest is not valid JSON." }] }; }
	const bad = (): { errors: ManifestError[] } => ({ errors: [{ reason: "invalid-manifest", message: "Manifest has an invalid structure or duplicate identifier." }] });
	if (!obj(v) || !keys(v, ["version", "source", "title", "scenes", "captions"]) || v.version !== 1 || !obj(v.source) || !keys(v.source, ["runId", "stepCount", "digest"]) || !str(v.source.runId) || !Number.isSafeInteger(v.source.stepCount) || (v.source.stepCount as number) < 0 || !str(v.source.digest) || !str(v.title) || !Array.isArray(v.scenes) || !Array.isArray(v.captions)) return bad();
	const sceneIds = new Set<string>();
	for (const s of v.scenes) {
		if (!obj(s) || !keys(s, ["id", "range", "steps", "durationMs"]) || !str(s.id) || sceneIds.has(s.id) || !obj(s.range) || !keys(s.range, ["from", "to"]) || !str(s.range.from) || !str(s.range.to) || !strings(s.steps) || (s.durationMs !== undefined && (typeof s.durationMs !== "number" || !Number.isFinite(s.durationMs) || s.durationMs <= 0))) return bad();
		sceneIds.add(s.id);
	}
	const captionIds = new Set<string>();
	for (const c of v.captions) {
		if (!obj(c) || !str(c.id) || captionIds.has(c.id) || !str(c.sceneId) || !sceneIds.has(c.sceneId) || !str(c.text)) return bad();
		if (c.kind === "shows") { if (!keys(c, ["id", "sceneId", "kind", "text", "refs"]) || !strings(c.refs)) return bad(); }
		else if (c.kind === "because") { if (!keys(c, ["id", "sceneId", "kind", "text", "cause", "effect"]) || !str(c.cause) || !str(c.effect)) return bad(); }
		else return bad();
		captionIds.add(c.id);
	}
	return v as unknown as Manifest;
}
export function resolveManifest(manifest: Manifest, trace: Trace): ResolvedManifest | { errors: ManifestError[] } {
	const errors: ManifestError[] = [];
	if (manifest.source.runId !== trace.run.run_id || manifest.source.stepCount !== trace.steps.length || manifest.source.digest !== traceDigest(trace)) errors.push({ reason: "source-mismatch", message: "Manifest source does not match the trace." });
	const indices = new Map<string, number>();
	trace.steps.forEach((s, i) => { if (indices.has(s.step_id)) errors.push({ reason: "invalid-manifest", message: `Source step ${s.step_id} is duplicated.` }); indices.set(s.step_id, i); });
	const steps: ResolvedManifest["steps"] = [], ranges: ResolvedManifest["ranges"] = [];
	for (const scene of manifest.scenes) {
		const from = indices.get(scene.range.from), to = indices.get(scene.range.to);
		if (from === undefined || to === undefined) { errors.push({ reason: "unknown-step", message: `Scene ${scene.id} has an unknown range endpoint.` }); continue; }
		if (from > to) { errors.push({ reason: "invalid-range", message: `Scene ${scene.id} has a reversed range.` }); continue; }
		ranges.push({ sceneId: scene.id, from, to });
		for (const id of scene.steps) {
			const index = indices.get(id);
			if (index === undefined) errors.push({ reason: "unknown-step", message: `Scene ${scene.id} references unknown step ${id}.` });
			else if (index < from || index > to) errors.push({ reason: "invalid-range", message: `Step ${id} is outside scene ${scene.id}.` });
			else steps.push({ id, sceneId: scene.id });
		}
	}
	return errors.length ? { errors } : { manifest, trace, steps, ranges };
}
