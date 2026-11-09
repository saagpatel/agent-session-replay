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
import { parseCodexTranscript } from "../parsers/codex.ts";
import { parseClaudeCodeTranscript } from "../parsers/claude-code.ts";
import { operationEvidence } from "./operations.ts";

function makeStep(id: string, extra: Partial<Step> = {}): Step {
	return {
		step_id: id,
		kind: "decision",
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
		kind: "tool_call",
		attributes: {
			[ATTR.TOOL_NAME]: name,
			[ATTR.TOOL_ARGS]: args,
		},
		...extra,
	});
}

function completedSpawn(id: string, child: string): Step {
	return makeStep(id, { kind: "agent", ended_at: "2026-01-01T00:00:05Z", attributes: {
		[ATTR.AGENT_SPAWNS]: child,
		[ATTR.CLAUDE_AGENT_RESULT_KIND]: "completed",
	} });
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
	const retyped = makeTrace([makeStep("one", { kind: "llm" }), makeStep("two")]);
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

test("allows overlapping scene source ranges when playback steps differ", () => {
	const trace = makeTrace([makeStep("s1"), makeStep("s2"), makeStep("s3")]);
	const manifest = manifestFor(trace, [
		{ id: "first", range: { from: "s1", to: "s2" }, steps: ["s1"] },
		{ id: "second", range: { from: "s2", to: "s3" }, steps: ["s3"] },
	]);
	const result = validateExport(manifest, trace);
	assert.equal(result.ok, true);
});

test("builds evidenced links for interleaved sidechains and a parallel tool pair", () => {
	const steps = [
		completedSpawn("spawn-a", "agent-a"),
		completedSpawn("spawn-b", "agent-b"),
		toolStep("a-first", "Edit", { file_path: "/work/project/src/a.ts" }, { subagent_id: "agent-a", ended_at: "2026-01-01T00:00:02Z" }),
		toolStep("b-first", "Bash", { command: "pnpm test:unit" }, { subagent_id: "agent-b", ended_at: "2026-01-01T00:00:02Z" }),
		makeStep("a-last", { subagent_id: "agent-a", caused_by: "a-first", ended_at: "2026-01-01T00:00:04Z" }),
		makeStep("b-last", { subagent_id: "agent-b", caused_by: "b-first", ended_at: "2026-01-01T00:00:04Z" }),
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
		completedSpawn("spawn", "child"),
		makeStep("child-last", { subagent_id: "child", ended_at: "2026-01-01T00:00:04Z" }),
		makeStep("unlinked-earlier"),
		makeStep("consumer", { parent_step_id: "child-last" }),
	]);
	const graph = buildCausalGraph(trace);
	assert.ok(happensBefore(graph, "child-last", "consumer"));
	assert.equal(happensBefore(graph, "child-last", "unlinked-earlier"), false);
});

