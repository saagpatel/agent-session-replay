import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ATTR, type Trace } from "../types.ts";
import { buildCausalGraph, happensBefore } from "./causal.ts";
import { parseManifest, type Manifest } from "./manifest.ts";
import { validateExport } from "./index.ts";

const sessions = "fixtures/replay-sessions";
const misleading = "fixtures/misleading-edits";
const files = (dir: string) => readdirSync(dir).sort();
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const traceFiles = () => files(sessions).filter((name) => name.endsWith(".trace.json"));
const slugOf = (name: string) => name.slice(0, -".trace.json".length);
function loadTrace(slug: string): Trace {
	const value = json(`${sessions}/${slug}.trace.json`) as Trace;
	assert.equal(value.plumbline_version, "1");
	assert.equal(typeof value.run.run_id, "string");
	assert.ok(Array.isArray(value.steps));
	for (const step of value.steps) {
		assert.equal(typeof step.step_id, "string");
		assert.equal(typeof step.kind, "string");
		assert.ok(Number.isFinite(Date.parse(step.started_at)));
		assert.ok(step.attributes && typeof step.attributes === "object");
	}
	return value;
}

test("sessions --count: 20 synthetic traces have faithful shortened manifests", () => {
	assert.equal(traceFiles().length, 20);
	assert.equal(files(sessions).length, 40);
	for (const file of traceFiles()) {
		const slug = slugOf(file);
		const trace = loadTrace(slug);
		assert.ok(trace.steps.length >= 25 && trace.steps.length <= 80, slug);
		const graph = buildCausalGraph(trace);
		assert.ok(happensBefore(graph, "edit-a", "test"), slug);
		assert.equal(trace.steps.find((step) => step.step_id === "edit-a")?.caused_by, "gate", slug);
		assert.ok(trace.steps.some((step) => step.kind === "compaction"), slug);
		assert.equal(new Set(trace.steps.flatMap((step) => step.subagent_id ? [step.subagent_id] : [])).size, 2, slug);
		const left = trace.steps.find((step) => step.step_id === "parallel-a")!;
		const right = trace.steps.find((step) => step.step_id === "parallel-b")!;
		assert.equal(left.kind, "tool_call");
		assert.equal(right.kind, "tool_call");
		assert.ok(Date.parse(left.ended_at!) > Date.parse(right.started_at), slug);
		assert.equal(happensBefore(graph, left.step_id, right.step_id), false, slug);
		assert.equal(trace.steps.find((step) => step.step_id === "gate")?.attributes[ATTR.HOOK_VERDICT], "allow");
		const parsed = parseManifest(json(`${sessions}/${slug}.faithful.manifest.json`));
		assert.ok(!("errors" in parsed), slug);
		assert.ok(parsed.scenes.length >= 3 && parsed.scenes.length <= 6, slug);
		assert.ok(parsed.captions.length >= 3 && parsed.captions.length <= 8, slug);
		assert.ok(parsed.captions.some((caption) => caption.kind === "because"), slug);
		assert.ok(parsed.scenes.flatMap((scene) => scene.steps).length <= trace.steps.length * 0.6, slug);
		const result = validateExport(parsed, trace);
		assert.deepEqual(result.failures, [], slug);
		assert.equal(result.ok, true, slug);
		const indices = new Map(trace.steps.map((step, index) => [step.step_id, index]));
		const ranges = parsed.scenes.map((scene) => [indices.get(scene.range.from)!, indices.get(scene.range.to)!]);
		assert.ok(ranges.slice(0, 3).every((range, i) => ranges.slice(0, 3).every((other, j) => i === j || Math.max(range[0]!, other[0]!) <= Math.min(range[1]!, other[1]!))), slug);
	}
});

test("misleading edits fail with their named reason", () => {
	const counts = new Map<string, number>();
	const kinds = ["reversed-cause-effect", "dropped-prerequisite", "absent-event-caption", "unsupported-claim", "cross-subagent-reorder"];
	const reasons: Record<string, string> = { "reversed-cause-effect": "reversed-causal-order", "dropped-prerequisite": "dropped-prerequisite", "absent-event-caption": "caption-ref-absent", "unsupported-claim": "caption-unsupported-claim", "cross-subagent-reorder": "reversed-causal-order" };
	for (const file of files(misleading)) {
		const kind = kinds.find((item) => file.endsWith(`.${item}.manifest.json`));
		assert.ok(kind, file);
		const slug = file.slice(0, -`.${kind}.manifest.json`.length);
		const data = json(`${misleading}/${file}`) as Manifest & { expect: { reason: string } };
		const { expect, ...manifest } = data;
		assert.equal(typeof expect.reason, "string", file);
		assert.equal(expect.reason, reasons[kind], file);
		const result = validateExport(manifest, loadTrace(slug));
		assert.equal(result.ok, false, file);
		assert.ok(result.failures.some((failure) => failure.reason === expect.reason), `${file}: ${JSON.stringify(result.failures)}`);
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	for (const file of traceFiles()) {
		const slug = slugOf(file);
		for (const kind of kinds.slice(0, 3)) assert.ok(files(misleading).includes(`${slug}.${kind}.manifest.json`));
	}
	assert.ok((counts.get(kinds[3]!) ?? 0) + (counts.get(kinds[4]!) ?? 0) >= 10);
	console.log("Misleading edit counts:\n" + kinds.map((kind) => `${kind}\t${counts.get(kind) ?? 0}`).join("\n"));
});

test("fixture regeneration is byte-identical", () => {
	const temp = mkdtempSync(resolve(".replay-fixtures-"));
	try {
		execFileSync(process.execPath, ["--experimental-strip-types", "scripts/gen-replay-fixtures.ts", temp]);
		for (const dir of [sessions, misleading]) {
			const generated = resolve(temp, dir);
			assert.deepEqual(files(generated), files(dir));
			for (const name of files(dir)) assert.deepEqual(readFileSync(resolve(generated, name)), readFileSync(resolve(dir, name)), name);
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
