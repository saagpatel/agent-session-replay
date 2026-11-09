import type { Trace } from "../types.ts";
import { stepLabel } from "./operations.ts";

/** An inclusive source range and the exact steps played within it. */
export interface Scene {
	id: string;
	range: { from: string; to: string };
	steps: string[];
	durationMs?: number;
}

/** A presence claim or a directed causal claim attached to a scene. */
export type Caption =
	| { id: string; sceneId: string; kind: "shows"; text: string; refs: string[] }
	| { id: string; sceneId: string; kind: "because"; text: string; cause: string; effect: string };

/** Versioned, local-only description of a shortened replay. */
export interface Manifest {
	version: 1;
	source: { runId: string; stepCount: number; digest: string };
	title: string;
	scenes: Scene[];
	captions: Caption[];
}

/** Source indices and exported steps in manifest playback order. */
export interface ResolvedManifest {
	manifest: Manifest;
	trace: Trace;
	steps: { id: string; sceneId: string }[];
	ranges: { sceneId: string; from: number; to: number }[];
}

/** Structural or source-resolution failure with identifiers kept separately. */
export interface ManifestError {
	reason: "invalid-manifest" | "source-mismatch" | "unknown-step" | "invalid-range";
	message: string;
	step?: string;
	sceneId?: string;
	captionId?: string;
	from?: string;
	to?: string;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && [...value].every(string);
}

function validScene(value: unknown): value is Scene {
	if (!object(value) || !keys(value, ["id", "range", "steps", "durationMs"])) return false;
	if (!string(value.id) || !object(value.range) || !keys(value.range, ["from", "to"])) return false;
	if (!string(value.range.from) || !string(value.range.to) || !strings(value.steps)) return false;
	if ("durationMs" in value) {
		return typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs > 0;
	}
	return true;
}

function validCaption(value: unknown, sceneIds: Set<string>): value is Caption {
	if (!object(value) || !string(value.id) || !string(value.sceneId) || !sceneIds.has(value.sceneId)) return false;
	if (!string(value.text)) return false;
	if (value.kind === "shows") {
		return keys(value, ["id", "sceneId", "kind", "text", "refs"]) && strings(value.refs);
	}
	if (value.kind === "because") {
		return keys(value, ["id", "sceneId", "kind", "text", "cause", "effect"]) &&
			string(value.cause) && string(value.effect);
	}
	return false;
}

/** Stable browser-safe hash of ordered IDs and kinds; not a security hash. */
export function traceDigest(trace: Trace): string {
	let hash = 0xcbf29ce484222325n;
	const encoded = new TextEncoder().encode(JSON.stringify(trace.steps.map((step) => [step.step_id, step.kind])));
	for (const byte of encoded) {
		hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, "0");
}

/** Parse JSON text or an object, rejecting unknown keys and malformed fields. */
export function parseManifest(json: unknown): Manifest | { errors: ManifestError[] } {
	let value: unknown = json;
	try {
		if (typeof json === "string") value = JSON.parse(json);
	} catch {
		return { errors: [{ reason: "invalid-manifest", message: "Manifest is not valid JSON." }] };
	}
	const invalid = (): { errors: ManifestError[] } => ({
		errors: [{ reason: "invalid-manifest", message: "Manifest has an invalid structure or duplicate identifier." }],
	});
	if (!object(value) || !keys(value, ["version", "source", "title", "scenes", "captions"])) return invalid();
	if (value.version !== 1 || !object(value.source) || !string(value.title)) return invalid();
	const source = value.source;
	if (!keys(source, ["runId", "stepCount", "digest"]) || !string(source.runId) || !string(source.digest)) return invalid();
	if (typeof source.stepCount !== "number" || !Number.isSafeInteger(source.stepCount) || source.stepCount < 0) return invalid();
	if (!Array.isArray(value.scenes) || !Array.isArray(value.captions)) return invalid();
	const sceneIds = new Set<string>();
	for (const scene of value.scenes) {
		if (!validScene(scene) || sceneIds.has(scene.id)) return invalid();
		sceneIds.add(scene.id);
	}
	const captionIds = new Set<string>();
	for (const caption of value.captions) {
		if (!validCaption(caption, sceneIds) || captionIds.has(caption.id)) return invalid();
		captionIds.add(caption.id);
	}
	return value as unknown as Manifest;
}

/** Resolve all scene and caption references against the identified source trace. */
export function resolveManifest(manifest: Manifest, trace: Trace): ResolvedManifest | { errors: ManifestError[] } {
	const errors: ManifestError[] = [];
	if (manifest.source.runId !== trace.run.run_id ||
		manifest.source.stepCount !== trace.steps.length ||
		manifest.source.digest !== traceDigest(trace)) {
		errors.push({ reason: "source-mismatch", message: "Manifest source does not match the trace." });
	}
	const indices = new Map<string, number>();
	const label = (id: string) => stepLabel(trace.steps[indices.get(id) ?? -1], trace.run.workspace?.cwd);
	trace.steps.forEach((step, index) => {
		if (indices.has(step.step_id)) {
			errors.push({ reason: "invalid-manifest", message: `Source repeats ${stepLabel(step, trace.run.workspace?.cwd)} with the same identifier.`, step: step.step_id });
		}
		indices.set(step.step_id, index);
	});
	const steps: ResolvedManifest["steps"] = [];
	const ranges: ResolvedManifest["ranges"] = [];
	for (const scene of manifest.scenes) {
		const from = indices.get(scene.range.from);
		const to = indices.get(scene.range.to);
		for (const endpoint of [scene.range.from, scene.range.to]) {
			if (!indices.has(endpoint)) {
				errors.push({ reason: "unknown-step", message: "Scene range references an unknown source step.", step: endpoint, sceneId: scene.id });
			}
		}
		if (from !== undefined && to !== undefined) {
			if (from > to) {
				errors.push({ reason: "invalid-range", message: `Scene range starts at ${label(scene.range.from)} after ${label(scene.range.to)}.`, sceneId: scene.id, from: scene.range.from, to: scene.range.to });
			} else {
				ranges.push({ sceneId: scene.id, from, to });
			}
		}
		for (const id of scene.steps) {
			const index = indices.get(id);
			if (index === undefined) {
				errors.push({ reason: "unknown-step", message: "Scene plays an unknown source step.", step: id, sceneId: scene.id });
			} else if (from !== undefined && to !== undefined && (index < from || index > to)) {
				errors.push({ reason: "invalid-range", message: `${label(id)} is outside its scene's source range.`, step: id, sceneId: scene.id });
			} else {
				steps.push({ id, sceneId: scene.id });
			}
		}
	}
	for (const caption of manifest.captions) {
		const refs = caption.kind === "shows" ? caption.refs : [caption.cause, caption.effect];
		for (const id of refs) {
			if (!indices.has(id)) {
				errors.push({ reason: "unknown-step", message: "Caption references an unknown source step.", step: id, captionId: caption.id });
			}
		}
	}
	return errors.length ? { errors } : { manifest, trace, steps, ranges };
}