test("does not choose an earlier or wrong-context subagent reference as consumer", () => {
	const trace = makeTrace([
		completedSpawn("spawn", "child"),
		makeStep("early-reference", { parent_step_id: "child-last" }),
		makeStep("child-last", { subagent_id: "child", ended_at: "2026-01-01T00:00:04Z" }),
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
		toolStep("step-edit", "Edit", { file_path: "src/a.ts" }, { parent_step_id: "step-missing" }),
	]));
	const diagnostic = graph.diagnostics.find((item) => item.reason === "dangling-parent");
	assert.ok(diagnostic);
	assert.match(diagnostic.message, /Edit src\/a\.ts/);
	assert.doesNotMatch(diagnostic.message, /step-edit|step-missing/);
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
	const resolved = resolveManifest(oneScene(trace, ["end", "start"]), trace);
	assert.ok(!("errors" in resolved));
	const failure = checkOrder(resolved, graph).find((item) => item.reason === "reversed-causal-order");
	assert.ok(failure?.reason === "reversed-causal-order");
	assert.deepEqual(failure.path, path);
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

test("dynamic or compound shell commands are global barriers rather than inferred reads", () => {
	const trace = makeTrace([
		toolStep("write", "Write", { file_path: "src/a.ts" }),
		toolStep("dynamic-cat", "Bash", { command: "cat \"$FILE\"" }),
		toolStep("compound-cat", "Bash", { command: "cat src/a.ts && echo done" }),
	]);
	const graph = buildCausalGraph(trace);
	for (const id of ["dynamic-cat", "compound-cat"]) {
		assert.ok(happensBefore(graph, "write", id));
		assert.deepEqual(operationEvidence(graph.steps.get(id)!).operations, []);
		assert.ok(graph.edges.some((edge) => edge.to === id && edge.kind === "unresolved-write"));
	}
});

test("does not infer a sed read from mismatched quote delimiters", () => {
	const trace = makeTrace([
		toolStep("write", "Write", { file_path: "src/a.ts" }),
		toolStep("sed-read", "Bash", { command: "sed -n '2,4p\" src/a.ts" }),
	]);
	assert.deepEqual(operationEvidence(trace.steps[1]!).operations, []);
	assert.ok(happensBefore(buildCausalGraph(trace), "write", "sed-read"));
});

test("keeps distinct outside-workspace absolute paths from aliasing by tail", () => {
	const trace = makeTrace([
		toolStep("write", "Write", { file_path: "/work/one/src/a.ts" }),
		toolStep("read", "Read", { file_path: "/work/two/src/a.ts" }),
	]);
	assert.equal(happensBefore(buildCausalGraph(trace), "write", "read"), false);
});

test("stops file read dependencies at a confirmed content-independent write to that path", () => {
	const trace = makeTrace([
		toolStep("first-write", "Write", { file_path: "src/a.ts" }, { ended_at: "2026-01-01T00:00:01Z" }),
		toolStep("second-write", "Write", { file_path: "src/a.ts" }, { status: "ok", started_at: "2026-01-01T00:00:01Z", ended_at: "2026-01-01T00:00:02Z" }),
		toolStep("read", "Read", { file_path: "src/a.ts" }),
	]);
	const graph = buildCausalGraph(trace);
	assert.equal(happensBefore(graph, "first-write", "read"), false);
	assert.ok(happensBefore(graph, "second-write", "read"));
});

test("links current writes to each classified test command", () => {
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
	assert.ok(happensBefore(graph, "first-write", "second-test"));
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

function rollout(cells: string[]): Trace {
	const envelope = (type: string, payload: unknown) => ({ timestamp: "2026-01-01T00:00:00Z", type, payload });
	return parseCodexTranscript([
		envelope("session_meta", { id: "synthetic-exec-run", cwd: "/work/project" }),
		...cells.flatMap((input, index) => [
			envelope("response_item", { type: "custom_tool_call", name: "exec", call_id: `cell-${index}`, input }),
			envelope("response_item", { type: "custom_tool_call_output", call_id: `cell-${index}`, output: "Script completed" }),
		]),
	].map((line) => JSON.stringify(line)).join("\n"));
}

const patchCell = `text(await tools.apply_patch("*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old\\n+new\\n*** End Patch"));`;
const readCell = 'text(await tools.exec_command({cmd: "cat src/a.ts"}));';

test("parsed Codex literal exec calls preserve enclosing IDs and reject a read before its patch", () => {
	const trace = rollout([patchCell, readCell]);
	assert.equal(trace.steps.length, 2);
	const [patch, read] = trace.steps.map((step) => step.step_id) as [string, string];
	const graph = buildCausalGraph(trace);
	assert.deepEqual(graph.diagnostics, []);
	assert.deepEqual(findPath(graph, patch, read), [patch, read]);
	assert.equal(validateExport(oneScene(trace, [patch, read]), trace).ok, true);
	assert.ok(validateExport(oneScene(trace, [read, patch]), trace).failures.some((failure) => failure.reason === "reversed-causal-order"));
});

test("literal exec calls retain all patch targets, workdirs and same-cell accesses without self cycles", () => {
	const trace = rollout([
		patchCell + '\ntext(await tools.exec_command({cmd: "cat src/a.ts"}));',
		'text(await tools.exec_command({cmd: "cat a.ts", workdir: "/work/project/src"}));',
	]);
	const [patch, read] = trace.steps.map((step) => step.step_id) as [string, string];
	const graph = buildCausalGraph(trace);
	assert.deepEqual(graph.diagnostics, []);
	assert.ok(happensBefore(graph, patch, read));
});

test("exec operation evidence is not limited to Run Diff's six stages or root context", () => {
	const patch = ["*** Begin Patch", ...Array.from({ length: 8 }, (_, i) => `*** Add File: src/file-${i}.ts\n+new`), "*** End Patch"].join("\n");
	const trace = rollout([
		`text(await tools.apply_patch(${JSON.stringify(patch)}));`,
		'text(await tools.exec_command({cmd: "cat src/file-7.ts"}));',
	]);
	trace.steps[0]!.subagent_id = "synthetic-child";
	const [write, read] = trace.steps.map((step) => step.step_id) as [string, string];
	assert.ok(happensBefore(buildCausalGraph(trace), write, read));
	assert.equal(validateExport(oneScene(trace, [read, write]), trace).ok, false);
});

test("unresolved exec cells warn unless captions or reordered source intervals depend on them", () => {
	const unsupported = [
		`if (ready) { ${patchCell} }`,
		'text(await tools.exec_command({cmd: command}));',
		'text(await tools.exec_command({cmd: "cat src/a.ts", workdir}));',
		'text(await tools.exec_command({cmd: "cat src/a.ts", ...options}));',
		'text(await tools.exec_command({cmd: "touch src/a.ts; pnpm test"}));',
		'text(await tools.exec_command({cmd: "cat src/a.ts; pnpm test"}));',
		'text(await tools.exec_command({cmd: "cat src/\\u0061.ts"}));',
		'text(await tools.exec_command({cmd: "cat src/\\x61.ts"}));',
		'text(await tools.exec_command({cmd: "cat src/\\\na.ts"}));',
		'text(await tools.unknown_tool({path: "src/a.ts"}));',
		'// tools.apply_patch("fake")\ntext("tools.exec_command(fake)");',
	];
	for (const cell of unsupported) {
		const trace = rollout([patchCell, cell, readCell]);
		const [patch, unknown, read] = trace.steps.map((step) => step.step_id) as [string, string, string];
		const faithful = oneScene(trace, [patch, unknown, read]);
		const result = validateExport(faithful, trace);
		assert.equal(result.ok, true, cell);
		assert.equal(result.warnings[0]?.reason, "unresolved-operation", cell);
		for (const played of [[unknown, patch, read], [read, patch]]) {
			assert.ok(validateExport(oneScene(trace, played), trace).failures.some((failure) => failure.reason === "unresolved-operation"), cell);
		}
		for (const caption of [
			{ id: "show", sceneId: "scene-main", kind: "shows" as const, text: "The cell is shown.", refs: [unknown] },
			{ id: "cause", sceneId: "scene-main", kind: "because" as const, text: "The patch precedes the read.", cause: patch, effect: read },
		]) {
			assert.ok(validateExport({ ...faithful, captions: [caption] }, trace).failures.some((failure) => failure.reason === "unresolved-operation"), cell);
		}
	}
});

test("unrelated unresolved exec cells remain warnings for a supported caption and independent swap", () => {
	const trace = rollout([patchCell, readCell, 'if (ready) text(await tools.unknown_tool({}));']);
	trace.steps.push(makeStep("left"), makeStep("right"));
	const [patch, read] = trace.steps.map((step) => step.step_id) as [string, string];
	const manifest = oneScene(trace, [patch, read, "right", "left"]);
	manifest.captions.push({ id: "supported", sceneId: "scene-main", kind: "because", text: "The patch precedes its read.", cause: patch, effect: read });
	const result = validateExport(manifest, trace);
	assert.equal(result.ok, true);
	assert.equal(result.warnings.length, 1);
});

test("unresolved barriers outside the caption source interval cannot prove a because claim", () => {
	const trace = makeTrace([
		toolStep("unknown", "unknown_tool", {}, { caused_by: "cause" }),
		toolStep("effect", "Read", { file_path: "src/a.ts" }),
		makeStep("cause"),
	]);
	const manifest = oneScene(trace, ["cause", "effect"]);
	manifest.captions.push({ id: "unsupported", sceneId: "scene-main", kind: "because", text: "The cause led to the read.", cause: "cause", effect: "effect" });
	const graph = buildCausalGraph(trace);
	assert.deepEqual(findPath(graph, "cause", "effect"), ["cause", "unknown", "effect"]);
	const resolved = resolveManifest(manifest, trace);
	assert.ok(!("errors" in resolved));
	assert.ok(checkCaptions(resolved, graph).some((failure) => failure.reason === "caption-unsupported-claim"));
	const result = validateExport(manifest, trace);
	assert.equal(result.ok, false);
	assert.ok(result.failures.some((failure) => failure.reason === "caption-unsupported-claim"));
	assert.ok(result.warnings.some((warning) => warning.reason === "unresolved-operation" && warning.step === "unknown"));
});

test("caption scope includes the source interval but not one-sided evidenced dependencies", () => {
	const cases = [
		[
			toolStep("unknown", "unknown_tool"),
			makeStep("cause"),
			makeStep("effect", { parent_step_id: "unknown" }),
		],
		[
			makeStep("cause"),
			makeStep("effect"),
			toolStep("unknown", "unknown_tool", {}, { parent_step_id: "cause" }),
		],
		[
			makeStep("cause"),
			toolStep("unknown", "unknown_tool"),
			makeStep("effect"),
		],
	];
	for (const [index, steps] of cases.entries()) {
		const trace = makeTrace(steps);
		const manifest = oneScene(trace, ["cause", "effect"]);
		manifest.captions.push({ id: "claim", sceneId: "scene-main", kind: "because", text: "The cause led to the effect.", cause: "cause", effect: "effect" });
		const result = validateExport(manifest, trace);
		assert.equal(result.failures.some((failure) => failure.reason === "unresolved-operation"), index === 2);
		assert.equal(result.warnings.some((warning) => warning.reason === "unresolved-operation"), index < 2);
	}
});

test("an evidenced caption path scopes an unresolved step outside the source interval", () => {
	const trace = makeTrace([
		makeStep("effect", { parent_step_id: "unknown" }),
		toolStep("unknown", "unknown_tool", {}, { parent_step_id: "cause" }),
		makeStep("cause"),
	]);
	const manifest = oneScene(trace, ["cause", "unknown", "effect"]);
	manifest.captions.push({ id: "claim", sceneId: "scene-main", kind: "because", text: "The cause led to the effect.", cause: "cause", effect: "effect" });
	const result = validateExport(manifest, trace);
	assert.ok(result.failures.some((failure) => failure.reason === "unresolved-operation" && failure.step === "unknown"));
	assert.ok(!result.failures.some((failure) => failure.reason === "caption-unsupported-claim"));
});

test("caption proofs retain evidenced paths alongside unresolved barriers", () => {
	const trace = makeTrace([
		toolStep("cause", "Write", { file_path: "src/a.ts" }),
		toolStep("unknown", "unknown_tool"),
		toolStep("effect", "Read", { file_path: "src/a.ts" }),
	]);
	const manifest = oneScene(trace, ["cause", "effect"]);
	manifest.captions.push({ id: "supported", sceneId: "scene-main", kind: "because", text: "The write precedes its read.", cause: "cause", effect: "effect" });
	const result = validateExport(manifest, trace);
	assert.ok(result.failures.some((failure) => failure.reason === "unresolved-operation"));
	assert.ok(!result.failures.some((failure) => failure.reason === "caption-unsupported-claim"));
});

test("an incomplete exec cell cannot prove that its literal calls were all invoked", () => {
	const trace = rollout([patchCell, readCell]);
	delete trace.steps[0]!.attributes[ATTR.EXEC_COMPLETED];
	const [patch, read] = trace.steps.map((step) => step.step_id) as [string, string];
	assert.deepEqual(operationEvidence(trace.steps[0]!).operations, []);
	assert.ok(happensBefore(buildCausalGraph(trace), patch, read));
	const manifest = oneScene(trace, [patch, read]);
	assert.equal(validateExport(manifest, trace).warnings[0]?.reason, "unresolved-operation");
	manifest.captions.push({ id: "cause", sceneId: "scene-main", kind: "because", text: "The patch precedes its read.", cause: patch, effect: read });
	const result = validateExport(manifest, trace);
	assert.ok(result.warnings.some((warning) => warning.reason === "unresolved-operation"));
	assert.ok(result.failures.some((failure) => failure.reason === "caption-unsupported-claim"));
});

test("source digest binds causal links, nested tool evidence, workspace and playback fields", () => {
	const trace = makeTrace([
		toolStep("patch", "Edit", { file_path: "src/a.ts", nested: { x: 1, y: 2 } }),
		toolStep("read", "Read", { file_path: "src/a.ts" }),
	]);
	const original = oneScene(trace, ["read", "patch"]);
	assert.equal(validateExport(original, trace).ok, false);
	const changes: Array<(copy: Trace) => void> = [
		(copy) => { (copy.steps[1]!.attributes[ATTR.TOOL_ARGS] as Record<string, unknown>).file_path = "src/b.ts"; },
		(copy) => { copy.steps[1]!.parent_step_id = "patch"; },
		(copy) => { copy.steps[1]!.caused_by = "patch"; },
		(copy) => { copy.steps[1]!.subagent_id = "child"; },
		(copy) => { copy.steps[0]!.attributes[ATTR.AGENT_SPAWNS] = "child"; },
		(copy) => { copy.steps[0]!.attributes[ATTR.TOOL_NAME] = "Read"; },
		(copy) => { copy.run.workspace!.cwd = "/work/other"; },
		(copy) => { copy.steps[0]!.status = "error"; },
		(copy) => { copy.steps[0]!.ended_at = "2026-01-01T00:00:01Z"; },
	];
	for (const change of changes) {
		const copy = structuredClone(trace);
		change(copy);
		assert.ok(validateExport(original, copy).failures.some((failure) => failure.reason === "source-mismatch"));
	}
	const reorderedKeys = structuredClone(trace);
	reorderedKeys.steps[0]!.attributes[ATTR.TOOL_ARGS] = { nested: { y: 2, x: 1 }, file_path: "src/a.ts" };
	assert.equal(traceDigest(reorderedKeys), traceDigest(trace));
});

test("rename destinations are writes and cannot play after their destination read", () => {
	const trace = makeTrace([
		toolStep("rename", "apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-old\n+new\n*** End Patch" }),
		toolStep("destination-read", "Read", { file_path: "src/b.ts" }),
	]);
	assert.equal(validateExport(oneScene(trace, ["rename", "destination-read"]), trace).ok, true);
	const reversed = validateExport(oneScene(trace, ["destination-read", "rename"]), trace);
	assert.ok(reversed.failures.some((failure) => failure.reason === "reversed-causal-order"));
});

function nestedStep(name: string, args: Record<string, unknown>): Step {
	const argument = name === "apply_patch" ? JSON.stringify(args.input) : JSON.stringify(args);
	return toolStep("operation", "exec", { input: `text(await tools.${name}(${argument}));` }, {
		attributes: {
			[ATTR.TOOL_NAME]: "exec",
			[ATTR.TOOL_ARGS]: { input: `text(await tools.${name}(${argument}));` },
			[ATTR.EXEC_COMPLETED]: true,
		},
	});
}

test("uncertain overwrites preserve every possible writer for reads and tests", () => {
	const args = { file_path: "src/a.ts", content: "replacement" };
	for (const nested of [false, true]) for (const status of ["error", "interrupted", undefined, "ok"] as const) {
		const overwrite = nested ? nestedStep("Write", args) : toolStep("operation", "Write", args);
		overwrite.status = status;
		// An ok but unsettled call is also unconfirmed; exec completion alone
		// does not establish that its nested write succeeded.
		if (nested) overwrite.ended_at = "2026-01-01T00:00:02Z";
		const trace = makeTrace([
			toolStep("first", "Write", args, { status: "ok", ended_at: "2026-01-01T00:00:01Z" }),
			overwrite,
			toolStep("read", "Read", { file_path: "src/a.ts" }),
			toolStep("test", "Bash", { command: "pnpm test" }),
			toolStep("later-test", "Bash", { command: "pnpm test" }),
		]);
		const graph = buildCausalGraph(trace);
		for (const from of ["first", "operation"]) for (const [to, kind] of [["read", "file-read"], ["test", "test-write"], ["later-test", "test-write"]]) {
			assert.ok(graph.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind), `${nested} ${status} ${from} ${to}`);
		}
		const result = validateExport(oneScene(trace, ["operation", "read", "first", "test", "later-test"]), trace);
		assert.ok(result.failures.some((failure) => failure.reason === "reversed-causal-order" && failure.a === "first" && failure.b === "read"));
	}
});

test("only confirmed successful direct overwrites retire earlier possible writers", () => {
	const args = { file_path: "src/a.ts", content: "new" };
	const confirmed = { status: "ok" as const, ended_at: "2026-01-01T00:00:01Z" };
	const trace = makeTrace([
		toolStep("first", "Write", args, confirmed),
		toolStep("uncertain", "Write", args, { status: "error", ended_at: "2026-01-01T00:00:01Z" }),
		toolStep("replacement", "Write", args, { ...confirmed, started_at: "2026-01-01T00:00:01Z" }),
		toolStep("read", "Read", { file_path: "src/a.ts" }),
		toolStep("test", "Bash", { command: "pnpm test" }),
	]);
	const edges = buildCausalGraph(trace).edges.filter((edge) => edge.kind === "file-read" || edge.kind === "test-write");
	assert.deepEqual(edges.map(({ from, to }) => [from, to]), [["replacement", "read"], ["replacement", "test"]]);
});

test("confirmed overwrites retain overlapping and unordered writers for reads and tests", () => {
	const args = { file_path: "src/a.ts", content: "new" };
	for (const nested of [false, true]) for (const end of ["2026-01-01T00:00:10Z", undefined, "invalid"]) {
		const first = nested ? nestedStep("Write", args) : toolStep("first", "Write", args);
		first.step_id = "first";
		first.status = "ok";
		first.ended_at = end;
		const trace = makeTrace([
			first,
			toolStep("replacement", "Write", args, {
				status: "ok", started_at: "2026-01-01T00:00:01Z", ended_at: "2026-01-01T00:00:02Z",
			}),
			toolStep("read", "Read", { file_path: "src/a.ts" }, { started_at: "2026-01-01T00:00:11Z" }),
			toolStep("test", "Bash", { command: "pnpm test" }, { started_at: "2026-01-01T00:00:12Z" }),
		]);
		const edges = buildCausalGraph(trace).edges;
		for (const from of ["first", "replacement"]) for (const [to, kind] of [["read", "file-read"], ["test", "test-write"]]) {
			assert.ok(edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind), `${nested} ${end} ${from} ${to}`);
		}
		const result = validateExport(oneScene(trace, ["replacement", "read", "first", "test"]), trace);
		assert.ok(result.failures.some((failure) => failure.reason === "reversed-causal-order" && failure.a === "first" && failure.b === "read"));
	}
});

