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
	const workerCounts = new Set<number>();
	const cycleCounts = new Set<number>();
	const fanouts = new Set<number>();
	const hookPositions = new Set<string>();
	const compactPositions = new Set<string>();
	const workerInterleavings = new Set<string>();
	for (const file of traceFiles()) {
		const slug = slugOf(file);
		const n = Number(slug.slice(0, 2)) - 1;
		const trace = loadTrace(slug);
		assert.ok(trace.steps.length >= 25 && trace.steps.length <= 80, slug);
		const graph = buildCausalGraph(trace);
		assert.ok(happensBefore(graph, "edit-a", "test"), slug);
		assert.equal(trace.steps.find((step) => step.step_id === "edit-a")?.caused_by, "gate", slug);
		assert.ok(trace.steps.some((step) => step.kind === "compaction"), slug);
		const workerCount = new Set(trace.steps.flatMap((step) => step.subagent_id ? [step.subagent_id] : [])).size;
		assert.equal(workerCount, 2 + n % 3, slug);
		workerCounts.add(workerCount);
		workerInterleavings.add(trace.steps.filter((step) => step.subagent_id).map((step) => step.subagent_id).join(","));
		const cycleCount = trace.steps.filter((step) => step.attributes[ATTR.TOOL_NAME] === "Bash" && (step.attributes[ATTR.TOOL_ARGS] as { command?: string }).command === "pnpm test").length;
		assert.equal(cycleCount, 1 + n % 4, slug);
		cycleCounts.add(cycleCount);
		const parallel = trace.steps.filter((step) => step.step_id.startsWith("parallel-"));
		assert.equal(parallel.length, 2 + n % 3, slug);
		fanouts.add(parallel.length);
		const gateIndex = trace.steps.findIndex((step) => step.step_id === "gate");
		assert.equal(trace.steps[gateIndex]?.attributes[ATTR.HOOK_VERDICT], "allow", slug);
		assert.equal(trace.steps.find((step) => step.step_id === "edit-a")?.caused_by, "gate", slug);
		if (n % 3 === 0) assert.ok(gateIndex < trace.steps.findIndex((step) => step.step_id === "spawn-a"), slug);
		if (n % 3 === 1) assert.ok(gateIndex > trace.steps.findIndex((step) => step.step_id.startsWith("consume-")), slug);
		if (n % 3 === 2) {
			const lastPlan = Math.max(...trace.steps.map((step, index) => step.step_id.endsWith("-plan") ? index : -1));
			const firstDone = trace.steps.findIndex((step) => step.step_id.endsWith("-done"));
			assert.ok(gateIndex > lastPlan && gateIndex < firstDone, slug);
		}
		const gateNeighbors = trace.steps.slice(Math.max(0, gateIndex - 1), gateIndex + 2).map((step) => step.step_id).join("|");
		hookPositions.add(gateNeighbors);
		const compactIndex = trace.steps.findIndex((step) => step.step_id === "compact");
		const withoutCompact = trace.steps.filter((step) => step.step_id !== "compact");
		const finishIndex = withoutCompact.findIndex((step) => step.step_id === (n % 4 === 0 ? "review" : "fix"));
		const parallelEnd = withoutCompact.findIndex((step) => step.step_id.startsWith("parallel-") && Number(step.step_id.charCodeAt(9)) === 97 + (2 + n % 3) - 1);
		const expectedCompactIndex = finishIndex + Math.floor((parallelEnd - finishIndex) * (n % 4) / 4);
		assert.equal(compactIndex, expectedCompactIndex, slug);
		compactPositions.add(trace.steps.slice(Math.max(0, compactIndex - 1), compactIndex + 2).map((step) => step.step_id).join("|"));
		const left = trace.steps.find((step) => step.step_id === "parallel-a")!;
		const right = trace.steps.find((step) => step.step_id === "parallel-b")!;
		assert.equal(left.kind, "tool_call");
		assert.equal(right.kind, "tool_call");
		assert.ok(Date.parse(left.ended_at!) > Date.parse(right.started_at), slug);
		assert.equal(happensBefore(graph, left.step_id, right.step_id), false, slug);
		const maxParallelStart = Math.max(...parallel.map((step) => Date.parse(step.started_at)));
		const minParallelEnd = Math.min(...parallel.map((step) => Date.parse(step.ended_at!)));
		assert.ok(maxParallelStart < minParallelEnd, slug);
		for (let i = 0; i < parallel.length; i++) for (let j = i + 1; j < parallel.length; j++) {
			assert.equal(happensBefore(graph, parallel[i]!.step_id, parallel[j]!.step_id), false, slug);
			assert.equal(happensBefore(graph, parallel[j]!.step_id, parallel[i]!.step_id), false, slug);
		}
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
	assert.deepEqual([...workerCounts].sort(), [2, 3, 4]);
	assert.deepEqual([...cycleCounts].sort(), [1, 2, 3, 4]);
	assert.deepEqual([...fanouts].sort(), [2, 3, 4]);
	assert.ok(hookPositions.size >= 3);
	assert.ok(compactPositions.size >= 4);
	assert.ok(workerInterleavings.size >= 6);
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
