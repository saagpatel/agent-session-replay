import { ATTR, type Step, type Trace } from "../types.ts";
import { buildCausalGraph, evidencedOnly, findPath } from "./causal.ts";
import type { Manifest } from "./manifest.ts";
import type { validateExport } from "./index.ts";
import { stepLabel } from "./operations.ts";

type Validation = ReturnType<typeof validateExport>;
interface EvidenceStep { id: string; label: string; status: string; index: number; timestamp: string; lane?: string }
export interface Sidecar {
	version: 1; sourceDigest: string; verdict: "VALID" | "INVALID";
	counts: { sourceSteps: number; exportedSteps: number; scenes: number; captions: number };
	failures: string[];
	scenes: Array<{ id: string; positionMs: number; durationMs: number;
		range: { from: EvidenceStep | null; to: EvidenceStep | null }; steps: EvidenceStep[];
		captions: Array<{ id: string; kind: "shows" | "because"; text: string; refs: EvidenceStep[];
			path: EvidenceStep[]; ok: boolean; reasons: string[] }> }>;
}

function presentationLabel(step: Step, cwd?: string | null): string {
	const text = (...values: unknown[]) => values.find((value) => typeof value === "string" && value.trim()) as string | undefined;
	const a = step.attributes;
	if (step.kind === "agent") return `Agent ${text(a[ATTR.AGENT_SPAWNS], a[ATTR.AGENT_NAME], a.description, step.subagent_id) ?? "details unknown"}`;
	if (step.kind === "decision") return `Decision: ${(text(a.decision, a.text, a.description) ?? "details unknown").slice(0, 60)}`;
	if (step.kind === "llm") return `LLM: ${(text(a.text, a.description, a[ATTR.REASONING], a[ATTR.MODEL]) ?? "details unknown").slice(0, 60)}`;
	return stepLabel(step, cwd);
}

export function buildSidecar(manifest: Manifest, trace: Trace, validation: Validation): Sidecar {
	const lookup = new Map(trace.steps.map((step, index) => [step.step_id, {
		id: step.step_id, label: presentationLabel(step, trace.run.workspace?.cwd), ...(step.subagent_id ? { lane: step.subagent_id } : {}), status: step.status ?? "unknown",
		index, timestamp: step.started_at,
	}]));
	const graph = evidencedOnly(buildCausalGraph(trace));
	const evidence = (ids: string[]) => ids.flatMap((id) => lookup.has(id) ? [lookup.get(id)!] : []);
	let positionMs = 3500;
	const scenes = manifest.scenes.map((scene) => {
		const durationMs = scene.durationMs ?? 3500;
		const result: Sidecar["scenes"][number] = {
			id: scene.id, positionMs, durationMs,
			range: { from: lookup.get(scene.range.from) ?? null, to: lookup.get(scene.range.to) ?? null },
			steps: evidence(scene.steps),
			captions: manifest.captions.filter((caption) => caption.sceneId === scene.id).map((caption) => {
				const failures = validation.failures.filter((failure) => "captionId" in failure && failure.captionId === caption.id);
				const unevaluated = validation.failures.some((failure) => ["source-mismatch", "invalid-manifest", "unknown-step", "invalid-range"].includes(failure.reason));
				const ids = caption.kind === "shows" ? caption.refs : [caption.cause, caption.effect];
				const path = caption.kind === "because" ? findPath(graph, caption.cause, caption.effect) ?? [] : [];
				return { id: caption.id, kind: caption.kind, text: caption.text, refs: evidence(ids), path: evidence(path),
					ok: failures.length === 0 && !unevaluated, reasons: [...failures.map((failure) => `${failure.reason}: ${failure.message}`), ...(unevaluated ? ["validation-incomplete: Caption validation could not be completed."] : [])] };
			}),
		};
		positionMs += durationMs;
		return result;
	});
	return { version: 1, sourceDigest: manifest.source.digest, verdict: validation.ok ? "VALID" : "INVALID",
		counts: { sourceSteps: trace.steps.length, exportedSteps: manifest.scenes.reduce((n, scene) => n + scene.steps.length, 0), scenes: scenes.length, captions: manifest.captions.length },
		failures: validation.failures.map((failure) => `${failure.reason}: ${failure.message}`), scenes };
}

/** Check schema, and verify played references against the source and export. Range endpoints and path
 * intermediates are source evidence and can legitimately lie outside the shortened export. */