test("a direct patch retires earlier writers only when its own result confirms application", () => {
	for (const confirmed of [false, true]) {
		const patch = toolStep("patch", "apply_patch", { input: "*** Begin Patch\n*** Add File: src/a.ts\n+new\n*** End Patch" }, {
			status: "ok", started_at: "2026-01-01T00:00:01Z", ended_at: "2026-01-01T00:00:02Z",
		});
		if (confirmed) patch.attributes[ATTR.PATCH_CONFIRMED] = true;
		const graph = buildCausalGraph(makeTrace([
			toolStep("first", "Write", { file_path: "src/a.ts" }, { ended_at: "2026-01-01T00:00:01Z" }), patch,
			toolStep("read", "Read", { file_path: "src/a.ts" }),
		]));
		assert.equal(happensBefore(graph, "first", "read"), !confirmed);
		assert.ok(happensBefore(graph, "patch", "read"));
	}
});

test("the explicit file-tool and literal shell allowlist extracts direct and nested calls equally", () => {
	const cases: Array<[string, Record<string, unknown>, "read" | "write" | "test"]> = [
		["Read", { file_path: "src/a.ts" }, "read"],
		["Edit", { file_path: "src/a.ts", old_string: "old", new_string: "new" }, "write"],
		["MultiEdit", { file_path: "src/a.ts", edits: [] }, "write"],
		["Write", { file_path: "src/a.ts", content: "new" }, "write"],
		["NotebookEdit", { notebook_path: "src/a.ts", new_source: "new" }, "write"],
		["read_file", { path: "src/a.ts" }, "read"],
		["write_file", { path: "src/a.ts", content: "new" }, "write"],
		["Bash", { command: "cat src/a.ts" }, "read"],
		["exec_command", { cmd: "sed -n '1,4p' src/a.ts" }, "read"],
		["shell", { command: "head -n 4 src/a.ts" }, "read"],
		["exec_command", { cmd: "cat a.ts", workdir: "/work/project/src" }, "read"],
		["Bash", { command: "pnpm test" }, "test"],
	];
	for (const [name, args, kind] of cases) for (const step of [toolStep("operation", name, args), nestedStep(name, args)]) {
		assert.deepEqual(operationEvidence(step, "/work/project"), {
			operations: [
				...(["Edit", "MultiEdit", "NotebookEdit"].includes(name) ? [{ kind: "read", path: "src/a.ts" }] : []),
				kind === "test" ? { kind } : { kind, path: "src/a.ts" },
			], unresolved: false,
		}, `${name}: ${JSON.stringify(args)}`);
	}
});

