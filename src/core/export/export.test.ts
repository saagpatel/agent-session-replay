import test from "node:test";
import assert from "node:assert/strict";
import { ATTR, type Step, type Trace } from "../types.ts";
import { classifyCommand } from "../diff/normalize.ts";
import { buildCausalGraph, findPath, happensBefore } from "./causal.ts";
import { checkCaptions } from "./caption-ref.ts";
import { checkOrder } from "./order-check.ts";
import {
	parseManifest,
	resolveManifest,
	traceDigest,
	type Manifest,
} from "./manifest.ts";
import { validateExport } from "./index.ts";

function makeStep(id: string, extra: Partial<Step> = {}): Step {
	return {
		step_id: id,
		kind: "tool_call",
		started_at: "2026-01-01T00:00:00Z",
		attributes: {},
		...extra,
	};
}

function toolStep(
	id: string,
	name: string,
	args: Record<string, unknown> = {},
	extra: Partial<Step> = {},
): Step {
	return makeStep(id, {
		attributes: {
			[ATTR.TOOL_NAME]: name,
			[ATTR.TOOL_ARGS]: args,
		},
		...extra,
	});
}

function makeTrace(steps: Step[], cwd = "/work/project"): Trace {
	return {
		plumbline_version: "1",
		run: {
			run_id: "synthetic-run",
			harness: { name: "fixture" },
			started_at: "2026-01-01T00:00:00Z",
			workspace: { cwd },
		},
		steps,
	};
}

function manifestFor(trace: Trace, scenes: Manifest["scenes"], captions: Manifest["captions"] = []): Manifest {
	return {
		version: 1,
		source: {
			runId: trace.run.run_id,
			stepCount: trace.steps.length,
			digest: traceDigest(trace),
		},
		title: "Synthetic replay",
		scenes,
		captions,
	};
}

function oneScene(trace: Trace, steps: string[], range?: { from: string; to: string }): Manifest {
	const first = trace.steps[0]?.step_id ?? "missing-first";
	const last = trace.steps.at(-1)?.step_id ?? first;
	return manifestFor(trace, [
		{
			id: "scene-main",
			range: range ?? { from: first, to: last },
			steps,
		},
	]);
}

function errorReasons(result: ReturnType<typeof resolveManifest>): string[] {
	return "errors" in result ? result.errors.map((failure) => failure.reason) : [];
}

test("resolves every scene range to inclusive source indices and preserves playback order", () => {
	const trace = makeTrace([makeStep("s1"), makeStep("s2"), makeStep("s3"), makeStep("s4")]);
	const manifest = manifestFor(trace, [
		{ id: "opening", range: { from: "s1", to: "s2" }, steps: ["s2", "s1"] },
		{ id: "ending", range: { from: "s3", to: "s4" }, steps: ["s4"] },
	]);
	const parsed = parseManifest(JSON.stringify(manifest));
	assert.ok(!("errors" in parsed));
	const resolved = resolveManifest(parsed, trace);
	assert.ok(!("errors" in resolved));
	assert.deepEqual(resolved.ranges, [
		{ sceneId: "opening", from: 0, to: 1 },
		{ sceneId: "ending", from: 2, to: 3 },
	]);
	assert.deepEqual(resolved.steps, [
		{ id: "s2", sceneId: "opening" },
		{ id: "s1", sceneId: "opening" },
		{ id: "s4", sceneId: "ending" },
	]);
});

test("rejects a scene with an unknown range endpoint", () => {
	const trace = makeTrace([makeStep("s1")]);
	assert.ok(errorReasons(resolveManifest(oneScene(trace, ["s1"], { from: "unknown", to: "s1" }), trace)).includes("unknown-step"));
});

test("rejects an unknown step listed for a scene", () => {
	const trace = makeTrace([makeStep("s1")]);
	assert.ok(errorReasons(resolveManifest(oneScene(trace, ["s1", "missing"]), trace)).includes("unknown-step"));
});

test("rejects a range whose from step follows its to step in source order", () => {
	const trace = makeTrace([makeStep("s1"), makeStep("s2")]);
	assert.ok(errorReasons(resolveManifest(oneScene(trace, ["s1"], { from: "s2", to: "s1" }), trace)).includes("invalid-range"));
});

