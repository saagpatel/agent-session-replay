import test from "node:test";
import assert from "node:assert/strict";
import { ATTR, type Trace } from "../types.ts";
import { parseClaudeCodeTranscript } from "../parsers/claude-code.ts";
import { buildCausalGraph } from "./causal.ts";
import { validateExport } from "./index.ts";
import { traceDigest, type Manifest } from "./manifest.ts";

const timestamp = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, "0")}Z`;
const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

function resumedEvents() {
	const main = [1, 2].flatMap((invocation) => {
		const start = (invocation - 1) * 10;
		return [
			{ type: "assistant", uuid: `dispatch-${invocation}`, timestamp: timestamp(start), message: { content: [
				{ type: "tool_use", id: `spawn-${invocation}`, name: "Agent", input: {
					subagent_type: "Explore", ...(invocation === 2 ? { resume: "child" } : {}),
				} },
			] } },
			{ type: "user", uuid: `result-${invocation}`, timestamp: timestamp(start + 4), toolUseResult: { agentId: "child" }, message: { content: [
				{ type: "tool_result", tool_use_id: `spawn-${invocation}`, content: "Synthetic inspection completed." },
			] } },
			{ type: "assistant", uuid: `consumer-${invocation}`, timestamp: timestamp(start + 5), parentUuid: `result-${invocation}`, message: { content: [
				{ type: "tool_use", id: `follow-${invocation}`, name: "Read", input: { file_path: `/work/project/summary-${invocation}.ts` } },
			] } },
		];
	});
	const child = [1, 2].flatMap((invocation) => {
		const start = (invocation - 1) * 10;
		return [
			{ type: "assistant", uuid: `child-${invocation}`, timestamp: timestamp(start + 1), isSidechain: true, agentId: "child", message: { content: [
				{ type: "tool_use", id: `read-${invocation}-a`, name: "Read", input: { file_path: `/work/project/input-${invocation}-a.ts` } },
				{ type: "tool_use", id: `read-${invocation}-b`, name: "Read", input: { file_path: `/work/project/input-${invocation}-b.ts` } },
			] } },
			{ type: "user", uuid: `child-result-${invocation}`, timestamp: timestamp(start + 2), isSidechain: true, agentId: "child", message: { content: [
				{ type: "tool_result", tool_use_id: `read-${invocation}-a`, content: "Synthetic file A." },
				{ type: "tool_result", tool_use_id: `read-${invocation}-b`, content: "Synthetic file B." },
			] } },
		];
	});
	return { main, child };
}

function parse(events = resumedEvents()): Trace {
	return parseClaudeCodeTranscript(jsonl(events.main), [jsonl(events.child)]);
}

function playback(trace: Trace, ids = trace.steps.map((step) => step.step_id)): Manifest {
	return {
		version: 1,
		source: { runId: trace.run.run_id, stepCount: trace.steps.length, digest: traceDigest(trace) },
		title: "Synthetic resumed agent replay",
		scenes: [{ id: "main", range: { from: trace.steps[0]!.step_id, to: trace.steps.at(-1)!.step_id }, steps: ids }],
		captions: [],
	};
}

test("parsed resumed Agent invocations constrain only their own child segment", () => {
	const trace = parse();
	const graph = buildCausalGraph(trace);
	assert.deepEqual(graph.diagnostics, []);
	assert.equal(validateExport(playback(trace), trace).ok, true);
	for (const invocation of [1, 2]) {
		const own = [`child-${invocation}`, `read-${invocation}-a`, `read-${invocation}-b`];
		assert.deepEqual(graph.edges.filter((edge) => edge.kind === "spawn" && edge.from === `spawn-${invocation}`)
			.map((edge) => edge.to), own);
		for (const consumer of [`consumer-${invocation}`, `follow-${invocation}`]) {
			assert.deepEqual(graph.edges.filter((edge) => edge.kind === "consumer" && edge.to === consumer)
				.map((edge) => edge.from), own);
			for (const cause of own) {
				const manifest = playback(trace);
				manifest.captions.push({ id: "claim", sceneId: "main", kind: "because", text: "The child inspection supports this continuation.", cause, effect: consumer });
				assert.equal(validateExport(manifest, trace).ok, true);
			}
		}
	}
	const ids = trace.steps.map((step) => step.step_id);
	const earlyResume = ids.filter((id) => id !== "dispatch-2" && id !== "spawn-2");
	earlyResume.splice(earlyResume.indexOf("child-1"), 0, "dispatch-2", "spawn-2");
	assert.equal(validateExport(playback(trace, earlyResume), trace).ok, true);
	for (const child of ["child-2", "read-2-a", "read-2-b"]) {
		const reversed = ids.filter((id) => id !== child);
		reversed.splice(reversed.indexOf("spawn-2"), 0, child);
		assert.ok(validateExport(playback(trace, reversed), trace).failures.some((failure) =>
			failure.reason === "reversed-causal-order" && failure.a === "spawn-2" && failure.b === child));
	}
	// Both parallel reads, rather than only the last in source order, constrain
	// each result's consumers without depending on the other invocation's work.
	for (const invocation of [1, 2]) for (const suffix of ["a", "b"]) {
		const child = `read-${invocation}-${suffix}`;
		const reordered = ids.filter((id) => id !== child);
		reordered.splice(reordered.indexOf(`consumer-${invocation}`) + 1, 0, child);
		assert.ok(validateExport(playback(trace, reordered), trace).failures.some((failure) =>
			failure.reason === "reversed-causal-order" && failure.a === child && failure.b === `consumer-${invocation}`));
	}
});

test("ambiguous child invocation membership warns and cannot support because captions", () => {
	const cases: [string, (trace: Trace) => void][] = [
		["missing child start", (trace) => { trace.steps.find((step) => step.step_id === "read-1-a")!.started_at = ""; }],
		["invalid child start", (trace) => { trace.steps.find((step) => step.step_id === "read-1-a")!.started_at = "invalid"; }],
		["before first invocation", (trace) => { trace.steps.find((step) => step.step_id === "spawn-1")!.started_at = timestamp(2); }],
		["between result and resume", (trace) => { trace.steps.find((step) => step.step_id === "spawn-1")!.ended_at = timestamp(0); }],
		["crosses resume boundary", (trace) => { trace.steps.find((step) => step.step_id === "read-1-a")!.ended_at = timestamp(11); }],
		["tied invocation starts", (trace) => { trace.steps.find((step) => step.step_id === "spawn-2")!.started_at = timestamp(0); }],
		["missing invocation start", (trace) => { trace.steps.find((step) => step.step_id === "spawn-2")!.started_at = ""; }],
		["missing result time", (trace) => { trace.steps.find((step) => step.step_id === "spawn-1")!.ended_at = null; }],
	];
	for (const [name, mutate] of cases) {
		const trace = parse();
		mutate(trace);
		const graph = buildCausalGraph(trace);
		assert.ok(graph.diagnostics.some((diagnostic) => diagnostic.reason === "ambiguous-subagent-invocation" && diagnostic.step === "read-1-a"), name);
		assert.equal(graph.edges.some((edge) => (edge.kind === "spawn" && edge.to === "read-1-a") ||
			(edge.kind === "consumer" && edge.from === "read-1-a")), false, name);
		const manifest = playback(trace);
		const result = validateExport(manifest, trace);
		assert.equal(result.ok, true, name);
		assert.ok(result.warnings.some((warning) => warning.reason === "ambiguous-subagent-invocation"), name);
		// An independent explicit parent edge must not rescue a claim relying on
		// a child step whose invocation cannot be established.
		trace.steps.find((step) => step.step_id === "consumer-1")!.caused_by = "read-1-a";
		const claim = playback(trace);
		claim.captions.push({ id: "claim", sceneId: "main", kind: "because", text: "The child inspection supports this continuation.", cause: "read-1-a", effect: "consumer-1" });
		assert.ok(validateExport(claim, trace).failures.some((failure) => failure.reason === "caption-unsupported-claim"), name);
	}
});

test("an incomplete invocation does not erase the other invocation's consumer links", () => {
	for (const incomplete of [1, 2]) {
		const trace = parse();
		trace.steps.find((step) => step.step_id === `read-${incomplete}-a`)!.ended_at = null;
		const graph = buildCausalGraph(trace);
		for (const invocation of [1, 2]) {
			assert.equal(graph.edges.some((edge) => edge.kind === "consumer" && edge.to === `consumer-${invocation}`),
				invocation !== incomplete);
		}
	}
});

test("invocation intervals include their start and result, and exclude the next start", () => {
	const trace = parse();
	trace.steps.find((step) => step.step_id === "read-1-a")!.started_at = timestamp(0);
	trace.steps.find((step) => step.step_id === "read-1-b")!.started_at = timestamp(4);
	trace.steps.find((step) => step.step_id === "read-1-b")!.ended_at = timestamp(4);
	trace.steps.find((step) => step.step_id === "read-2-a")!.started_at = timestamp(10);
	const graph = buildCausalGraph(trace);
	for (const [from, to] of [["spawn-1", "read-1-a"], ["spawn-1", "read-1-b"], ["spawn-2", "read-2-a"]]) {
		assert.ok(graph.edges.some((edge) => edge.kind === "spawn" && edge.from === from && edge.to === to));
	}
	assert.equal(graph.edges.some((edge) => edge.kind === "spawn" && edge.from === "spawn-1" && edge.to === "read-2-a"), false);
	assert.deepEqual(graph.diagnostics, []);
});

test("parsed missing timestamps retain fallback values without proving invocation membership", () => {
	for (const target of ["child", "invocation"] as const) {
		const events = resumedEvents();
		const event = target === "child" ? events.child[0]! : events.main[3]!;
		Reflect.deleteProperty(event, "timestamp");
		const trace = parse(events);
		const id = target === "child" ? "read-1-a" : "spawn-2";
		const step = trace.steps.find((step) => step.step_id === id)!;
		assert.equal(step.attributes[ATTR.CLAUDE_TIMESTAMP_INFERRED], true);
		assert.equal(step.started_at, timestamp(target === "child" ? 15 : 5));
		const result = validateExport(playback(trace), trace);
		assert.ok(result.warnings.some((warning) => warning.reason === "ambiguous-subagent-invocation" && warning.step === "read-1-a"));
	}
});