test("content-dependent edits require the preceding writer in direct calls and completed exec cells", () => {
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["Edit", { file_path: "src/a.ts", old_string: "old", new_string: "new" }, "src/a.ts"],
		["MultiEdit", { file_path: "src/a.ts", edits: [{ old_string: "old", new_string: "new" }] }, "src/a.ts"],
		["NotebookEdit", { notebook_path: "src/a.ts", cell_id: "cell-a", new_source: "new" }, "src/a.ts"],
		["apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch" }, "src/a.ts"],
		["apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-old\n+new\n*** End Patch" }, "src/b.ts"],
	];
	for (const [name, args, readPath] of cases) for (const edit of [toolStep("operation", name, args), nestedStep(name, args)]) {
		const context = `${name}: ${JSON.stringify(args)} (${edit.attributes[ATTR.TOOL_NAME]})`;
		const trace = makeTrace([
			toolStep("write", "Write", { file_path: "src/a.ts", content: "old" }), edit,
			toolStep("read", "Read", { file_path: readPath }),
		]);
		assert.equal(validateExport(oneScene(trace, ["write", "operation", "read"]), trace).ok, true, context);
		assert.ok(buildCausalGraph(trace).edges.some((edge) => edge.from === "write" && edge.to === "operation" && edge.kind === "file-read"), context);
		const result = validateExport(oneScene(trace, ["operation", "write", "read"]), trace);
		assert.equal(result.ok, false, context);
		assert.ok(result.failures.some((failure) => failure.reason === "reversed-causal-order" && failure.a === "write" && failure.b === "operation"), context);
	}
});

test("non-allowlisted forms fail closed with a reason for direct and nested calls", () => {
	const commands = [
		"echo new > src/a.ts", "cat src/a.ts && echo done", "cat src/a.ts; pnpm test",
		"cat src/a.ts | head", "cat < src/a.ts", "cat src/a.ts src/b.ts", "cat -n src/a.ts",
		"cat src/*.ts", 'cat "$FILE"', "cat $(printf src/a.ts)",
		"sed -i 's/old/new/' src/a.ts", "sed -n '2p' src/a.ts", "sed -n '2,4p\" src/a.ts",
		"head src/a.ts", "head -c 4 src/a.ts", "tail -n 4 src/a.ts", "touch src/a.ts",
		"rm src/a.ts", "cp src/b.ts src/a.ts", "mv src/b.ts src/a.ts", "python mutate.py",
		"pnpm test > src/a.ts", "pnpm test | tail", "pwd; pnpm test", "if pnpm test",
		"cat src/a.ts\ncat src/b.ts", "git show HEAD:src/a.ts", "rg token src/a.ts", "pwd",
	];
	const cases: Array<[string, Record<string, unknown>]> = commands.flatMap((command) => [
		["Bash", { command }], ["exec_command", { cmd: command }], ["shell", { command }],
	] as Array<[string, Record<string, unknown>]>);
	cases.push(
		["unknown_tool", { path: "src/a.ts" }], ["edit_file", { path: "src/a.ts" }],
		["run_tests", {}], ["test", {}], ["Read", {}], ["Write", { file_path: 7 }],
		["Read", { file_path: "src/a.ts", path: "src/b.ts" }],
		["exec_command", { cmd: "cat src/a.ts", workdir: null }],
		["apply_patch", { input: "*** Begin Patch\n*** Update File: src/b.ts\n*** Unknown File: src/a.ts\n*** End Patch" }],
	);
	for (const [name, args] of cases) for (const step of [toolStep("operation", name, args), nestedStep(name, args)]) {
		const context = `${name} ${JSON.stringify(args)} (${step.attributes[ATTR.TOOL_NAME]})`;
		const evidence = operationEvidence(step);
		assert.equal(evidence.unresolved, true, context);
		assert.ok(evidence.reason, context);
		const trace = makeTrace([
			toolStep("write", "Write", { file_path: "src/other.ts" }), step,
			toolStep("read", "Read", { file_path: "src/a.ts" }),
			toolStep("test", "Bash", { command: "pnpm test" }),
		]);
		const faithful = oneScene(trace, ["write", "operation", "read", "test"]);
		const result = validateExport(faithful, trace);
		assert.equal(result.ok, true, context);
		assert.ok(result.warnings.some((warning) => warning.reason === "unresolved-operation"), context);
		const graph = buildCausalGraph(trace);
		for (const [from, to] of [["write", "operation"], ["operation", "read"], ["operation", "test"]]) {
			assert.ok(graph.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === "unresolved-write"), context);
		}
		for (const played of [["operation", "write", "read", "test"], ["write", "read", "test", "operation"], ["read", "write", "test"]]) {
			const reordered = validateExport(oneScene(trace, played), trace);
			assert.equal(reordered.ok, false, context);
			assert.ok(reordered.failures.some((failure) => failure.reason === "unresolved-operation"), context);
		}
		faithful.captions.push({ id: "crossing", sceneId: "scene-main", kind: "because", text: "The write preceded the test.", cause: "write", effect: "test" });
		assert.ok(validateExport(faithful, trace).failures.some((failure) => failure.reason === "unresolved-operation"), context);
	}
});