test("rejects a scene step outside its declared source range", () => {
	const trace = makeTrace([makeStep("s1"), makeStep("s2"), makeStep("s3")]);
	assert.ok(errorReasons(resolveManifest(oneScene(trace, ["s1", "s3"], { from: "s1", to: "s2" }), trace)).includes("invalid-range"));
});

test("rejects a source digest mismatch", () => {
	const trace = makeTrace([makeStep("s1")]);
	const manifest = oneScene(trace, ["s1"]);
	manifest.source.digest = "0000000000000000";
	assert.ok(errorReasons(resolveManifest(manifest, trace)).includes("source-mismatch"));
});

test("rejects a source run id mismatch", () => {
	const trace = makeTrace([makeStep("s1")]);
	const manifest = oneScene(trace, ["s1"]);
	manifest.source.runId = "another-run";
	assert.ok(errorReasons(resolveManifest(manifest, trace)).includes("source-mismatch"));
});

test("rejects a source step count mismatch", () => {
	const trace = makeTrace([makeStep("s1")]);
	const manifest = oneScene(trace, ["s1"]);
	manifest.source.stepCount += 1;
	assert.ok(errorReasons(resolveManifest(manifest, trace)).includes("source-mismatch"));
});

test("parses only the strict manifest shape and reports invalid JSON", () => {
	const trace = makeTrace([makeStep("s1")]);
	const manifest = oneScene(trace, ["s1"]);
	assert.ok("errors" in parseManifest("{"));
	assert.ok("errors" in parseManifest({ ...manifest, extra: true }));
	assert.ok("errors" in parseManifest({ ...manifest, version: 2 }));
	assert.ok("errors" in parseManifest({
		...manifest,
		scenes: [{ ...manifest.scenes[0]!, range: { ...manifest.scenes[0]!.range, approximate: true } }],
	}));
	assert.ok("errors" in parseManifest({
		...manifest,
		captions: [{ id: "caption", sceneId: "scene-main", kind: "shows", text: "Shown", refs: ["s1"], extra: true }],
	}));
});

test("trace digest changes when the source step order or kind changes", () => {
	const first = makeTrace([makeStep("one"), makeStep("two")]);
	const reordered = makeTrace([makeStep("two"), makeStep("one")]);
	const retyped = makeTrace([makeStep("one", { kind: "decision" }), makeStep("two")]);
	assert.notEqual(traceDigest(first), traceDigest(reordered));
	assert.notEqual(traceDigest(first), traceDigest(retyped));
});

test("rejects a duplicate step played in two scenes", () => {
	const trace = makeTrace([makeStep("s1"), makeStep("s2")]);
	const manifest = manifestFor(trace, [
		{ id: "first", range: { from: "s1", to: "s2" }, steps: ["s1"] },
		{ id: "second", range: { from: "s1", to: "s2" }, steps: ["s1"] },
	]);
	const result = validateExport(manifest, trace);
	assert.ok(result.failures.some((failure) => failure.reason === "duplicate-step"));
});

test("rejects a duplicate step played twice within one scene", () => {
	const trace = makeTrace([makeStep("s1"), makeStep("s2")]);
	const result = validateExport(oneScene(trace, ["s1", "s1", "s2"]), trace);
	assert.ok(result.failures.some((failure) => failure.reason === "duplicate-step"));
});

test("rejects overlapping scene source ranges even when playback steps differ", () => {
	const trace = makeTrace([makeStep("s1"), makeStep("s2"), makeStep("s3")]);
	const manifest = manifestFor(trace, [
		{ id: "first", range: { from: "s1", to: "s2" }, steps: ["s1"] },
		{ id: "second", range: { from: "s2", to: "s3" }, steps: ["s3"] },
	]);
	const result = validateExport(manifest, trace);
	assert.ok(result.failures.some((failure) => failure.reason === "duplicate-step"));
});

