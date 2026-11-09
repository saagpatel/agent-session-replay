import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ATTR } from "../types.ts";
import { buildCausalGraph, happensBefore } from "./causal.ts";
import { parseManifest } from "./manifest.ts";
import { validateExport } from "./index.ts";
import { generateReplayFixtures } from "./fixtures/generate.ts";

const kinds = ["reversed-cause-effect", "dropped-prerequisite", "absent-event-caption", "unsupported-claim", "cross-subagent-reorder"];
const reasons: Record<string, string> = {
	"reversed-cause-effect": "reversed-causal-order",
	"dropped-prerequisite": "dropped-prerequisite",
	"absent-event-caption": "caption-ref-absent",
	"unsupported-claim": "caption-unsupported-claim",
	"cross-subagent-reorder": "reversed-causal-order",
};

test("20 synthetic traces have faithful shortened manifests", () => {
	const { sessions } = generateReplayFixtures();
	assert.equal(sessions.length, 20);
	const workerCounts = new Set<number>();
	const cycleCounts = new Set<number>();
	const fanouts = new Set<number>();
	const hookPositions = new Set<string>();
	const compactPositions = new Set<string>();
	const workerInterleavings = new Set<string>();
	for (const { slug, trace, faithful } of sessions) {
		const n = Number(slug.slice(0, 2)) - 1;
		assert.equal(trace.plumbline_version, "1");
		assert.equal(typeof trace.run.run_id, "string");
		assert.ok(Array.isArray(trace.steps));
		for (const step of trace.steps) {
			assert.equal(typeof step.step_id, "string");
			assert.equal(typeof step.kind, "string");
			assert.ok(Number.isFinite(Date.parse(step.started_at)));
			assert.ok(step.attributes && typeof step.attributes === "object");
		}
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
		const parsed = parseManifest(faithful);
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

test("misleading edits fail with their named reason and expected counts", () => {
	const { sessions, misleading } = generateReplayFixtures();
	const traces = new Map(sessions.map(({ slug, trace }) => [slug, trace]));
	const counts = new Map<string, number>();
	for (const item of misleading) {
		assert.ok(kinds.includes(item.kind), item.kind);
		assert.equal(item.expect.reason, reasons[item.kind], `${item.slug}.${item.kind}`);
		const result = validateExport(item.manifest, traces.get(item.slug)!);
		assert.equal(result.ok, false, `${item.slug}.${item.kind}`);
		assert.ok(result.failures.some((failure) => failure.reason === item.expect.reason), `${item.slug}.${item.kind}: ${JSON.stringify(result.failures)}`);
		counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
	}
	assert.deepEqual(Object.fromEntries(counts), {
		"reversed-cause-effect": 20,
		"dropped-prerequisite": 20,
		"absent-event-caption": 20,
		"unsupported-claim": 10,
		"cross-subagent-reorder": 10,
	});
});

test("fixture generation is deterministic", () => {
	const first = generateReplayFixtures();
	const second = generateReplayFixtures();
	assert.deepEqual(second, first);
	const digest = createHash("sha256").update(JSON.stringify(first)).digest("hex");
	assert.equal(digest, "52dbd517418981f98bbfbdee8feca4cdceac52c4167992258e66328c2e02cbdf");
});