test("exec cells reject executable statements and expressions outside their literal calls", () => {
	const cells = [
		`${readCell}\nmutate();`,
		`${readCell}\nawait anotherTool({path: "src/a.ts"});`,
		'text(await tools.Read({file_path: "src/a.ts", extra: mutate()}));',
		'text(await tools.exec_command({cmd: "cat src/a.ts", env: dangerous()}));',
		'text(await tools.Read({file_path: "src/a.ts", extra: `${mutate()}`}));',
	];
	for (const cell of cells) {
		const trace = rollout([cell, readCell]);
		assert.equal(operationEvidence(trace.steps[0]!).unresolved, true, cell);
		assert.ok(validateExport(oneScene(trace, trace.steps.map((step) => step.step_id).reverse()), trace).failures.some((failure) => failure.reason === "unresolved-operation"), cell);
	}
	for (const cell of [
		`// Only data and a printed tool result.\n${readCell}`,
		'const result = await tools.exec_command({cmd: "cat src/a.ts", yield_time_ms: 1000}); text(result);',
		'let result = await tools.exec_command({cmd: "cat src/a.ts"}); text(String(result));',
	]) assert.equal(operationEvidence(rollout([cell]).steps[0]!).unresolved, false, cell);
});

test("delete-only and mixed patches mutate every target in direct and completed exec calls", () => {
	for (const mixed of [false, true]) {
		const input = `*** Begin Patch\n*** Delete File: src/a.ts\n${mixed ? "*** Update File: src/b.ts\n@@\n-old\n+new\n" : ""}*** End Patch`;
		for (const step of [toolStep("operation", "apply_patch", { input }), nestedStep("apply_patch", { input })]) {
			assert.deepEqual(operationEvidence(step), {
				operations: [{ kind: "write", path: "src/a.ts" }, ...(mixed ? [{ kind: "read", path: "src/b.ts" }, { kind: "write", path: "src/b.ts" }] : [])], unresolved: false,
			});
			const trace = makeTrace([step, toolStep("read", "Read", { file_path: "src/a.ts" }), toolStep("test", "Bash", { command: "pnpm test" })]);
			assert.equal(validateExport(oneScene(trace, ["operation", "read", "test"]), trace).ok, true);
			for (const played of [["read", "operation", "test"], ["test", "operation", "read"]]) {
				assert.ok(validateExport(oneScene(trace, played), trace).failures.some((failure) => failure.reason === "reversed-causal-order"));
			}
		}
	}
});

test("rename extraction mutates both the source and destination in direct and nested calls", () => {
	const input = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-old\n+new\n*** End Patch";
	for (const step of [toolStep("operation", "apply_patch", { input }), nestedStep("apply_patch", { input })]) {
		assert.deepEqual(operationEvidence(step), { operations: [{ kind: "read", path: "src/a.ts" }, { kind: "write", path: "src/a.ts" }, { kind: "write", path: "src/b.ts" }], unresolved: false });
	}
});

test("unresolved barriers retain all earlier writes even across tests and overwrites", () => {
	const trace = makeTrace([
		toolStep("first", "Write", { file_path: "src/a.ts" }),
		toolStep("second", "Edit", { file_path: "src/a.ts" }),
		toolStep("test", "Bash", { command: "pnpm test" }),
		toolStep("unknown", "Bash", { command: "echo new > src/a.ts" }),
		toolStep("later-test", "Bash", { command: "pnpm test" }),
		toolStep("later-read", "Read", { file_path: "src/a.ts" }),
	]);
	const graph = buildCausalGraph(trace);
	for (const from of ["first", "second"]) assert.ok(happensBefore(graph, from, "unknown"));
	for (const to of ["later-test", "later-read"]) assert.ok(happensBefore(graph, "unknown", to));
});

test("a parsed Claude result-event parent requires the tool before the response", () => {
	const trace = parseClaudeCodeTranscript([
		{ type: "user", uuid: "u", sessionId: "synthetic-run", cwd: "/work/project", message: { content: "Read the file." } },
		{ type: "assistant", uuid: "a", parentUuid: "u", message: { content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "src/a.ts" } }] } },
		{ type: "user", uuid: "result-event", parentUuid: "a", message: { content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "synthetic content" }] } },
		{ type: "assistant", uuid: "done", parentUuid: "result-event", message: { content: [{ type: "text", text: "Read completed." }] } },
	].map((event) => JSON.stringify(event)).join("\n"));
	assert.equal(trace.steps.length, 3);
	assert.deepEqual(trace.steps.find((step) => step.step_id === "toolu_read")!.attributes[ATTR.CLAUDE_RESULT_EVENT_UUIDS], ["result-event"]);
	const reversed = validateExport(oneScene(trace, ["a", "done", "toolu_read"]), trace);
	assert.equal(reversed.ok, false);
	assert.ok(reversed.failures.some((failure) => failure.reason === "reversed-causal-order"));
	const result = validateExport(oneScene(trace, trace.steps.map((step) => step.step_id)), trace);
	assert.equal(result.ok, true);
	assert.deepEqual(result.failures, []);
	assert.ok(result.warnings.every((warning) => warning.reason === "external-parent"));
	assert.deepEqual(buildCausalGraph(trace).edges, [
		{ from: "toolu_read", to: "done", kind: "parent", evidence: "result-event" },
	]);
	const toolOnly = validateExport(oneScene(trace, ["toolu_read"]), trace);
	assert.equal(toolOnly.ok, true);
});