test("builds evidenced links for interleaved sidechains and a parallel tool pair", () => {
	const steps = [
		makeStep("spawn-a", { kind: "agent", attributes: { [ATTR.AGENT_SPAWNS]: "agent-a" } }),
		makeStep("spawn-b", { kind: "agent", attributes: { [ATTR.AGENT_SPAWNS]: "agent-b" } }),
		toolStep("a-first", "Edit", { file_path: "/work/project/src/a.ts" }, { subagent_id: "agent-a" }),
		toolStep("b-first", "Bash", { command: "pnpm test:unit" }, { subagent_id: "agent-b" }),
		makeStep("a-last", { subagent_id: "agent-a", caused_by: "a-first" }),
		makeStep("b-last", { subagent_id: "agent-b", caused_by: "b-first" }),
		makeStep("consume-a", { parent_step_id: "a-last" }),
		makeStep("consume-b", { caused_by: "b-last" }),
		toolStep("parallel-left", "Read", { file_path: "src/left.ts" }),
		toolStep("parallel-right", "Read", { file_path: "src/right.ts" }),
	];
	const graph = buildCausalGraph(makeTrace(steps));
	assert.ok(happensBefore(graph, "spawn-a", "a-first"));
	assert.ok(happensBefore(graph, "spawn-b", "b-first"));
	assert.ok(happensBefore(graph, "a-last", "consume-a"));
	assert.ok(happensBefore(graph, "b-last", "consume-b"));
	assert.equal(happensBefore(graph, "parallel-left", "parallel-right"), false);
	assert.equal(happensBefore(graph, "parallel-right", "parallel-left"), false);
	assert.deepEqual(graph.diagnostics, []);
});

test("links only the first explicit parent-context consumer of a subagent result", () => {
	const trace = makeTrace([
		makeStep("spawn", { kind: "agent", attributes: { [ATTR.AGENT_SPAWNS]: "child" } }),
		makeStep("child-last", { subagent_id: "child" }),
		makeStep("unlinked-earlier"),
		makeStep("consumer", { parent_step_id: "child-last" }),
	]);
	const graph = buildCausalGraph(trace);
	assert.ok(happensBefore(graph, "child-last", "consumer"));
	assert.equal(happensBefore(graph, "child-last", "unlinked-earlier"), false);
});

test("does not choose an earlier or wrong-context subagent reference as consumer", () => {
	const trace = makeTrace([
		makeStep("spawn", { kind: "agent", attributes: { [ATTR.AGENT_SPAWNS]: "child" } }),
		makeStep("early-reference", { parent_step_id: "child-last" }),
		makeStep("child-last", { subagent_id: "child" }),
		makeStep("wrong-context", { subagent_id: "other", caused_by: "child-last" }),
		makeStep("consumer", { parent_step_id: "child-last" }),
	]);
	const graph = buildCausalGraph(trace);
	assert.deepEqual(
		graph.edges.filter((edge) => edge.kind === "consumer").map((edge) => edge.to),
		["consumer"],
	);
});

test("reports an unlinked subagent result instead of guessing a consumer edge", () => {
	const trace = makeTrace([
		makeStep("spawn", { kind: "agent", attributes: { [ATTR.AGENT_SPAWNS]: "child" } }),
		makeStep("child-last", { subagent_id: "child" }),
		makeStep("parent-next"),
	]);
	const graph = buildCausalGraph(trace);
	assert.ok(graph.diagnostics.some((diagnostic) => diagnostic.reason === "unlinked-subagent-result"));
	assert.equal(happensBefore(graph, "child-last", "parent-next"), false);
});

test("accepts a faithful shortened replay", () => {
	const write = toolStep("write", "Edit", { file_path: "src/a.ts" });
	const read = toolStep("read", "Read", { file_path: "src/a.ts" });
	const testRun = toolStep("test", "Bash", { command: "pnpm test" });
	const trace = makeTrace([write, makeStep("omitted"), read, testRun]);
	const result = validateExport(oneScene(trace, ["write", "test"]), trace);
	assert.equal(result.ok, true);
});

