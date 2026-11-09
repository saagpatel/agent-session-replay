import { test } from "node:test";
import assert from "node:assert/strict";
import { generateReplayFixtures } from "./fixtures/generate.ts";
import { validateExport } from "./index.ts";
import { buildSidecar, renderSidecarMarkdown, validateSidecar } from "./sidecar.ts";

test("all generated sidecars retain scene and caption evidence", () => {
	for (const { trace, faithful } of generateReplayFixtures().sessions) {
		const sidecar = buildSidecar(faithful, trace, validateExport(faithful, trace));
		assert.deepEqual(validateSidecar(sidecar, trace, faithful), { ok: true, errors: [] });
		const markdown = renderSidecarMarkdown(sidecar);
		for (const [i, scene] of faithful.scenes.entries()) {
			assert.deepEqual(sidecar.scenes[i]!.steps.map((s) => s.id), scene.steps);
			assert.equal(sidecar.scenes[i]!.range.from?.id, scene.range.from);
			assert.equal(sidecar.scenes[i]!.range.to?.id, scene.range.to);
			assert.ok(markdown.includes(`## Scene ${i + 1} of ${faithful.scenes.length} · ${scene.id}`));
		}
		for (const caption of faithful.captions) {
			const actual = sidecar.scenes.flatMap((s) => s.captions).find((c) => c.id === caption.id)!;
			assert.deepEqual(actual.refs.map((s) => s.id), caption.kind === "shows" ? caption.refs : [caption.cause, caption.effect]);
			assert.ok(markdown.includes(caption.text));
		}
		assert.ok(markdown.split("\n").every((line) => line.length < 120 && !line.trimStart().startsWith("{")));
		assert.match(markdown, /Plays at 0:03\.5 for .*source steps #\d+–#\d+/);
		assert.match(markdown, /✓ shows #\d+/);
		assert.match(markdown, /✓ because #\d+ → #\d+ \(path: #\d+/);
		assert.match(markdown, /- #\d+ Read .* · ok · worker a/);
	}
});

test("sidecar validator rejects a reference outside the export", () => {
	const { trace, faithful } = generateReplayFixtures().sessions[0]!;
	const sidecar = buildSidecar(faithful, trace, validateExport(faithful, trace));
	const missing = trace.steps.find((s) => !faithful.scenes.some((scene) => scene.steps.includes(s.step_id)))!;
	sidecar.scenes[0]!.captions[0]!.refs.push({ id: missing.step_id, label: "test", status: "unknown", index: trace.steps.indexOf(missing), timestamp: missing.started_at });
	assert.equal(validateSidecar(sidecar, trace, faithful).ok, false);
});

test("labels use recorded details and invalid captions report their reason", () => {
	const { trace, faithful } = generateReplayFixtures().sessions[0]!;
	const agent = trace.steps.find((step) => step.kind === "agent")!;
	const decision = trace.steps.find((step) => step.kind === "decision")!;
	agent.attributes.description = "Inspect the parser";
	decision.attributes.text = "Choose a bounded fix";
	const invalid = structuredClone(faithful);
	const caption = invalid.captions.find((item) => item.kind === "shows")!;
	if (caption.kind !== "shows") throw new Error("Expected shows caption");
	caption.refs = ["missing-step"];
	const sidecar = buildSidecar(invalid, trace, validateExport(invalid, trace));
	assert.match(sidecar.scenes.flatMap((scene) => scene.steps).find((step) => step.id === agent.step_id)!.label, /^Agent worker-/);
	assert.match(sidecar.scenes.flatMap((scene) => scene.steps).find((step) => step.id === decision.step_id)!.label, /^Decision: Choose a bounded fix/);
	assert.match(renderSidecarMarkdown(sidecar), /✗ validation-incomplete: Caption validation could not be completed\./);
});