test("parsed Claude result events retain every contributing tool and distinct result UUID", () => {
	const readResult = { type: "tool_result", tool_use_id: "toolu_read", content: "synthetic content" };
	const trace = parseClaudeCodeTranscript([
		{ type: "assistant", uuid: "a", message: { content: [
			{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "src/a.ts" } },
			{ type: "tool_use", id: "toolu_other", name: "Read", input: { file_path: "src/b.ts" } },
		] } },
		{ type: "user", uuid: "batch-result", message: { content: [readResult, readResult,
			{ type: "tool_result", tool_use_id: "toolu_other", content: "other synthetic content" },
		] } },
		{ type: "assistant", uuid: "batch-done", parentUuid: "batch-result", message: { content: "Files read." } },
		{ type: "user", uuid: "later-result", message: { content: [readResult] } },
		{ type: "assistant", uuid: "done", parentUuid: "later-result", message: { content: "Read completed." } },
	].map((event) => JSON.stringify(event)).join("\n"));
	assert.deepEqual(trace.steps.find((step) => step.step_id === "toolu_read")!.attributes[ATTR.CLAUDE_RESULT_EVENT_UUIDS], ["batch-result", "later-result"]);
	assert.deepEqual(trace.steps.find((step) => step.step_id === "toolu_other")!.attributes[ATTR.CLAUDE_RESULT_EVENT_UUIDS], ["batch-result"]);
	assert.deepEqual(buildCausalGraph(trace).edges, [
		{ from: "toolu_read", to: "batch-done", kind: "parent", evidence: "result-event" },
		{ from: "toolu_other", to: "batch-done", kind: "parent", evidence: "result-event" },
		{ from: "toolu_read", to: "done", kind: "parent", evidence: "result-event" },
	]);
	assert.equal(validateExport(oneScene(trace, trace.steps.map((step) => step.step_id)), trace).ok, true);
	for (const lateTool of ["toolu_read", "toolu_other"]) {
		const playback = trace.steps.map((step) => step.step_id).filter((id) => id !== lateTool);
		playback.push(lateTool);
		assert.ok(validateExport(oneScene(trace, playback), trace).failures.some((failure) => failure.reason === "reversed-causal-order"), lateTool);
	}
});

test("a Claude result event with a missing tool call blocks export", () => {
	for (const resultBlock of [
		{ type: "tool_result", tool_use_id: "toolu_missing", content: "Synthetic result." },
		{ type: "tool_result", content: "Synthetic result without an ID." },
	]) {
		const trace = parseClaudeCodeTranscript([
			{ type: "user", uuid: "result-event", message: { content: [
				{ type: "text", text: "Synthetic context alongside a result." }, resultBlock,
			] } },
			{ type: "assistant", uuid: "done", parentUuid: "result-event", message: { content: "Using the result." } },
		].map((event) => JSON.stringify(event)).join("\n"));
		assert.equal(trace.steps[0]!.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND], "unmatched-tool-result");
		const result = validateExport(oneScene(trace, ["done"]), trace);
		assert.equal(result.ok, false);
		assert.ok(result.failures.some((failure) => failure.reason === "dangling-parent" && failure.parent === "result-event"));
		assert.equal(result.warnings.some((warning) => warning.reason === "external-parent"), false);
	}
});

test("a partially matched Claude result batch keeps matched edges and blocks missing evidence", () => {
	const trace = parseClaudeCodeTranscript([
		{ type: "assistant", uuid: "a", message: { content: [
			{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/work/project/src/a.ts" } },
		] } },
		{ type: "user", uuid: "batch-result", message: { content: [
			{ type: "tool_result", tool_use_id: "toolu_read", content: "Synthetic file content." },
			{ type: "tool_result", tool_use_id: "toolu_missing", content: "Unmatched synthetic content." },
		] } },
		{ type: "assistant", uuid: "done", parentUuid: "batch-result", message: { content: "Using both results." } },
	].map((event) => JSON.stringify(event)).join("\n"));
	assert.equal(trace.steps.find((step) => step.step_id === "done")!.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND], "unmatched-tool-result");
	assert.deepEqual(buildCausalGraph(trace).edges, [
		{ from: "toolu_read", to: "done", kind: "parent", evidence: "result-event" },
	]);
	const faithful = validateExport(oneScene(trace, ["a", "toolu_read", "done"]), trace);
	assert.equal(faithful.ok, false);
	assert.ok(faithful.failures.some((failure) => failure.reason === "dangling-parent" && failure.parent === "batch-result"));
	assert.equal(faithful.warnings.some((warning) => warning.reason === "external-parent"), false);
	const reversed = validateExport(oneScene(trace, ["a", "done", "toolu_read"]), trace);
	assert.ok(reversed.failures.some((failure) => failure.reason === "reversed-causal-order"));
	assert.ok(reversed.failures.some((failure) => failure.reason === "dangling-parent"));
});

test("Claude result contributors resolve before their calls in input order", () => {
	const trace = parseClaudeCodeTranscript([
		{ type: "user", uuid: "result-event", timestamp: "2026-01-01T00:00:02Z", message: { content: [
			{ type: "tool_result", tool_use_id: "toolu_read", content: "Synthetic file content." },
		] } },
		{ type: "assistant", uuid: "done", parentUuid: "result-event", timestamp: "2026-01-01T00:00:03Z", message: { content: "Using the result." } },
		{ type: "assistant", uuid: "a", timestamp: "2026-01-01T00:00:01Z", message: { content: [
			{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/work/project/src/a.ts" } },
		] } },
	].map((event) => JSON.stringify(event)).join("\n"));
	assert.deepEqual(trace.steps.map((step) => step.step_id), ["a", "toolu_read", "done"]);
	const read = trace.steps.find((step) => step.step_id === "toolu_read")!;
	assert.deepEqual(read.attributes[ATTR.CLAUDE_RESULT_EVENT_UUIDS], ["result-event"]);
	assert.equal(read.ended_at, "2026-01-01T00:00:02Z");
	assert.equal(trace.steps.find((step) => step.step_id === "done")!.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND], undefined);
	assert.equal(validateExport(oneScene(trace, ["a", "toolu_read", "done"]), trace).ok, true);
	const reversed = validateExport(oneScene(trace, ["a", "done", "toolu_read"]), trace);
	assert.equal(reversed.ok, false);
	assert.ok(reversed.failures.some((failure) => failure.reason === "reversed-causal-order" && failure.a === "toolu_read" && failure.b === "done"));
});

test("parsed Agent spawn precedes every step of the first child tool event", () => {
	const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
	const main = [
		{ type: "assistant", uuid: "dispatch", timestamp: "2026-01-01T00:00:00Z", message: { content: [
			{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { subagent_type: "Explore", prompt: "Read the synthetic file." } },
		] } },
		{ type: "user", uuid: "agent-result", timestamp: "2026-01-01T00:00:05Z", parentUuid: "dispatch", toolUseResult: { agentId: "child" }, message: { content: [
			{ type: "tool_result", tool_use_id: "toolu_agent", content: "Done." },
		] } },
		{ type: "assistant", uuid: "continuation", timestamp: "2026-01-01T00:00:06Z", parentUuid: "agent-result", message: { content: "Using the result." } },
	];
	const sidechain = [
		{ type: "assistant", uuid: "child-start", timestamp: "2026-01-01T00:00:01Z", isSidechain: true, agentId: "child", message: { content: [
			{ type: "tool_use", id: "toolu_child_read", name: "Read", input: { file_path: "/work/project/src/a.ts" } },
		] } },
	];
	const trace = parseClaudeCodeTranscript(jsonl(main), [jsonl(sidechain)]);
	const child = trace.steps.filter((step) => step.subagent_id === "child");
	assert.deepEqual(child.map((step) => [step.step_id, step.kind]), [["child-start", "llm"], ["toolu_child_read", "tool_call"]]);
	const graph = buildCausalGraph(trace);
	assert.ok(graph.edges.some((edge) => edge.from === "toolu_agent" && edge.to === "toolu_child_read" && edge.kind === "spawn"));
	const playback = trace.steps.map((step) => step.step_id);
	assert.equal(validateExport(oneScene(trace, playback), trace).ok, true);
	const reordered = playback.filter((id) => id !== "toolu_child_read");
	reordered.splice(reordered.indexOf("toolu_agent"), 0, "toolu_child_read");
	const reversed = validateExport(oneScene(trace, reordered), trace);
	assert.ok(reversed.failures.some((failure) => failure.reason === "reversed-causal-order" && failure.a === "toolu_agent" && failure.b === "toolu_child_read"));
});