test("allows concurrent steps to swap playback order", () => {
	const trace = makeTrace([makeStep("before"), makeStep("left"), makeStep("right"), makeStep("after")]);
	const graph = buildCausalGraph(trace);
	const resolved = resolveManifest(oneScene(trace, ["before", "right", "left", "after"]), trace);
	assert.ok(!("errors" in resolved));
	assert.deepEqual(checkOrder(resolved, graph), []);
});

test("reports reversed causal order with structured ids, shortest path, and human labels", () => {
	const write = toolStep("write", "Edit", { file_path: "src/a.ts" });
	const read = toolStep("read", "Read", { file_path: "src/a.ts" });
	const trace = makeTrace([write, read]);
	const result = validateExport(oneScene(trace, ["read", "write"]), trace);
	const failure = result.failures.find((item) => item.reason === "reversed-causal-order");
	assert.ok(failure);
	assert.equal(failure.a, "write");
	assert.equal(failure.b, "read");
	assert.deepEqual(failure.path, ["write", "read"]);
	assert.match(failure.message, /Edit src\/a\.ts/);
	assert.match(failure.message, /Read src\/a\.ts/);
	assert.doesNotMatch(failure.message, /\b(write|read)\b/);
});

test("reports a shows caption that points to an absent event", () => {
	const trace = makeTrace([
		toolStep("read", "Read", { file_path: "src/a.ts" }),
		toolStep("missing-edit", "Edit", { file_path: "src/b.ts" }),
	]);
	const manifest = oneScene(trace, ["read"]);
	manifest.captions.push({
		id: "caption-absent",
		sceneId: "scene-main",
		kind: "shows",
		text: "The replay shows the edit.",
		refs: ["missing-edit"],
	});
	const result = validateExport(manifest, trace);
	assert.ok(result.failures.some((failure) => failure.reason === "caption-ref-absent"));
});

test("rejects a caption reference to an unknown source event", () => {
	const trace = makeTrace([makeStep("s1")]);
	const manifest = oneScene(trace, ["s1"]);
	manifest.captions.push({
		id: "caption-unknown",
		sceneId: "scene-main",
		kind: "shows",
		text: "This event is not in the source trace.",
		refs: ["unknown-event"],
	});
	const resolved = resolveManifest(manifest, trace);
	assert.ok("errors" in resolved);
	assert.ok(resolved.errors.some((error) => error.reason === "unknown-step" && error.captionId === "caption-unknown"));
});

test("requires every direct write prerequisite of a because caption effect", () => {
	const firstWrite = toolStep("write-a", "Edit", { file_path: "src/a.ts" });
	const secondWrite = toolStep("write-b", "Write", { file_path: "src/b.ts" });
	const testRun = toolStep("test", "Bash", { command: "pnpm test" });
	const trace = makeTrace([firstWrite, secondWrite, testRun]);
	const manifest = oneScene(trace, ["write-a", "test"]);
	manifest.captions.push({
		id: "caption-because",
		sceneId: "scene-main",
		kind: "because",
		text: "The edits led to the test run.",
		cause: "write-a",
		effect: "test",
	});
	const result = validateExport(manifest, trace);
	assert.ok(result.failures.some((failure) => failure.reason === "dropped-prerequisite" && failure.step === "write-b"));
});

test("reports a because caption whose cause plays after its effect", () => {
	const write = toolStep("write", "Edit", { file_path: "src/a.ts" });
	const testRun = toolStep("test", "Bash", { command: "pnpm test" });
	const trace = makeTrace([write, testRun]);
	const manifest = oneScene(trace, ["test", "write"]);
	manifest.captions.push({
		id: "caption-reversed",
		sceneId: "scene-main",
		kind: "because",
		text: "The edit caused the test.",
		cause: "write",
		effect: "test",
	});
	assert.ok(validateExport(manifest, trace).failures.some((failure) => failure.reason === "caption-reversed"));
});

test("reports a because caption whose source effect is omitted from playback", () => {
	const trace = makeTrace([makeStep("cause"), makeStep("effect")]);
	const manifest = oneScene(trace, ["cause"]);
	manifest.captions.push({
		id: "caption-absent-effect",
		sceneId: "scene-main",
		kind: "because",
		text: "The cause led to the effect.",
		cause: "cause",
		effect: "effect",
	});
	assert.ok(validateExport(manifest, trace).failures.some((failure) => failure.reason === "caption-ref-absent"));
});

