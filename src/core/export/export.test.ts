import test from "node:test";
import assert from "node:assert/strict";
import { ATTR, type Step, type Trace } from "../types.ts";
import { buildCausalGraph, happensBefore } from "./causal.ts";
import { parseManifest, resolveManifest, traceDigest, type Manifest } from "./manifest.ts";
import { validateExport } from "./index.ts";

const step = (id: string, extra: Partial<Step> = {}): Step => ({ step_id: id, kind: "tool_call", started_at: "2026-01-01T00:00:00Z", attributes: {}, ...extra });
const tool = (id: string, name: string, path?: string, extra: Partial<Step> = {}) => step(id, { attributes: { [ATTR.TOOL_NAME]: name, [ATTR.TOOL_ARGS]: path ? { file_path: path } : {} }, ...extra });
const trace: Trace = { plumbline_version: "1", run: { run_id: "synthetic", harness: { name: "fixture" }, started_at: "2026-01-01T00:00:00Z" }, steps: [
	step("spawn-a", { kind: "agent", attributes: { [ATTR.AGENT_SPAWNS]: "a" } }),
	step("spawn-b", { kind: "agent", attributes: { [ATTR.AGENT_SPAWNS]: "b" } }),
	tool("write", "Write", "/work/a", { subagent_id: "a" }),
	step("parallel-a", { subagent_id: "b" }),
	step("parallel-b", { subagent_id: "b" }),
	tool("read", "Read", "/work/a", { subagent_id: "a" }),
	tool("test", "test", undefined, { caused_by: "read" }),
] };
const manifest = (ids: string[]): Manifest => ({ version: 1, source: { runId: trace.run.run_id, stepCount: trace.steps.length, digest: traceDigest(trace) }, title: "Example", scenes: [{ id: "scene", range: { from: "spawn-a", to: "test" }, steps: ids }], captions: [] });
test("manifest validates and resolves ranges and source identity", () => {
	const m = manifest(["write", "test"]); const parsed = parseManifest(JSON.stringify(m));
	assert.ok(!("errors" in parsed)); const resolved = resolveManifest(parsed, trace);
	assert.ok(!("errors" in resolved)); assert.deepEqual(resolved.ranges, [{ sceneId: "scene", from: 0, to: 6 }]);
	assert.ok("errors" in resolveManifest({ ...m, source: { ...m.source, digest: "wrong" } }, trace));
	assert.ok("errors" in parseManifest({ ...m, extra: true }));
});
test("causal evidence spans interleaved sidechains while parallel calls remain concurrent", () => {
	const g = buildCausalGraph(trace);
	assert.ok(happensBefore(g, "spawn-a", "test")); assert.ok(happensBefore(g, "spawn-b", "parallel-a"));
	assert.equal(happensBefore(g, "parallel-a", "parallel-b"), false); assert.equal(happensBefore(g, "parallel-b", "parallel-a"), false);
	assert.deepEqual(g.diagnostics, []);
});
test("shortening and concurrent swaps pass, reversed causal order fails", () => {
	assert.equal(validateExport(manifest(["parallel-b", "parallel-a", "write", "test"]), trace).ok, true);
	assert.ok(validateExport(manifest(["test", "write"]), trace).failures.some(f => f.reason === "reversed-causal-order"));
});
test("captions detect absent references, dropped prerequisites and reversal", () => {
	const absent = manifest(["test"]); absent.captions.push({ id: "c", sceneId: "scene", kind: "shows", text: "Shows write", refs: ["write"] });
	assert.ok(validateExport(absent, trace).failures.some(f => f.reason === "caption-ref-absent"));
	const dropped = manifest(["read", "test"]); dropped.captions.push({ id: "c", sceneId: "scene", kind: "because", text: "Read causes test", cause: "read", effect: "test" });
	assert.ok(validateExport(dropped, trace).failures.some(f => f.reason === "dropped-prerequisite"));
	const reversed = manifest(["test", "read", "write"]); reversed.captions.push({ id: "c", sceneId: "scene", kind: "because", text: "Read causes test", cause: "read", effect: "test" });
	assert.ok(validateExport(reversed, trace).failures.some(f => f.reason === "caption-reversed"));
});