test("parsed synchronous Agent results link the sidechain endpoint to the parent continuation", () => {
	const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
	const main = [
		{ type: "assistant", uuid: "dispatch", timestamp: "2026-01-01T00:00:00Z", message: { content: [
			{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { subagent_type: "Explore", prompt: "Read the synthetic file." } },
		] } },
		{ type: "user", uuid: "agent-result", timestamp: "2026-01-01T00:00:05Z", parentUuid: "dispatch", toolUseResult: { agentId: "child" }, message: { content: [
			{ type: "tool_result", tool_use_id: "toolu_agent", content: "Synthetic inspection completed." },
		] } },
		{ type: "assistant", uuid: "continuation", timestamp: "2026-01-01T00:00:06Z", parentUuid: "agent-result", message: { content: [
			{ type: "text", text: "Using the inspection result." },
			{ type: "tool_use", id: "toolu_continue", name: "Read", input: { file_path: "/work/project/src/b.ts" } },
		] } },
	];
	const sidechain = [
		{ type: "assistant", uuid: "child-start", timestamp: "2026-01-01T00:00:01Z", isSidechain: true, agentId: "child", message: { content: "Inspecting." } },
		{ type: "assistant", uuid: "child-read", timestamp: "2026-01-01T00:00:02Z", parentUuid: "child-start", isSidechain: true, agentId: "child", message: { content: [
			{ type: "tool_use", id: "toolu_child_read", name: "Read", input: { file_path: "/work/project/src/a.ts" } },
		] } },
		{ type: "user", uuid: "child-result", timestamp: "2026-01-01T00:00:03Z", parentUuid: "child-read", isSidechain: true, agentId: "child", message: { content: [
			{ type: "tool_result", tool_use_id: "toolu_child_read", content: "Synthetic file content." },
		] } },
		{ type: "assistant", uuid: "child-done", timestamp: "2026-01-01T00:00:04Z", parentUuid: "child-result", isSidechain: true, agentId: "child", message: { content: "Inspection complete." } },
	];
	const trace = parseClaudeCodeTranscript(jsonl(main), [jsonl(sidechain)]);
	assert.deepEqual(trace.steps.find((step) => step.step_id === "toolu_agent")!.attributes[ATTR.CLAUDE_RESULT_EVENT_UUIDS], ["agent-result"]);
	assert.equal(trace.steps.find((step) => step.step_id === "continuation")!.parent_step_id, "agent-result");
	assert.equal(trace.steps.find((step) => step.step_id === "toolu_continue")!.parent_step_id, "agent-result");
	const graph = buildCausalGraph(trace);
	assert.deepEqual(graph.edges.filter((edge) => edge.kind === "consumer"), [
		{ from: "child-done", to: "continuation", kind: "consumer", evidence: "parent references Agent result-event" },
		{ from: "child-done", to: "toolu_continue", kind: "consumer", evidence: "parent references Agent result-event" },
	]);
	const playback = trace.steps.map((step) => step.step_id);
	assert.equal(validateExport(oneScene(trace, playback), trace).ok, true);
	const reordered = playback.filter((id) => id !== "continuation");
	reordered.splice(reordered.indexOf("child-done"), 0, "continuation");
	const reversed = validateExport(oneScene(trace, reordered), trace);
	assert.ok(reversed.failures.some((failure) => failure.reason === "reversed-causal-order" && failure.a === "child-done" && failure.b === "continuation"));
	const toolBeforeChild = playback.filter((id) => id !== "toolu_continue");
	toolBeforeChild.splice(toolBeforeChild.indexOf("child-done"), 0, "toolu_continue");
	const reversedTool = validateExport(oneScene(trace, toolBeforeChild), trace);
	assert.ok(reversedTool.failures.some((failure) => failure.reason === "reversed-causal-order" && failure.a === "child-done" && failure.b === "toolu_continue"));
	// A launch receipt followed by a continuation before the sidechain ends
	// does not establish consumption of the completed child result.
	const background = structuredClone(main);
	background[1]!.timestamp = "2026-01-01T00:00:01Z";
	background[2]!.timestamp = "2026-01-01T00:00:02Z";
	const backgroundTrace = parseClaudeCodeTranscript(jsonl(background), [jsonl(sidechain)]);
	assert.ok(buildCausalGraph(backgroundTrace).diagnostics.some((diagnostic) => diagnostic.reason === "unlinked-subagent-result"));
	assert.equal(buildCausalGraph(backgroundTrace).edges.some((edge) => edge.kind === "consumer"), false);
	// A result recorded later cannot make an unrelated earlier continuation
	// consume it, even when that continuation follows the child endpoint.
	const unlinked = structuredClone(main);
	unlinked[2]!.parentUuid = "dispatch";
	unlinked[1]!.timestamp = "2026-01-01T00:00:07Z";
	const unlinkedTrace = parseClaudeCodeTranscript(jsonl(unlinked), [jsonl(sidechain)]);
	const unlinkedResult = validateExport(oneScene(unlinkedTrace, unlinkedTrace.steps.map((step) => step.step_id)), unlinkedTrace);
	assert.equal(unlinkedResult.ok, true);
	assert.ok(unlinkedResult.warnings.some((warning) => warning.reason === "unlinked-subagent-result"));
});