test("accepts shows and because captions when all evidence and prerequisites play", () => {
	const write = toolStep("write", "Edit", { file_path: "src/a.ts" });
	const testRun = toolStep("test", "Bash", { command: "pnpm test" });
	const trace = makeTrace([write, testRun]);
	const manifest = oneScene(trace, ["write", "test"]);
	manifest.captions.push(
		{
			id: "caption-shows",
			sceneId: "scene-main",
			kind: "shows",
			text: "The edit and test are shown.",
			refs: ["write", "test"],
		},
		{
			id: "caption-because-supported",
			sceneId: "scene-main",
			kind: "because",
			text: "The edit preceded the test.",
			cause: "write",
			effect: "test",
		},
	);
	assert.equal(validateExport(manifest, trace).ok, true);
});

test("rejects a because caption when no source causal path supports its claim", () => {
	const trace = makeTrace([makeStep("cause"), makeStep("effect")]);
	const manifest = oneScene(trace, ["cause", "effect"]);
	manifest.captions.push({
		id: "caption-unsupported",
		sceneId: "scene-main",
		kind: "because",
		text: "The first event caused the second.",
		cause: "cause",
		effect: "effect",
	});
	assert.ok(validateExport(manifest, trace).failures.some((failure) => failure.reason === "caption-unsupported-claim"));
});

test("reports dangling explicit parent references", () => {
	const graph = buildCausalGraph(makeTrace([
		toolStep("edit-step", "Edit", { file_path: "src/a.ts" }, { parent_step_id: "missing-parent" }),
	]));
	const diagnostic = graph.diagnostics.find((item) => item.reason === "dangling-parent");
	assert.ok(diagnostic);
	assert.match(diagnostic.message, /Edit src\/a\.ts/);
	assert.doesNotMatch(diagnostic.message, /edit-step|missing-parent/);
});

test("reports causal cycles", () => {
	const graph = buildCausalGraph(makeTrace([
		makeStep("first", { caused_by: "second" }),
		makeStep("second", { caused_by: "first" }),
	]));
	const diagnostic = graph.diagnostics.find((item) => item.reason === "causal-cycle");
	assert.ok(diagnostic);
	assert.deepEqual(diagnostic.path, ["first", "second", "first"]);
	for (let index = 0; index < diagnostic.path.length - 1; index++) {
		assert.ok(graph.edges.some((edge) =>
			edge.from === diagnostic.path![index] && edge.to === diagnostic.path![index + 1],
		));
	}
});

test("returns the deterministic shortest causal path", () => {
	const trace = makeTrace([
		makeStep("start"),
		makeStep("long-one", { caused_by: "start" }),
		makeStep("short-one", { parent_step_id: "start", caused_by: "long-two" }),
		makeStep("equal-short", { caused_by: "start" }),
		makeStep("long-two", { caused_by: "long-one" }),
		makeStep("end", { caused_by: "short-one", parent_step_id: "equal-short" }),
	]);
	const graph = buildCausalGraph(trace);
	const path = findPath(graph, "start", "end");
	assert.ok(path);
	assert.equal(path.length, 3);
	assert.deepEqual(path, ["start", "short-one", "end"]);
	assert.deepEqual(path, findPath(graph, "start", "end"));
});

test("recognizes Claude MultiEdit as a write of its target", () => {
	const step = toolStep("multi-edit", "MultiEdit", { file_path: "src/./a.ts" });
	const graph = buildCausalGraph(makeTrace([step, toolStep("read", "Read", { file_path: "src/a.ts" })]));
	assert.ok(happensBefore(graph, "multi-edit", "read"));
});

test("extracts Codex apply_patch update and add paths from input", () => {
	const patch = toolStep("patch", "apply_patch", {
		input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch",
	});
	const trace = makeTrace([
		patch,
		toolStep("read-a", "Read", { file_path: "src/a.ts" }),
		toolStep("read-b", "Read", { file_path: "src/b.ts" }),
	]);
	const graph = buildCausalGraph(trace);
	assert.ok(happensBefore(graph, "patch", "read-a"));
	assert.ok(happensBefore(graph, "patch", "read-b"));
});