export function validateSidecar(value: unknown, trace: Trace, manifest: Manifest): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
	const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
	const played = new Set(manifest.scenes.flatMap((scene) => scene.steps));
	const indices = new Map(trace.steps.map((step, index) => [step.step_id, index]));
	const step = (v: unknown, requirePlayed: boolean) => {
		if (!obj(v) || typeof v.id !== "string" || typeof v.label !== "string" || typeof v.status !== "string" ||
			!Number.isSafeInteger(v.index) || typeof v.timestamp !== "string" || (v.lane !== undefined && typeof v.lane !== "string")) { errors.push("Invalid step evidence."); return; }
		if (!indices.has(v.id) || indices.get(v.id) !== v.index) errors.push(`Unknown or mismatched source step: ${v.id}`);
		if (requirePlayed && !played.has(v.id)) errors.push(`Step is not exported: ${v.id}`);
	};
	if (!obj(value) || value.version !== 1 || typeof value.sourceDigest !== "string" ||
		(value.verdict !== "VALID" && value.verdict !== "INVALID") || !obj(value.counts) ||
		!["sourceSteps", "exportedSteps", "scenes", "captions"].every((key) => Number.isSafeInteger((value.counts as Record<string, unknown>)[key]) && Number((value.counts as Record<string, unknown>)[key]) >= 0) ||
		!strings(value.failures) || !Array.isArray(value.scenes)) return { ok: false, errors: ["Invalid sidecar structure."] };
	for (const scene of value.scenes) {
		if (!obj(scene) || typeof scene.id !== "string" || typeof scene.positionMs !== "number" || !Number.isFinite(scene.positionMs) ||
			typeof scene.durationMs !== "number" || !Number.isFinite(scene.durationMs) || scene.durationMs <= 0 || !obj(scene.range) ||
			!Array.isArray(scene.steps) || !Array.isArray(scene.captions)) { errors.push("Invalid scene structure."); continue; }
		step(scene.range.from, false); step(scene.range.to, false);
		scene.steps.forEach((s) => step(s, true));
		for (const caption of scene.captions) {
			if (!obj(caption) || typeof caption.id !== "string" || !["shows", "because"].includes(String(caption.kind)) ||
				typeof caption.text !== "string" || typeof caption.ok !== "boolean" || !strings(caption.reasons) ||
				!Array.isArray(caption.refs) || !Array.isArray(caption.path)) { errors.push("Invalid caption structure."); continue; }
			caption.refs.forEach((s) => step(s, true)); caption.path.forEach((s) => step(s, false));
		}
	}
	return { ok: errors.length === 0, errors };
}
function wrap(text: string): string {
	const words = text.replace(/\s+/g, " ").trim().split(" ");
	const lines: string[] = []; let line = "";
	for (let word of words) {
		while (word.length > 116) { if (line) { lines.push(line); line = ""; } lines.push(word.slice(0, 116)); word = word.slice(116); }
		if (line && line.length + word.length + 1 > 116) { lines.push(line); line = ""; }
		line += `${line ? " " : ""}${word}`;
	}
	if (line) lines.push(line);
	return lines.join("\n");
}
export function renderSidecarMarkdown(sidecar: Sidecar): string {
	const number = (step: EvidenceStep | null) => step ? `#${step.index + 1}` : "unknown";
	const time = (ms: number) => `${Math.floor(ms / 60000)}:${(ms % 60000 / 1000).toFixed(1).padStart(4, "0")}`;
	const lines = ["# Replay evidence", "How to read this: source step numbers link the replay to its recorded evidence.",
		`Verdict: ${sidecar.verdict}`, wrap(`Source digest: ${sidecar.sourceDigest}`),
		wrap(`Source steps: ${sidecar.counts.sourceSteps}; exported: ${sidecar.counts.exportedSteps}; scenes: ${sidecar.counts.scenes}; captions: ${sidecar.counts.captions}`)];
	for (const failure of sidecar.failures) lines.push(wrap(`Failure: ${failure}`));
	for (const [index, scene] of sidecar.scenes.entries()) {
		lines.push("", wrap(`## Scene ${index + 1} of ${sidecar.scenes.length} · ${scene.id}`));
		lines.push(wrap(`Plays at ${time(scene.positionMs)} for ${scene.durationMs / 1000} s · source steps ${number(scene.range.from)}–${number(scene.range.to)} (range ${scene.range.from?.label ?? "unknown"} … ${scene.range.to?.label ?? "unknown"})`));
		for (const step of scene.steps) lines.push(wrap(`- ${number(step)} ${step.label} · ${step.status}${step.lane ? ` · ${step.lane.replaceAll("-", " ")}` : ""}`));
		for (const caption of scene.captions) {
			lines.push(wrap(`> “${caption.text}”`));
			if (caption.kind === "shows") lines.push(wrap(`shows ${caption.refs.map(number).join(", ") || "unknown"}`));
			else lines.push(wrap(`because ${number(caption.refs[0] ?? null)} → ${number(caption.refs[1] ?? null)} (path: ${caption.path.map(number).join(" → ") || "unknown"})`));
			for (const reason of caption.reasons.length ? caption.reasons : [""]) lines.push(wrap(`${caption.ok ? "✓" : "✗"} ${reason}`));
		}
	}
	return `${lines.join("\n")}\n`;
}