test("Agent consumer edges and because captions require completed output after every child step ends", () => {
	const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
	const main = [
		{ type: "assistant", uuid: "dispatch", timestamp: "2026-01-01T00:00:00Z", message: { content: [
			{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { subagent_type: "Explore", run_in_background: true } },
		] } },
		{ type: "user", uuid: "agent-result", timestamp: "2026-01-01T00:00:01Z", toolUseResult: { agentId: "child" }, message: { content: [
			{ type: "tool_result", tool_use_id: "toolu_agent", content: "Async agent launched successfully." },
		] } },
		// The continuation follows the last child's start in source order, but
		// precedes its completion. Source adjacency cannot prove consumption.
		{ type: "assistant", uuid: "continuation", timestamp: "2026-01-01T00:00:03Z", parentUuid: "agent-result", message: { content: "Continuing." } },
	] satisfies [unknown, unknown, unknown];
	const sidechain = [
		{ type: "assistant", uuid: "child-read", timestamp: "2026-01-01T00:00:02Z", isSidechain: true, agentId: "child", message: { content: [
			{ type: "tool_use", id: "toolu_child_read", name: "Read", input: { file_path: "/work/project/src/a.ts" } },
		] } },
		{ type: "user", uuid: "child-result", timestamp: "2026-01-01T00:00:10Z", isSidechain: true, agentId: "child", message: { content: [
			{ type: "tool_result", tool_use_id: "toolu_child_read", content: "Synthetic file content." },
		] } },
	];
	const launched = parseClaudeCodeTranscript(jsonl(main), [jsonl(sidechain)]);
	const completedMain = structuredClone(main);
	completedMain[0]!.message.content![0]!.input!.run_in_background = false;
	completedMain[1]!.timestamp = "2026-01-01T00:00:10Z";
	completedMain[1]!.message.content![0]!.content = "Synthetic inspection completed.";
	completedMain[2]!.timestamp = "2026-01-01T00:00:11Z";
	const completed = parseClaudeCodeTranscript(jsonl(completedMain), [jsonl(sidechain)]);
	const cases: { name: string; trace: Trace; linked: boolean }[] = [
		{ name: "async launch before child completes", trace: launched, linked: false },
		{ name: "synchronous result at child completion", trace: completed, linked: true },
	];
	const mutations: [string, (trace: Trace) => void][] = [
		["launch receipt after child completion", (trace) => { trace.steps.find((step) => step.step_id === "toolu_agent")!.attributes[ATTR.CLAUDE_AGENT_RESULT_KIND] = "launched"; }],
		["unknown result kind", (trace) => { trace.steps.find((step) => step.step_id === "toolu_agent")!.attributes[ATTR.CLAUDE_AGENT_RESULT_KIND] = "unknown"; }],
		["missing result kind", (trace) => { delete trace.steps.find((step) => step.step_id === "toolu_agent")!.attributes[ATTR.CLAUDE_AGENT_RESULT_KIND]; }],
		["result before child completion", (trace) => { trace.steps.find((step) => step.step_id === "toolu_agent")!.ended_at = "2026-01-01T00:00:09Z"; }],
		["missing result timestamp", (trace) => { trace.steps.find((step) => step.step_id === "toolu_agent")!.ended_at = null; }],
		["invalid result timestamp", (trace) => { trace.steps.find((step) => step.step_id === "toolu_agent")!.ended_at = "invalid"; }],
		["missing child end", (trace) => { trace.steps.find((step) => step.step_id === "toolu_child_read")!.ended_at = null; }],
		["invalid child end", (trace) => { trace.steps.find((step) => step.step_id === "toolu_child_read")!.ended_at = "invalid"; }],
		["earlier child step still running", (trace) => { trace.steps.find((step) => step.step_id === "child-read")!.ended_at = "2026-01-01T00:00:12Z"; }],
		["earlier child step missing end", (trace) => { trace.steps.find((step) => step.step_id === "child-read")!.ended_at = null; }],
	];
	for (const [name, mutate] of mutations) {
		const trace = structuredClone(completed);
		mutate(trace);
		cases.push({ name, trace, linked: false });
	}
	for (const { name, trace, linked } of cases) {
		const graph = buildCausalGraph(trace);
		assert.equal(graph.edges.some((edge) => edge.kind === "consumer"), linked, name);
		const manifest = oneScene(trace, trace.steps.map((step) => step.step_id));
		const withoutClaim = validateExport(manifest, trace);
		assert.equal(withoutClaim.ok, true, name);
		assert.equal(withoutClaim.warnings.some((warning) => warning.reason === "unlinked-subagent-result"), !linked, name);
		manifest.captions.push({ id: "child-cause", sceneId: "scene-main", kind: "because", text: "The child read caused the continuation.", cause: "toolu_child_read", effect: "continuation" });
		const withClaim = validateExport(manifest, trace);
		assert.equal(withClaim.ok, linked, name);
		assert.equal(withClaim.failures.some((failure) => failure.reason === "caption-unsupported-claim"), !linked, name);
	}
});

test("absent parents matching the trace's tool-use ID family remain dangling", () => {
	const trace = makeTrace([toolStep("toolu_read", "Read", { file_path: "src/a.ts" }, { parent_step_id: "toolu_missing" })]);
	assert.ok(validateExport(oneScene(trace, ["toolu_read"]), trace).failures.some((failure) => failure.reason === "dangling-parent"));
});

test("missing parents fail closed without step metadata regardless of identifier family", () => {
	for (const parent of ["arbitrary-missing", "toolu_missing", "call_missing", "step-missing"]) {
		for (const metadata of [undefined, "assistant", true]) {
			const step = toolStep("call_edit", "Edit", { file_path: "src/a.ts" }, { parent_step_id: parent });
			if (metadata !== undefined) step.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND] = metadata;
			const trace = makeTrace([step]);
			// Legacy trace-wide IDs alone do not establish the required classification.
			trace.external_parent_ids = [parent];
			const result = validateExport(oneScene(trace, ["call_edit"]), trace);
			assert.equal(result.ok, false, parent);
			assert.ok(result.failures.some((failure) => failure.reason === "dangling-parent" && failure.parent === parent), parent);
			assert.ok(!result.warnings.some((warning) => warning.reason === "external-parent"), parent);
		}
	}
});

test("parser-known omitted UUID parents are external while missing UUID steps remain dangling", () => {
	const user = "00000000-0000-0000-0000-000000000001";
	const assistant = "00000000-0000-0000-0000-000000000002";
	const missing = "00000000-0000-0000-0000-000000000003";
	const trace = parseClaudeCodeTranscript([
		{ type: "user", uuid: user, message: { content: "Read the file." } },
		{ type: "assistant", uuid: assistant, parentUuid: user, message: { content: "Reading." } },
	].map((event) => JSON.stringify(event)).join("\n"));
	assert.deepEqual(trace.external_parent_ids, [user]);
	assert.equal(trace.steps[0]!.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND], "user");
	const faithful = oneScene(trace, [assistant]);
	assert.equal(validateExport(faithful, trace).ok, true);
	const withoutMetadata = structuredClone(trace);
	delete withoutMetadata.steps[0]!.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND];
	assert.ok(validateExport(faithful, withoutMetadata).failures.some((failure) => failure.reason === "source-mismatch"));
	assert.ok(validateExport(oneScene(withoutMetadata, [assistant]), withoutMetadata).failures.some((failure) => failure.reason === "dangling-parent"));
	trace.steps[0]!.parent_step_id = missing;
	delete trace.steps[0]!.attributes[ATTR.CLAUDE_PARENT_EVENT_KIND];
	assert.ok(validateExport(oneScene(trace, [assistant]), trace).failures.some((failure) => failure.reason === "dangling-parent"));
});

test("a 2,000-step valid chain validates under 750ms with at most one traversal per exported source", () => {
	const count = 2_000;
	const trace = makeTrace(Array.from({ length: count }, (_, index) => makeStep(`s${index}`, index ? { caused_by: `s${index - 1}` } : {})));
	const manifest = oneScene(trace, trace.steps.map((step) => step.step_id));
	const start = performance.now();
	assert.equal(validateExport(manifest, trace).ok, true);
	const elapsed = performance.now() - start;
	assert.ok(elapsed < 750, `validation took ${elapsed.toFixed(1)}ms`);
	const graph = buildCausalGraph(trace);
	const resolved = resolveManifest(manifest, trace);
	assert.ok(!("errors" in resolved));
	const get = graph.adjacency.get.bind(graph.adjacency);
	let visits = 0;
	graph.adjacency.get = (id) => { visits++; return get(id); };
	assert.deepEqual(checkOrder(resolved, graph), []);
	assert.ok(visits <= count * (count + 1) / 2, `too many adjacency visits: ${visits}`);
	console.log(`2,000-step export validation: ${elapsed.toFixed(1)}ms; adjacency visits: ${visits}`);
});