test("recognizes Codex write_file and normalizes paths against workspace cwd", () => {
	const trace = makeTrace([
		toolStep("write", "write_file", { path: "/work/project/src/./a.ts" }),
		toolStep("read", "Read", { file_path: "src/a.ts" }),
	]);
	assert.ok(happensBefore(buildCausalGraph(trace), "write", "read"));
});

test("recognizes plain cat and sed file reads after a write", () => {
	const trace = makeTrace([
		toolStep("write", "Write", { file_path: "src/a.ts" }),
		toolStep("cat-read", "Bash", { command: "cat src/a.ts" }),
		toolStep("sed-read", "Bash", { command: "sed -n '2,4p' src/a.ts" }),
	]);
	const graph = buildCausalGraph(trace);
	assert.ok(happensBefore(graph, "write", "cat-read"));
	assert.ok(happensBefore(graph, "write", "sed-read"));
});

test("does not infer file reads from dynamic or compound shell commands", () => {
	const trace = makeTrace([
		toolStep("write", "Write", { file_path: "src/a.ts" }),
		toolStep("dynamic-cat", "Bash", { command: "cat \"$FILE\"" }),
		toolStep("compound-cat", "Bash", { command: "cat src/a.ts && echo done" }),
	]);
	const graph = buildCausalGraph(trace);
	assert.equal(happensBefore(graph, "write", "dynamic-cat"), false);
	assert.equal(happensBefore(graph, "write", "compound-cat"), false);
});

test("does not infer a sed read from mismatched quote delimiters", () => {
	const trace = makeTrace([
		toolStep("write", "Write", { file_path: "src/a.ts" }),
		toolStep("sed-read", "Bash", { command: "sed -n '2,4p\" src/a.ts" }),
	]);
	assert.equal(happensBefore(buildCausalGraph(trace), "write", "sed-read"), false);
});

test("keeps distinct outside-workspace absolute paths from aliasing by tail", () => {
	const trace = makeTrace([
		toolStep("write", "Write", { file_path: "/work/one/src/a.ts" }),
		toolStep("read", "Read", { file_path: "/work/two/src/a.ts" }),
	]);
	assert.equal(happensBefore(buildCausalGraph(trace), "write", "read"), false);
});

test("stops file read dependencies at the next write to that path", () => {
	const trace = makeTrace([
		toolStep("first-write", "Write", { file_path: "src/a.ts" }),
		toolStep("second-write", "Edit", { file_path: "src/a.ts" }),
		toolStep("read", "Read", { file_path: "src/a.ts" }),
	]);
	const graph = buildCausalGraph(trace);
	assert.equal(happensBefore(graph, "first-write", "read"), false);
	assert.ok(happensBefore(graph, "second-write", "read"));
});

test("links all writes since the prior test to the next classified test command", () => {
	const trace = makeTrace([
		toolStep("first-write", "Write", { file_path: "src/a.ts" }),
		toolStep("first-test", "Bash", { command: "pnpm test" }),
		toolStep("second-write", "Edit", { file_path: "src/b.ts" }),
		toolStep("third-write", "write_file", { path: "src/c.ts" }),
		toolStep("second-test", "Bash", { command: "pnpm run test:unit" }),
	]);
	const graph = buildCausalGraph(trace);
	assert.ok(happensBefore(graph, "first-write", "first-test"));
	assert.ok(happensBefore(graph, "second-write", "second-test"));
	assert.ok(happensBefore(graph, "third-write", "second-test"));
	assert.equal(happensBefore(graph, "first-write", "second-test"), false);
});

test("reuses Run Diff command classification to identify test runs", () => {
	const commands = classifyCommand("pnpm test:export", "/work/project");
	assert.equal(commands[0]?.action, "test");
	const trace = makeTrace([
		toolStep("write", "Write", { file_path: "src/a.ts" }),
		toolStep("test", "Bash", { command: "pnpm test:export" }),
	]);
	assert.ok(happensBefore(buildCausalGraph(trace), "write", "test"));
});
