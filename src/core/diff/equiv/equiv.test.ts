import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTR, type Step, type Trace } from "../../types.ts";
import { parseClaudeCodeEvents } from "../../parsers/claude-code.ts";
import { parseCodexEvents } from "../../parsers/codex.ts";
import { ccEvents, codexEvents, toJsonl } from "../fixtures.ts";
import { normalizeTrace, sourceNormalizationTruncated } from "../normalize.ts";
import { diffRuns, diffRunsEquivalent } from "../run-diff.ts";
import type { DiffAction, DiffStatus } from "../types.ts";
import { alignEquivalent } from "./align.ts";
import { expand, expandAll } from "./expand.ts";
import { normalizeEquivalent } from "./normalize.ts";
import { canCommute, RULES } from "./rules.ts";
import type { CanonicalEvent } from "./types.ts";

type Tool = [string, Record<string, unknown>, DiffStatus?];
const cases: Trace[] = [];
function trace(tools: Tool[]): Trace {
	const result: Trace = {
		plumbline_version: "1",
		run: {
			run_id: "synthetic",
			harness: { name: "claude-code" },
			started_at: "2026-10-01T00:00:00Z",
			workspace: { cwd: "/work/equiv" },
		},
		steps: tools.map(([name, args, status = "ok"], i): Step => ({
			step_id: `tool-${i}`,
			kind: "tool_call",
			started_at: "2026-10-01T00:00:00Z",
			ended_at: status === "unknown" ? undefined : "2026-10-01T00:00:01Z",
			status: status === "unknown" ? undefined : status,
			attributes: {
				[ATTR.TOOL_NAME]: name,
				[ATTR.TOOL_ARGS]: args,
			},
		})),
	};
	cases.push(result);
	return result;
}
const read = (start: number, limit: number, file = "a.ts", status: DiffStatus = "ok"): Tool => ["Read", { file_path: `/work/equiv/${file}`, offset: start, limit }, status];
const edit = (old: string, next: string, file = "a.ts", status: DiffStatus = "ok"): Tool => ["Edit", { file_path: `/work/equiv/${file}`, old_string: old, new_string: next }, status];
const shell = (command: string): Tool => ["Bash", { command }];
const grep = (pattern = "token", extra = {}): Tool => ["Grep", { pattern, path: "/work/equiv/src", ...extra }];
function normalized(t: Trace) {
	return normalizeEquivalent(normalizeTrace(t), new Map(t.steps.map((s) => [s.step_id, s])), t.run.workspace?.cwd);
}
const signatures = (t: Trace) => normalized(t).events.map((e) => e.signature);

test("rules are named, documented, and retain every original member", () => {
	assert.deepEqual(RULES.map((r) => r.id), ["read-coalesce", "search-dedupe", "edit-batch"]);
	assert.ok(RULES.every((r) => r.description && r.example));
});

test("three adjacent reads equal a bulk read, also across shell/Read tools", () => {
	const small = trace([read(1, 10), read(11, 10), read(21, 10)]);
	const bulk = trace([read(1, 30)]);
	assert.deepEqual(signatures(small), signatures(bulk));
	assert.equal(alignEquivalent(small, bulk).equivalent, true);
	assert.equal(alignEquivalent(small, trace([shell("sed -n '1,30p' a.ts")])).equivalent, true);
	assert.equal(alignEquivalent(trace([read(1, 30)]), trace([shell("head -n 30 a.ts")])).equivalent, true);
	assert.equal(diffRunsEquivalent(small, bulk).equivalent, true);
	assert.ok(diffRuns(small, bulk).rows.some((r) => r.relation !== "same"));
});

test("only consecutive successful observations sort for comparison", () => {
	const a = read(1, 5, "a.ts");
	const b = read(1, 5, "b.ts");
	const left = trace([b, a]);
	const right = trace([a, b]);
	const result = alignEquivalent(left, right);
	assert.equal(result.equivalent, true);
	assert.deepEqual(expandAll(result.left), normalizeTrace(left));
	assert.equal(alignEquivalent(trace([b, edit("x", "y"), a]), trace([a, edit("x", "y"), b])).equivalent, false);
	const failed = read(1, 5, "b.ts", "error");
	const failedResult = alignEquivalent(trace([failed, a]), trace([a, failed]));
	assert.equal(failedResult.equivalent, false);
	assert.equal(failedResult.rows[0]?.left?.status, "error");
	assert.equal(normalized(trace([a, failed, a])).events.length, 3);
});

test("overlaps, interleaved files, and bridging ranges keep first-member position", () => {
	const t = trace([read(1, 5), read(1, 2, "b.ts"), read(9, 4), grep(), read(5, 5)]);
	const n = normalized(t);
	assert.deepEqual(n.events[0]?.range, { start: 1, end: 12 });
	assert.deepEqual(n.events[0]?.members, [0, 2, 4]);
	assert.deepEqual(n.events.map((e) => e.members), [[0, 2, 4], [1], [3]]);
	assert.equal(n.events[0]?.rule, "read-coalesce");
	assert.equal(normalized(trace([read(1, 3), read(5, 3)])).events.length, 2);
});

test("read enrichment distinguishes ranges and preserves unknown-range identity", () => {
	assert.notDeepEqual(signatures(trace([read(1, 10)])), signatures(trace([read(11, 10)])));
	const unknown: Tool = ["Read", { file_path: "/work/equiv/a.ts" }];
	const n = normalized(trace([unknown, unknown]));
	assert.equal(n.events.length, 1);
	assert.equal(n.events[0]?.range, null);
	assert.equal(alignEquivalent(trace([unknown]), trace([read(1, 10)])).equivalent, false);
	assert.equal(alignEquivalent(trace([unknown]), trace([shell("cat a.ts")])).equivalent, false);
	assert.equal(normalized(trace([shell("cat a.ts"), shell("cat a.ts")])).events.length, 1);
	for (const extra of [{ offset: 0, limit: 10 }, { offset: 1, limit: -1 }, { offset: 2 }, { offset: 1, limit: 10, pages: "1" }]) {
		const t = trace([["Read", { file_path: "/work/equiv/a.ts", ...extra }]]);
		assert.equal(normalized(t).events[0]?.range, null);
		assert.equal(alignEquivalent(t, trace([read(1, 10)])).equivalent, false);
	}
});

test("whole-file and unknown-range reads use workspace-relative keys across worktrees", () => {
	for (const name of ["Read", "read_file"]) {
		for (const pathField of name === "Read" ? ["file_path"] : ["path", "file_path"]) {
			for (const options of [{}, { offset: 2 }]) {
				const left = trace([[name, { [pathField]: "/work/left/a.ts", ...options }]]);
				const right = trace([[name, { [pathField]: "/work/right/a.ts", ...options }]]);
				left.run.workspace = { cwd: "/work/left" };
				right.run.workspace = { cwd: "/work/right" };
				assert.equal(alignEquivalent(left, right).equivalent, true);
				const other = trace([[name, { [pathField]: "/work/right/b.ts", ...options }]]);
				other.run.workspace = right.run.workspace;
				assert.equal(alignEquivalent(left, other).equivalent, false);
			}
		}
	}
	assert.equal(alignEquivalent(trace([["Read", { file_path: "/work/equiv/a.ts" }]]),
		trace([["Read", { file_path: "/work/equiv/a.ts", offset: 2 }]])).equivalent, false);
});

test("800 distinct file reads and a second pass compare without restarting pair scans", () => {
	const pass = Array.from({ length: 800 }, (_, i) => read(1, 5, `file-${i}.ts`));
	const t = trace([...pass, ...pass]);
	const started = performance.now();
	const result = alignEquivalent(t, t);
	const elapsed = performance.now() - started;
	assert.equal(result.equivalent, true);
	assert.equal(result.left.events.length, 800);
	assert.ok(result.left.events.every((event, i) => event.members[0] === i && event.members[1] === i + 800));
	assert.ok(elapsed < 15000, `hang guard: comparison took ${elapsed.toFixed(1)} ms`);
});

test("5,000 disjoint ranges exhaust the normalization budget and preserve every member", () => {
	const t = trace(Array.from({ length: 5000 }, (_, i) => read(i * 3 + 1, 1)));
	const started = performance.now();
	const result = alignEquivalent(t, t);
	const elapsed = performance.now() - started;
	assert.equal(result.incomplete, true);
	assert.equal(result.equivalent, false);
	assert.ok(result.incompleteReasons.includes("normalization-budget"));
	assert.ok(result.left.incompleteReasons.includes("normalization-budget"));
	assert.ok(result.right.incompleteReasons.includes("normalization-budget"));
	assert.deepEqual(expandAll(result.left), normalizeTrace(t));
	assert.equal(result.left.events.length, 5000);
	assert.ok(elapsed < 15000, `hang guard: budgeted comparison took ${elapsed.toFixed(1)} ms`);
});

test("budget exhaustion after partial coalescing retains members and cannot prove equivalence", () => {
	const t = trace(Array.from({ length: 5000 }, () => read(1, 5)));
	const result = alignEquivalent(t, t);
	assert.deepEqual(result.incompleteReasons, ["normalization-budget"]);
	assert.equal(result.equivalent, false);
	assert.deepEqual(result.truncated, { left: 0, right: 0 });
	assert.ok(result.left.events.length < 5000);
	assert.ok(result.left.events.length > 1);
	assert.deepEqual(expandAll(result.left), normalizeTrace(t));
});

test("search dedupe uses query, path, options, and no intervening mutation", () => {
	const a = trace([grep(), read(1, 5), grep(), grep()]);
	const b = trace([grep(), read(1, 5)]);
	assert.equal(alignEquivalent(a, b).equivalent, true);
	assert.equal(normalized(a).events[0]?.rule, "search-dedupe");
	for (const other of [grep("other"), grep("token", { path: "/work/equiv/test" }), grep("token", { "-i": true })]) {
		assert.equal(alignEquivalent(trace([grep()]), trace([other])).equivalent, false);
	}
	assert.equal(normalized(trace([grep(), edit("a", "b", "other.ts"), grep()])).events.length, 3);
	const unknown: Tool = ["Grep", { path: "/work/equiv/src" }];
	assert.equal(alignEquivalent(trace([unknown]), trace([grep()])).equivalent, false);
	assert.equal(normalized(trace([unknown, unknown])).events.length, 2);
	assert.equal(alignEquivalent(trace([shell("rg token src && rg token src")]), trace([shell("rg token src")])).incomplete, true);
	assert.equal(alignEquivalent(trace([shell("rg token src")]), trace([shell("rg other src")])).equivalent, false);
});

test("three edits compose to one MultiEdit and a single edit", () => {
	const small = trace([edit("a", "b"), edit("b", "c"), edit("c", "d")]);
	const multi = trace([["MultiEdit", { file_path: "/work/equiv/a.ts", edits: [
		{ old_string: "a", new_string: "b" }, { old_string: "b", new_string: "c" }, { old_string: "c", new_string: "d" },
	] }]]);
	assert.deepEqual(signatures(small), signatures(multi));
	const result = alignEquivalent(small, multi);
	assert.equal(result.equivalent, true);
	assert.equal(result.left.events[0]?.rule, "edit-batch");
	assert.deepEqual(result.left.events[0]?.members, [0, 1, 2]);
	assert.equal(alignEquivalent(small, trace([edit("a", "d")])).equivalent, true);
	assert.equal(alignEquivalent(trace([edit("abc", "xyc"), edit("y", "z")]), trace([edit("abc", "xzc")])).equivalent, true);
	const disjoint = trace([edit("one", "two"), edit("red", "blue"), edit("left", "right")]);
	const disjointMulti = trace([["MultiEdit", { file_path: "/work/equiv/a.ts", edits: [
		{ old_string: "one", new_string: "two" }, { old_string: "red", new_string: "blue" }, { old_string: "left", new_string: "right" },
	] }]]);
	assert.equal(alignEquivalent(disjoint, disjointMulti).equivalent, true);
	assert.deepEqual(signatures(disjoint), signatures(disjointMulti));
});

test("unverified, disjoint, ambiguous, failed, and incompatible edits stay separate", () => {
	const small = trace([edit("a", "b"), edit("b", "c")]);
	const wrong = alignEquivalent(small, trace([edit("a", "d")]));
	assert.equal(wrong.equivalent, false);
	assert.equal(wrong.left.events.length, 2);
	for (const tools of [
		[edit("a", "b"), edit("c", "d")],
		[edit("a", "bb"), edit("b", "c")],
		[edit("a", "b", "a.ts", "error"), edit("b", "c")],
		[edit("a", "b"), edit("b", "c", "a.ts", "unknown")],
		[edit("a", ""), edit("x", "y")],
		[edit("a", "b"), ["Edit", { file_path: "/work/equiv/a.ts", old_string: "b", new_string: "c", replace_all: true }] as Tool],
	]) {
		const result = alignEquivalent(trace(tools), trace([edit("a", "d")]));
		assert.equal(result.equivalent, false);
		assert.equal(result.left.events.length, 2);
	}
	assert.notDeepEqual(signatures(trace([edit("a", "b")])), signatures(trace([edit("a", "c")])));
	const missing: Tool = ["Edit", { file_path: "/work/equiv/a.ts" }];
	assert.equal(normalized(trace([missing, missing])).events.length, 2);
	assert.equal(alignEquivalent(trace([missing]), trace([edit("a", "b")])).equivalent, false);
	assert.equal(alignEquivalent(trace([["Write", { file_path: "/work/equiv/a.ts", content: "one" }]]), trace([["Write", { file_path: "/work/equiv/a.ts", content: "two" }]])).equivalent, false);
});

test("enriched file identities never inherit display-path collisions", () => {
	const a = trace([["Read", { file_path: "/work/first/shared/a.ts", offset: 1, limit: 5 }]]);
	const b = trace([["Read", { file_path: "/work/second/shared/a.ts", offset: 1, limit: 5 }]]);
	assert.equal(normalizeTrace(a)[0]?.signature, normalizeTrace(b)[0]?.signature);
	assert.equal(alignEquivalent(a, b).equivalent, false);
	assert.equal(alignEquivalent(trace([shell("sed -n '1,5p' /work/first/shared/a.ts")]), trace([shell("sed -n '1,5p' /work/second/shared/a.ts")])).equivalent, false);
	assert.equal(alignEquivalent(trace([shell("sed -n 1,5p a.ts")]), trace([read(1, 5)])).incomplete, true);
});

test("align --order: reads and tests never cross an edit of the observed file", () => {
	const a = trace([read(1, 10), edit("a", "b"), read(1, 10)]);
	const b = trace([read(1, 10), read(1, 10), edit("a", "b")]);
	assert.equal(alignEquivalent(a, b).equivalent, false);
	assert.equal(normalized(a).events.length, 3);
	assert.equal(alignEquivalent(trace([shell("pnpm test"), edit("a", "b")]), trace([edit("a", "b"), shell("pnpm test")])).equivalent, false);
	for (const barrier of [shell("node build.js"), shell("pnpm test"), edit("a", "b"), edit("a", "b", "b.ts", "unknown"), ["Mystery", {}] as Tool, ["Agent", { prompt: "inspect" }] as Tool]) {
		assert.equal(normalized(trace([read(1, 10), barrier, read(11, 10)])).events.length, 3);
	}
	assert.equal(normalized(trace([read(1, 10), edit("a", "b", "b.ts"), read(11, 10)])).events.length, 3);
	for (const barrier of [read(1, 10), shell("pnpm test"), shell("node build.js"), edit("a", "b", "b.ts")]) {
		assert.equal(normalized(trace([edit("a", "b"), barrier, edit("b", "c")])).events.length, 3);
	}
});

test("shell pipelines, redirects, expansions, and exec sources remain opaque order barriers", () => {
	for (const command of ["head -n 5 b.ts | node mutate.js", "head -n 5 b.ts > a.ts", "cat $FILE", "cat *.ts", 'head -n 5 "$(node mutate.js)"', "echo $(node mutate.js) && head -n 5 b.ts", "for f in $(node mutate.js); do head -n 5 b.ts; done"]) {
		const t = trace([read(1, 5), shell(command), read(6, 5)]);
		const n = normalized(t);
		assert.equal(n.events.length, 3, command);
		assert.equal(n.events[1]?.action, "other", command);
		assert.equal(alignEquivalent(t, t).incomplete, true, command);
	}
	const exec = parseCodexEvents(codexEvents("Synthetic", [{ kind: "exec-cell", command: "head -n 5 a.ts" }]));
	cases.push(exec);
	assert.equal(alignEquivalent(exec, exec).incomplete, true);
});

test("dropped opaque source calls remain incomplete and divide observations and edits", () => {
	for (const command of ['echo "$(node mutate.js)"', 'printf "%s" "$(node mutate.js)"']) {
		const standalone = trace([shell(command)]);
		assert.deepEqual(normalizeTrace(standalone), [], command);
		const result = alignEquivalent(standalone, trace([]));
		assert.equal(result.incomplete, true, command);
		assert.equal(result.equivalent, false, command);
		const interleaved = trace([read(1, 5), shell(command), read(6, 5)]);
		assert.equal(normalized(interleaved).events.length, 2, command);
		assert.equal(alignEquivalent(interleaved, trace([read(1, 10)])).equivalent, false, command);
		assert.equal(normalized(trace([grep(), shell(command), grep()])).events.length, 2, command);
		assert.equal(normalized(trace([edit("a", "b"), shell(command), edit("b", "c")])).events.length, 2, command);
		const compound = trace([read(1, 5), shell(`cat b.ts && ${command}`), read(6, 5)]);
		assert.equal(normalized(compound).events.length, 3, command);
		assert.equal(normalized(compound).events[1]?.action, "other", command);
	}
	const literal = trace([read(1, 5), shell('echo "synthetic progress"'), read(6, 5)]);
	assert.equal(normalized(literal).events.length, 2);
	assert.equal(normalized(literal).incomplete, true);
	const sidechain = trace([read(1, 5), shell('echo "$(node mutate.js)"'), read(6, 5)]);
	(sidechain.steps[1] as Step).subagent_id = "synthetic-sidechain";
	assert.equal(normalized(sidechain).events.length, 1);
	assert.equal(normalized(sidechain).incomplete, false);
});

test("shell searches with execution, mutation or unsupported options are global barriers", () => {
	for (const command of [
		"find . -exec node mutate.js {} +",
		"find . -delete",
		"rg --pre ./mutate token a.ts",
		"rg --pre=./mutate token a.ts",
		"rg --unsupported-option token a.ts",
	]) {
		const repeated = trace([shell(command), read(1, 5), shell(command)]);
		const n = normalized(repeated);
		assert.equal(n.events.length, 3, command);
		assert.equal(n.events[0]?.action, "other", command);
		assert.equal(n.events[2]?.action, "other", command);
		assert.equal(alignEquivalent(repeated, repeated).incomplete, true, command);
		assert.equal(alignEquivalent(repeated, trace([shell(command), read(1, 5)])).equivalent, false, command);
		assert.equal(normalized(trace([read(1, 5), shell(command), read(6, 5)])).events.length, 3, command);
	}
	const literal = trace([shell("rg -n token a.ts"), read(1, 5), shell("rg -n token a.ts")]);
	assert.equal(normalized(literal).events.length, 2);
	assert.equal(normalized(literal).incomplete, false);
});

test("multi-file sed ranges are not independent per-file reads", () => {
	const combined = trace([shell("sed -n '1,5p' a.ts b.ts")]);
	const independent = trace([read(1, 5), read(1, 5, "b.ts")]);
	assert.equal(normalizeTrace(combined).length, 2);
	assert.deepEqual(normalized(combined).events.map((event) => event.range), [null, null]);
	assert.equal(alignEquivalent(combined, independent).equivalent, false);
	assert.equal(alignEquivalent(trace([shell("sed -n '1,5p' a.ts")]), trace([read(1, 5)])).equivalent, true);
});

test("shell reads retain lexical file identities and never commute across edits", () => {
	for (const [command, path] of [
		["cat /work/external/shared/a.ts", "/work/external/shared/a.ts"],
	]) {
		const mutation: Tool = ["Edit", { file_path: path, old_string: "a", new_string: "b" }];
		const repeated = trace([shell(command), mutation, shell(command)]);
		const n = normalized(repeated);
		assert.equal(n.events.length, 3, command);
		assert.equal(n.events[0]?.target, n.events[1]?.target, command);
		assert.equal(alignEquivalent(repeated, trace([shell(command), mutation])).equivalent, false, command);
		assert.equal(n.incomplete, false, command);
	}
	const distinct = trace([shell("cat a.ts"), edit("a", "b", "b.ts"), shell("cat a.ts")]);
	assert.equal(normalized(distinct).events.length, 3);
	// Unsupported shell file forms have no recovered identity, so every edit
	// remains a barrier even when Run Diff retained a plausible display target.
	const unlocated = trace([shell("tail a.ts"), edit("a", "b"), shell("tail a.ts")]);
	assert.equal(normalized(unlocated).events.length, 3);
	assert.equal(normalized(unlocated).events[0]?.target, null);
	for (const [name, args] of [
		["Edit", { old_string: "a", new_string: "b" }],
		["Write", { content: "synthetic" }],
	] as const) {
		const left = trace([[name, { ...args, file_path: "a.ts" }]]);
		const right = trace([[name, { ...args, file_path: "b.ts" }]]);
		delete left.run.workspace;
		delete right.run.workspace;
		assert.equal(normalized(left).events[0]?.target, null);
		assert.equal(alignEquivalent(left, right).equivalent, false, name);
	}
});

test("parent path segments remain unresolved global barriers", () => {
	for (const [name, args, field] of [
		["Read", { offset: 1, limit: 5 }, "file_path"],
		["read_file", { offset: 1, limit: 5 }, "path"],
		["Edit", { old_string: "a", new_string: "b" }, "file_path"],
		["Write", { content: "b" }, "file_path"],
		["write_file", { content: "b" }, "path"],
		["Grep", { pattern: "token" }, "path"],
	] as const) {
		const unresolved: Tool = [name, { ...args, [field]: "./link/../a.ts" }];
		const direct: Tool = [name, { ...args, [field]: "a.ts" }];
		const comparison = alignEquivalent(trace([unresolved]), trace([direct]));
		assert.equal(comparison.incomplete, true, name);
		assert.ok(comparison.incompleteReasons.includes("unresolved-path"), name);
		assert.equal(comparison.equivalent, false, name);
		assert.ok(comparison.left.events[0]?.key.includes("./link/../a.ts"), name);
		const barrier = normalized(trace([read(1, 5), unresolved, read(6, 5)]));
		assert.equal(barrier.events.length, 3, name);
	}
	for (const command of ["cat link/../a.ts", "head -n 5 link/../a.ts", "rg token link/../a.ts", "grep -rn token link/../a.ts"]) {
		const n = normalized(trace([read(1, 5), shell(command), read(6, 5)]));
		assert.ok(n.incompleteReasons.includes("unresolved-path"), command);
		assert.equal(n.events.length, 3, command);
		assert.ok(n.events[1]?.key.includes("link/../a.ts"), command);
	}
	assert.equal(alignEquivalent(trace([["Read", { file_path: "./src//a.ts", offset: 1, limit: 5 }]]),
		trace([["Read", { file_path: "src/a.ts", offset: 1, limit: 5 }]])).equivalent, true);
});

test("possible symlink aliases keep reads on opposite sides of a mutation distinct", () => {
	// A transcript cannot rule out alias.ts being a symlink to a.ts.
	const interleaved = trace([read(1, 10, "alias.ts"), edit("a", "b"), read(1, 10, "alias.ts")]);
	const before = trace([read(1, 10, "alias.ts"), read(1, 10, "alias.ts"), edit("a", "b")]);
	const result = alignEquivalent(interleaved, before);
	assert.equal(result.equivalent, false);
	assert.equal(result.left.events.length, 3);
});

test("normalizer cap metadata covers all read commands and stripped prefixes", () => {
	for (const command of [
		"tail a b c d e f g",
		"X=1 cat a b c d e f g",
		"head -n 5 a b c d e f g",
		"sed -n '1,5p' a b c d e f g",
		"nl a b c d e f g",
		"less a b c d e f g",
		"bat a b c d e f g",
		"bash -lc 'cat a b c d e f g'",
	]) {
		const capped = trace([shell(command)]);
		assert.equal(normalizeTrace(capped).length, 6, command);
		assert.equal(sourceNormalizationTruncated(capped.steps[0] as Step, capped.run.workspace?.cwd), true, command);
		const result = alignEquivalent(capped, capped);
		assert.equal(result.incomplete, true, command);
		assert.equal(result.equivalent, false, command);
		assert.ok(result.incompleteReasons.includes("normalizer-cap-or-unsupported-shape"), command);
	}
	for (const command of ["tail a b c d e f", "X=1 cat a b c d e f", "cat a; echo one; echo two; echo three; echo four; echo five; echo six"]) {
		const uncapped = trace([shell(command)]);
		assert.equal(sourceNormalizationTruncated(uncapped.steps[0] as Step, uncapped.run.workspace?.cwd), false, command);
		assert.equal(alignEquivalent(uncapped, uncapped).incomplete, true, command);
	}
	const patch = Array.from({ length: 7 }, (_, i) => `*** Update File: /work/equiv/file${i}.ts`).join("\n");
	const cappedSources: Tool[] = [
		["apply_patch", { input: patch }],
		["exec", { input: 'text(await tools.exec_command({cmd:"tail a b c d e f g"}))' }],
		["exec", { input: `text(await tools.apply_patch(${JSON.stringify(patch)}))` }],
	];
	for (const tool of cappedSources) {
		const capped = trace([tool]);
		assert.equal(sourceNormalizationTruncated(capped.steps[0] as Step, capped.run.workspace?.cwd), true, tool[0]);
		assert.ok(normalized(capped).incompleteReasons.includes("normalizer-cap-or-unsupported-shape"), tool[0]);
	}
});

test("canCommute exhaustive action/status/target matrix is symmetric", () => {
	const actions: DiffAction[] = ["read", "search", "edit", "write", "test", "run", "plan", "delegate", "web", "compaction", "blocked", "other"];
	const statuses: DiffStatus[] = ["ok", "unknown", "error", "interrupted"];
	const targets = ["a.ts", "b.ts", null];
	const event = (action: DiffAction, target: string | null, status: DiffStatus): CanonicalEvent => ({
		id: "event",
		action,
		target,
		status,
		key: "key",
		signature: "key",
		rule: null,
		members: [0],
		memberStepIds: ["source"],
	});
	for (const aa of actions) {
		for (const ba of actions) {
			for (const at of targets) {
				for (const bt of targets) {
					for (const as of statuses) {
						for (const bs of statuses) {
							const a = event(aa, at, as);
							const b = event(ba, bt, bs);
							const observations = ["read", "search"];
							const bothReadOnly = observations.includes(aa) && observations.includes(ba);
							assert.equal(canCommute(a, b), bothReadOnly, `${aa}/${as}/${at}, ${ba}/${bs}/${bt}`);
							assert.equal(canCommute(a, b), canCommute(b, a));
						}
					}
				}
			}
		}
	}
});

test("failed and unknown observations stay separate, and status forks diverge", () => {
	assert.deepEqual(normalized(trace([read(1, 5), read(6, 5, "a.ts", "unknown")])).events.map((e) => e.status), ["ok", "unknown"]);
	assert.deepEqual(normalized(trace([read(1, 5, "a.ts", "unknown"), read(6, 5, "a.ts", "error")])).events.map((e) => e.status), ["unknown", "error"]);
	assert.deepEqual(normalized(trace([read(1, 5, "a.ts", "interrupted"), read(6, 5)])).events.map((e) => e.status), ["interrupted", "ok"]);
	assert.equal(alignEquivalent(trace([read(1, 5)]), trace([read(1, 5, "a.ts", "error")])).equivalent, false);
});

test("compound source membership uses indices even when stepIds repeat", () => {
	const t = trace([shell("sed -n '1,10p' a.ts && sed -n '11,20p' a.ts && head -n 5 b.ts")]);
	const n = normalized(t);
	assert.equal(n.steps.length, 3);
	assert.equal(n.events.length, 3);
	assert.deepEqual(n.events.map((e) => e.memberStepIds), [["tool-0"], ["tool-0"], ["tool-0"]]);
	assert.ok(n.events.every((e) => e.rule === null && e.action === "other"));
	assert.equal(n.incomplete, true);
});

test("unclassified tools, malformed data, and normalization caps are incomplete", () => {
	for (const t of [trace([["write_file", { path: "a.ts", content: "x", unsupported: true }]]), trace([["UnknownTool", {}]]),
		trace([shell(Array.from({ length: 8 }, (_, i) => `cat file${i}.ts`).join(" && "))]),
		trace([shell("cat a b c d e f g h")])]) {
		const result = alignEquivalent(t, t);
		assert.equal(result.incomplete, true);
		assert.equal(result.equivalent, false);
	}
	const malformed = trace([read(1, 2)]);
	malformed.malformed_lines = 1;
	assert.equal(alignEquivalent(malformed, malformed).equivalent, false);
});

test("alignment truncation cannot report equivalent even if the retained prefix matches", () => {
	const t = trace(Array.from({ length: 4000 }, () => shell("node build.js")));
	const result = alignEquivalent(t, t);
	assert.ok(result.truncated.left > 0 || result.truncated.right > 0);
	assert.equal(result.incomplete, true);
	assert.equal(result.equivalent, false);
	assert.ok(result.incompleteReasons.includes("alignment-truncated"));
});

test("allowlist table enriches every structured and literal shell form", () => {
	const allowlisted: Tool[] = [
		read(1, 5),
		["Read", { file_path: "/work/equiv/a.ts" }],
		["read_file", { path: "/work/equiv/a.ts", offset: 1, limit: 5 }],
		["read_file", { file_path: "/work/equiv/a.ts" }],
		grep(),
		grep("token", { glob: "*.ts", type: "ts", output_mode: "content", "-n": true, "-i": false,
			"-A": 1, "-B": 2, "-C": 3, context: 4, head_limit: 5, offset: 0, multiline: true }),
		["Glob", { pattern: "**/*.ts", path: "/work/equiv/src" }],
		edit("a", "b"),
		["Edit", { file_path: "/work/equiv/a.ts", old_string: "a", new_string: "b", replace_all: false }],
		["MultiEdit", { file_path: "/work/equiv/a.ts", edits: [{ old_string: "a", new_string: "b", replace_all: false }] }],
		["Write", { file_path: "/work/equiv/a.ts", content: "synthetic" }],
		["write_file", { path: "/work/equiv/a.ts", content: "synthetic" }],
		["write_file", { file_path: "/work/equiv/a.ts", content: "synthetic" }],
	];
	const commands = ["sed -n '1,5p' a.ts", "sed -n '5p' a.ts", "head -n 5 a.ts", "cat a.ts",
		"rg token", "rg token src test", "rg -n -i -w -l -F --no-heading token src", "grep -rn token", "grep -rn token src test"];
	for (const command of commands) {
		allowlisted.push(shell(command));
		for (const name of ["shell", "shell_command", "exec_command"]) {
			for (const wrapper of ["sh", "bash", "zsh"]) {
				for (const flag of ["-c", "-lc"]) {
					allowlisted.push([name, { cmd: [wrapper, flag, command] }]);
				}
			}
		}
	}
	for (const tool of allowlisted) {
		const t = trace([tool]);
		const n = normalized(t);
		assert.equal(n.incomplete, false, JSON.stringify(tool));
		assert.equal(n.events.length, 1, JSON.stringify(tool));
		assert.notEqual(n.events[0]?.key, n.steps[0]?.signature, JSON.stringify(tool));
		assert.equal(alignEquivalent(t, t).equivalent, true, JSON.stringify(tool));
		if (n.events[0]?.action === "read" || n.events[0]?.action === "search") {
			assert.equal(normalized(trace([tool, tool])).events.length, 1, JSON.stringify(tool));
		}
	}
	assert.equal(alignEquivalent(trace([["read_file", { path: "/work/equiv/a.ts", offset: 1, limit: 5 }]]), trace([read(1, 5)])).equivalent, true);
	assert.equal(alignEquivalent(trace([["write_file", { path: "/work/equiv/a.ts", content: "synthetic" }]]),
		trace([["Write", { file_path: "/work/equiv/a.ts", content: "synthetic" }]])).equivalent, true);
});

test("near-miss table fails closed and cannot bridge any unsupported source", () => {
	const commands = [
		`bash -lc 'echo "$(node mutate.js)"'`,
		`bash -lc 'head -n 5 a.ts'`,
		"X=1 head -n 5 a.ts",
		"export PATH=/custom/bin && head -n 5 a.ts",
		"cd src && cat a.ts",
		"cat a.ts b.ts",
		"sed -n '1,5p' a.ts b.ts",
		"sed -n 1,5p a.ts b.ts",
		"sed -n 1,5p a.ts",
		"find . -exec node mutate.js {} +",
		"find .",
		"rg --pre ./mutate token a.ts",
		"rg --pre=./mutate token a.ts",
		"rg -z token a.ts",
		"rg --search-zip token a.ts",
		"rg --files src",
		"rg -q token src",
		"rg token --pre=./mutate",
		"grep -r token src",
		"tail a.ts",
		"xargs cat",
		"awk token a.ts",
		"cat <<EOF\nsynthetic\nEOF",
		"cat a.ts | head -n 5",
		"cat a.ts && cat b.ts",
		"cat a.ts; cat b.ts",
		"cat a.ts > b.ts",
		"cat < a.ts",
		"cat $(node mutate.js)",
		"cat `node mutate.js`",
		"cat $FILE",
		"cat *.ts",
		'cat "a.ts"',
		"cat a.ts # comment",
		"cat ~/a.ts",
		"cat a.ts\n",
		"echo synthetic",
		"export X=1",
		"cd src",
		"pwd",
	];
	const unsupported: Tool[] = commands.map(shell);
	unsupported.push(
		["shell", { command: ["bash", "-lc", 'echo "$(node mutate.js)"'] }],
		["shell", { command: ["cat", "a.ts"] }],
		["shell", { command: ["/bin/bash", "-lc", "cat a.ts"] }],
		["shell", { command: ["fish", "-c", "cat a.ts"] }],
		["shell", { command: ["bash", "-c", "cat a.ts", "extra"] }],
		["exec_command", { cmd: "cat a.ts", env: { X: "1" } }],
		["exec_command", { cmd: "cat a.ts", workdir: "/work/other" }],
		["write_stdin", { session_id: 1, chars: "node mutate.js\n" }],
		["write_stdin", { session_id: 1 }],
	);
	for (const tool of unsupported) {
		const label = JSON.stringify(tool);
		const t = trace([tool]);
		const result = alignEquivalent(t, trace([]));
		assert.equal(result.incomplete, true, label);
		assert.equal(result.equivalent, false, label);
		assert.ok(result.incompleteReasons.includes("unsupported-source"), label);
		const retained = normalizeTrace(t).length;
		const interleaved = normalized(trace([read(1, 5), tool, read(6, 5)]));
		assert.equal(interleaved.events.length, retained + 2, label);
		assert.ok(interleaved.events.every((e) => e.members.length === 1), label);
		assert.equal(normalized(trace([grep(), tool, grep()])).events.length, retained + 2, label);
		assert.equal(normalized(trace([edit("a", "b"), tool, edit("b", "c")])).events.length, retained + 2, label);
	}
});

test("structured allowlist rejects unknown keys, non-plain arguments and unsupported bodies", () => {
	const unsupported: Tool[] = [
		["Read", { file_path: "/work/equiv/a.ts", pages: "1" }],
		grep("token", { future_option: true }),
		grep("token", { output_mode: "future_mode" }),
		["Glob", { pattern: "*.ts", recursive: true }],
		["Edit", { file_path: "/work/equiv/a.ts", old_string: "a", new_string: "b", replace_all: true }],
		["MultiEdit", { file_path: "/work/equiv/a.ts", edits: [{ old_string: "a", new_string: "b", unknown: true }] }],
		["Write", { file_path: "/work/equiv/a.ts", content: "synthetic", mode: "append" }],
		["read_file", { path: "a.ts", file_path: "b.ts" }],
		["write_file", { path: "a.ts", content: "synthetic", append: true }],
		["NotebookEdit", { file_path: "/work/equiv/a.ts", old_string: "a", new_string: "b" }],
		["Read", Object.assign([], { file_path: "/work/equiv/a.ts" })],
		["Read", Object.assign(Object.create({ inherited: true }), { file_path: "/work/equiv/a.ts" })],
	];
	for (const tool of unsupported) {
		const n = normalized(trace([read(1, 5), tool, read(6, 5)]));
		assert.equal(n.incomplete, true, JSON.stringify(tool));
		assert.ok(n.incompleteReasons.includes("unsupported-source"), JSON.stringify(tool));
		assert.equal(n.events.length, 3, JSON.stringify(tool));
		assert.equal(n.events[1]?.action, "other", JSON.stringify(tool));
	}
});

test("round-2 environment changes cannot equal structured reads", () => {
	const changed = trace([shell("export PATH=/custom/bin && head -n 5 a.ts")]);
	const result = alignEquivalent(changed, trace([read(1, 5)]));
	assert.equal(result.incomplete, true);
	assert.equal(result.equivalent, false);
	assert.equal(result.left.events[0]?.action, "other");
	assert.equal(result.left.events[0]?.range, null);
});

test("round-2 only explicitly empty write_stdin polls may disappear", () => {
	const poll: Tool = ["write_stdin", { session_id: 1, chars: "", yield_time_ms: 1000 }];
	assert.equal(alignEquivalent(trace([poll]), trace([])).equivalent, true);
	assert.equal(normalized(trace([read(1, 5), poll, read(6, 5)])).events.length, 1);
	for (const args of [{ session_id: 1, chars: "node mutate.js\n" }, { session_id: 1, chars: "\u0003" },
		{ session_id: 1, chars: " " }, { session_id: 1 }, { session_id: 1, chars: null }]) {
		const sent = trace([["write_stdin", args]]);
		assert.equal(alignEquivalent(sent, trace([])).incomplete, true);
		assert.equal(alignEquivalent(sent, trace([poll])).equivalent, false);
		assert.equal(alignEquivalent(sent, trace([["write_stdin", { session_id: 1, chars: "different\n" }]])).equivalent, false);
		assert.equal(normalized(trace([read(1, 5), ["write_stdin", args], read(6, 5)])).events.length, 2);
	}
});

test("round-2 retries and mixed-outcome ranges cannot vanish into failures", () => {
	for (const status of ["error", "unknown", "interrupted"] as const) {
		const failedSearch: Tool = ["Grep", { pattern: "token", path: "/work/equiv/src" }, status];
		const retry = trace([failedSearch, grep()]);
		const result = alignEquivalent(retry, trace([failedSearch]));
		assert.equal(result.equivalent, false, status);
		assert.deepEqual(result.left.events.map((e) => e.status), [status, "ok"]);
		assert.equal(normalized(trace([failedSearch, failedSearch])).events.length, 2);
		const split = trace([read(1, 5, "a.ts", status), read(6, 5)]);
		assert.equal(alignEquivalent(split, trace([read(1, 10, "a.ts", status)])).equivalent, false);
		assert.equal(alignEquivalent(trace([read(1, 5, "a.ts", status)]), trace([read(1, 5)])).equivalent, false);
		assert.equal(normalized(trace([read(1, 5, "a.ts", status), read(1, 5, "a.ts", status)])).events.length, 2);
		assert.deepEqual(normalized(split).events.map((e) => e.members), [[0], [1]]);
	}
});

test("tests use literal source keys while runs retain their unsupported accounting and global barriers", () => {
	for (const command of ["pnpm test", "node build.js", "awk token a.ts"]) {
		const t = trace([read(1, 5), shell(command), read(6, 5)]);
		const n = normalized(t);
		assert.equal(n.events.length, 3, command);
		if (command === "pnpm test") {
			assert.notEqual(n.events[1]?.signature, n.steps[1]?.signature, command);
			assert.equal(n.incomplete, false, command);
		} else {
			assert.equal(n.events[1]?.signature, n.steps[1]?.signature, command);
			assert.ok(n.incompleteReasons.includes("unsupported-source"), command);
		}
		assert.equal(n.events[1]?.action, n.steps[1]?.action, command);
		assert.equal(n.events[1]?.rule, null, command);
	}
});

test("test sources fail closed on shell syntax and execution scope options", () => {
	const commands = [
		"pnpm test $(node mutate.js)",
		"pnpm test `node mutate.js`",
		"pnpm test $FLAGS",
		"pnpm test > result.txt",
		"pnpm test 2>> result.txt",
		"pnpm test < input.txt",
		"pnpm test | tail",
		"pnpm test && node mutate.js",
		"pnpm test; node mutate.js",
		"X=1 pnpm test",
		"export X=1 && pnpm test",
		"cd src && pnpm test",
		"pnpm test <<EOF\nsynthetic\nEOF",
		"pnpm test\nnode mutate.js",
		"pnpm test\n",
		"pnpm test # comment",
		"pnpm test *.ts",
		"pnpm test --grep=x",
		"pnpm test =node",
		"bash -lc 'pnpm test'",
		"if pnpm test",
		"then pnpm test",
	];
	const unsupported: Tool[] = commands.map(shell);
	for (const name of ["Bash", "shell", "shell_command", "exec_command"]) {
		for (const command of commands) unsupported.push([name, { cmd: ["bash", "-lc", command] }]);
		for (const option of ["workdir", "cwd", "working_directory"]) {
			for (const directory of ["/work/other", null, "", 1]) {
				unsupported.push([name, { command: "pnpm test", [option]: directory }]);
			}
		}
		unsupported.push(
			[name, { cmd: "pnpm test", workdir: "/work/equiv", cwd: "/work/other" }],
			[name, { cmd: "pnpm test", env: { X: "1" } }],
			[name, { cmd: "pnpm test", command: "pnpm test" }],
			[name, { cmd: ["pnpm", "test"] }],
			[name, { cmd: ["bash", "-lc", "pnpm test", "extra"] }],
		);
	}
	unsupported.push(["UnknownTool", { command: "pnpm test" }]);
	// Generic runs continue to be unsupported, including deceptively literal
	// signatures left behind when Run Diff strips shell syntax or scope.
	for (const command of ["node build.js", "node build.js $(node mutate.js)", "node build.js > result.txt", "X=1 node build.js"]) {
		unsupported.push(shell(command));
	}
	unsupported.push(["exec_command", { cmd: "node build.js", workdir: "/work/other" }]);
	for (const tool of unsupported) {
		const label = JSON.stringify(tool);
		const t = trace([tool]);
		for (const other of [trace([shell("pnpm test")]), t]) {
			const result = alignEquivalent(t, other);
			assert.equal(result.incomplete, true, label);
			assert.equal(result.equivalent, false, label);
			assert.ok(result.incompleteReasons.includes("unsupported-source"), label);
		}
		const barrier = normalized(trace([read(1, 5), tool, read(6, 5)]));
		assert.ok(barrier.events.every((event) => event.members.length === 1), label);
	}
});

test("accepted tests retain exact literal arguments and argv wrappers in their keys", () => {
	for (const name of ["Bash", "shell", "shell_command", "exec_command"]) {
		for (const command of ["pnpm test", "pnpm test -- --grep x", "node --test a.test.ts"]) {
			const forms: Array<string | string[]> = [command];
			for (const wrapper of ["sh", "bash", "zsh"]) {
				for (const flag of ["-c", "-lc"]) forms.push([wrapper, flag, command]);
			}
			for (const form of forms) {
				for (const field of ["cmd", "command"]) {
					const t = trace([[name, { [field]: form }]]);
					assert.equal(alignEquivalent(t, t).equivalent, true, JSON.stringify(form));
					for (const option of ["workdir", "cwd"]) {
						const scoped = trace([[name, { [field]: form, [option]: "/work/equiv" }]]);
						assert.equal(alignEquivalent(t, scoped).equivalent, true, JSON.stringify(form));
					}
				}
			}
		}
	}
	for (const command of ["pnpm test -- --grep x", "pnpm run test"]) {
		const result = alignEquivalent(trace([shell("pnpm test")]), trace([shell(command)]));
		assert.equal(result.incomplete, false, command);
		assert.equal(result.equivalent, false, command);
	}
	const wrapped = trace([["shell", { cmd: ["bash", "-lc", "pnpm test"] }]]);
	assert.equal(alignEquivalent(wrapped, trace([shell("pnpm test")])).equivalent, false);
	const unknownRoot = trace([["exec_command", { cmd: "pnpm test", workdir: "/work/equiv" }]]);
	delete unknownRoot.run.workspace;
	assert.ok(normalized(unknownRoot).incompleteReasons.includes("unsupported-source"));
});

test("unsuccessful MultiEdits retain their ordered replacements without internal or cross-step composition", () => {
	const multi = (via: string, status: DiffStatus): Tool => ["MultiEdit", { file_path: "/work/equiv/a.ts", edits: [
		{ old_string: "a", new_string: via }, { old_string: via, new_string: "c" },
	] }, status];
	for (const status of ["error", "unknown", "interrupted"] as const) {
		const left = trace([multi("b", status)]);
		const right = trace([multi("x", status)]);
		const result = alignEquivalent(left, right);
		assert.equal(result.equivalent, false, status);
		assert.notEqual(result.left.events[0]?.key, result.right.events[0]?.key, status);
		assert.deepEqual(JSON.parse(normalized(left).events[0]?.key as string)[2], [
			{ old: "a", next: "b" }, { old: "b", next: "c" },
		], status);
		assert.equal(alignEquivalent(left, trace([edit("a", "c", "a.ts", status)])).equivalent, false, status);
		const chain = normalized(trace([edit("start", "a"), multi("b", status), edit("c", "end")]));
		assert.deepEqual(chain.events.map((event) => event.members), [[0], [1], [2]], status);
		assert.equal(result.incomplete, status === "unknown", status);
	}
	assert.equal(alignEquivalent(trace([multi("b", "ok")]), trace([multi("x", "ok")])).equivalent, true);
});

test("allowlisted arguments cannot overwrite a blocked source classification", () => {
	const t = trace([read(1, 5), read(6, 5), read(11, 5)]);
	(t.steps[1] as Step).attributes[ATTR.GUARD_TRIPPED] = true;
	(t.steps[1] as Step).attributes[ATTR.GUARD_NAME] = "synthetic-guard";
	const n = normalized(t);
	assert.equal(n.steps[1]?.action, "blocked");
	assert.equal(n.events.length, 3);
	assert.equal(n.events[1]?.action, "other");
	assert.ok(n.incompleteReasons.includes("unsupported-source"));
});

test("parsed Claude Agent calls are incomplete even against themselves and never use agent-type keys", () => {
	const delegated = (prompt: string) => {
		const t = parseClaudeCodeEvents([
			{
				type: "assistant", uuid: "delegate-call", timestamp: "2026-10-01T00:00:00Z", cwd: "/work/equiv",
				message: { role: "assistant", content: [{
					type: "tool_use", id: "delegate", name: "Agent", input: { subagent_type: "general-purpose", prompt },
				}] },
			},
			{
				type: "user", uuid: "delegate-result", timestamp: "2026-10-01T00:00:01Z", cwd: "/work/equiv",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "delegate", content: "ok" }] },
			},
		]);
		cases.push(t);
		return t;
	};
	const left = delegated("Read src/a.ts");
	const right = delegated("Rewrite src/b.ts");
	assert.equal(left.steps.find((step) => step.step_id === "delegate")?.kind, "agent");
	assert.equal(normalizeTrace(left)[0]?.status, "ok");
	assert.equal(normalizeTrace(left)[0]?.signature, "delegate:general-purpose");
	assert.equal(normalizeTrace(right)[0]?.signature, normalizeTrace(left)[0]?.signature);
	for (const other of [right, left]) {
		const result = alignEquivalent(left, other);
		assert.equal(result.incomplete, true);
		assert.equal(result.equivalent, false);
		assert.ok(result.incompleteReasons.includes("unsupported-delegate"));
		assert.notEqual(result.left.events[0]?.key, result.left.steps[0]?.signature);
		assert.equal(result.left.events[0]?.action, "other");
	}
	const interleaved = trace([read(1, 5), read(6, 5)]);
	interleaved.steps.splice(1, 0, left.steps.find((step) => step.step_id === "delegate") as Step);
	assert.deepEqual(normalized(interleaved).events.map((event) => event.members), [[0], [1], [2]]);
});

test("every retained non-tool source is unsupported and a global order barrier", () => {
	for (const kind of ["agent", "compaction", "hook"] as const) {
		const t = trace([read(1, 5), read(6, 5), read(11, 5)]);
		const source = t.steps[1] as Step;
		source.kind = kind;
		source.attributes[ATTR.AGENT_TYPE] = "general-purpose";
		source.attributes[ATTR.HOOK_VERDICT] = "deny";
		const result = alignEquivalent(t, t);
		assert.equal(result.incomplete, true, kind);
		assert.equal(result.equivalent, false, kind);
		assert.ok(result.incompleteReasons.includes(kind === "agent" ? "unsupported-delegate" : "unsupported-source"), kind);
		assert.equal(result.left.events[1]?.action, "other", kind);
		assert.deepEqual(result.left.events.map((event) => event.members), [[0], [1], [2]], kind);
	}
});

test("retained steps without allowlist evidence cannot bypass incomplete accounting", () => {
	const t = trace([read(1, 5), read(6, 5), read(11, 5)]);
	const steps = normalizeTrace(t);
	for (const kind of ["llm", "decision", "memory", "mode_change", "tool_call"] as const) {
		const source = t.steps[1] as Step;
		source.kind = kind;
		source.attributes = { [ATTR.TOOL_NAME]: "write_stdin", [ATTR.TOOL_ARGS]: { session_id: 1, chars: "" } };
		// Direct callers can supply retained steps even for normally omitted sources.
		const n = normalizeEquivalent(steps, new Map(t.steps.map((step) => [step.step_id, step])), "/work/equiv");
		assert.equal(n.incomplete, true, kind);
		assert.ok(n.incompleteReasons.includes("unsupported-source"), kind);
		assert.equal(n.events[1]?.action, "other", kind);
		assert.notEqual(n.events[1]?.key, steps[1]?.signature, kind);
		assert.deepEqual(n.events.map((event) => event.members), [[0], [1], [2]], kind);
	}
	const source = t.steps[1] as Step;
	source.attributes = { [ATTR.TOOL_NAME]: "Read", [ATTR.TOOL_ARGS]: { file_path: "/work/equiv/a.ts", offset: 6, limit: 5 } };
	source.subagent_id = "synthetic-sidechain";
	const n = normalizeEquivalent(steps, new Map(t.steps.map((step) => [step.step_id, step])), "/work/equiv");
	assert.equal(n.incomplete, true);
	assert.equal(n.events[1]?.action, "other");
	assert.equal(n.events.length, 3);
});

test("zsh executable expansion is never evidence of a literal workspace read", () => {
	const expanded = trace([["shell", { cmd: ["zsh", "-c", "head -n 5 =node"] }]]);
	const literal = trace([read(1, 5, "=node")]);
	const result = alignEquivalent(expanded, literal);
	assert.equal(result.incomplete, true);
	assert.equal(result.equivalent, false);
	assert.ok(result.incompleteReasons.includes("unsupported-source"));
	assert.equal(result.left.events[0]?.action, "other");
});

test("shell literal token table covers operands, patterns, execution arguments and flag bodies", () => {
	const accepted = ["a.ts", "_token", "0", "./src/a.ts", "/work/external/a.ts", "a:b@c+d,e-f", "a-b"];
	const rejected = ["=node", "a=b", "~", "~user/a", "!token", "a!b", "{a,b}", "a%b", "%1", "é.ts", "a\\b", "a\"b", "a'b", "a$b", "a`b", "a*b", "a?b", "a[b]", "a#b", ":a", "@a", "+a", ",a", "", "''", "''a''", "a b", "a\tb", "a\nb", "a\n", "a\r"];
	for (const [tokens, complete] of [[accepted, true], [rejected, false]] as const) {
		for (const token of tokens) {
			// Bare whitespace separates valid arguments, and absence is a valid
			// default search scope; only quoted forms represent these as tokens.
			for (const word of token === "" || /\s/.test(token) ? [`'${token}'`] : [token, `'${token}'`]) {
				for (const command of [
					`cat ${word}`, `head -n 5 ${word}`, `sed -n '1,5p' ${word}`,
					`rg token ${word}`, `grep -rn token ${word}`, `rg ${word} src`, `grep -rn ${word} src`,
					`pnpm test ${word}`,
				]) {
					const t = trace([shell(command)]);
					const result = alignEquivalent(t, t);
					assert.equal(result.incomplete, !complete, command);
					assert.equal(result.equivalent, complete, command);
					if (!complete) assert.ok(result.incompleteReasons.includes("unsupported-source"), command);
				}
			}
		}
	}
	for (const token of ["-n", "--no-heading", "--", "-"]) {
		for (const word of [token, `'${token}'`]) {
			for (const command of [`cat ${word}`, `head -n 5 ${word}`, `sed -n '1,5p' ${word}`, `rg token ${word}`, `grep -rn token ${word}`]) {
				const t = trace([shell(command)]);
				assert.equal(alignEquivalent(t, t).incomplete, true, command);
			}
		}
	}
	for (const flag of ["--grep=x", "--=node", "-~", "--!x", "--{a,b}", "--%1", "--é", "---grep", "--'grep'"]) {
		for (const word of [flag, `'${flag}'`]) {
			const t = trace([shell(`pnpm test ${word}`)]);
			assert.equal(alignEquivalent(t, t).incomplete, true, word);
		}
	}
	assert.equal(alignEquivalent(trace([shell("head -n 5 'a.ts'")]), trace([read(1, 5)])).equivalent, true);
	// The sed script retains its exact syntax check rather than the token rule.
	const sed = trace([shell("sed -n '1,5p;d' a.ts")]);
	assert.equal(alignEquivalent(sed, sed).incomplete, true);
});

test("missing workspace roots fail closed for relative and omitted paths in every evidence class", () => {
	const tools: Tool[] = [
		["Read", { file_path: "a.ts", offset: 1, limit: 5 }],
		["read_file", { path: "a.ts" }],
		["Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }],
		["MultiEdit", { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }] }],
		["Write", { file_path: "a.ts", content: "b" }],
		["write_file", { path: "a.ts", content: "b" }],
		["Read", {}], ["read_file", {}],
		["Edit", { old_string: "a", new_string: "b" }],
		["Write", { content: "b" }], ["write_file", { content: "b" }],
	];
	for (const name of ["Grep", "Glob"]) {
		for (const path of [undefined, "src", ".", "./src"]) tools.push([name, { pattern: "token", ...(path === undefined ? {} : { path }) }]);
	}
	for (const command of [
		"cat a.ts", "head -n 5 a.ts", "sed -n '1,5p' a.ts", "rg token src", "rg -n token src", "rg token",
		"grep -rn token src", "grep -rn token", "rg token /work/external/src src",
		"pnpm test", "node --test /work/external/a.test.ts", "node build.js", "cat", "head -n 5",
	]) {
		tools.push(shell(command));
		for (const name of ["shell", "shell_command", "exec_command"]) tools.push([name, { cmd: ["zsh", "-c", command] }]);
	}
	for (const tool of tools) {
		for (const cwd of [undefined, "relative/root", ""]) {
			const left = trace([tool]);
			const right = trace([tool]);
			left.run.workspace = right.run.workspace = cwd === undefined ? undefined : { cwd };
			const result = alignEquivalent(left, right);
			const label = JSON.stringify({ tool, cwd });
			assert.equal(result.incomplete, true, label);
			assert.equal(result.equivalent, false, label);
			assert.ok(result.left.incompleteReasons.includes("unresolved-root"), label);
			assert.ok(result.right.incompleteReasons.includes("unresolved-root"), label);
			assert.deepEqual(expandAll(result.left), normalizeTrace(left));
		}
	}
});

test("omitted search scopes resolve only to known workspace roots", () => {
	for (const name of ["Grep", "Glob"]) {
		const omitted = trace([[name, { pattern: "token" }]]);
		for (const path of [".", "/work/equiv"]) {
			assert.equal(alignEquivalent(omitted, trace([[name, { pattern: "token", path }]])).equivalent, true, name);
		}
	}
	for (const command of ["rg token", "rg -n token", "grep -rn token"]) {
		const omitted = trace([shell(command)]);
		for (const path of [".", "/work/equiv"]) {
			assert.equal(alignEquivalent(omitted, trace([shell(`${command} ${path}`)])).equivalent, true, command);
		}
	}
});

test("absolute paths remain usable without a root and external search identities stay distinct", () => {
	for (const build of [
		(path: string): Tool => ["Read", { file_path: path, offset: 1, limit: 5 }],
		(path: string): Tool => ["Edit", { file_path: path, old_string: "a", new_string: "b" }],
		(path: string): Tool => ["Write", { file_path: path, content: "b" }],
		(path: string): Tool => ["write_file", { path, content: "b" }],
		(path: string): Tool => ["Grep", { pattern: "token", path }],
		(path: string): Tool => ["Glob", { pattern: "*.ts", path }],
		(path: string): Tool => shell(`head -n 5 ${path}`),
		(path: string): Tool => shell(`rg token ${path}`),
		(path: string): Tool => shell(`grep -rn token ${path}`),
	]) {
		for (const knownRoot of [true, false]) {
			const left = trace([build("/work/external/a.ts")]);
			const right = trace([build("/work/other/a.ts")]);
			if (!knownRoot) delete left.run.workspace;
			if (!knownRoot) delete right.run.workspace;
			assert.equal(alignEquivalent(left, left).equivalent, true, JSON.stringify(left.steps[0]?.attributes));
			const result = alignEquivalent(left, right);
			assert.equal(result.incomplete, false);
			assert.equal(result.equivalent, false);
		}
	}
});

test("expand round-trips every synthetic case and every existing fixture builder variant", () => {
	const cc = ccEvents("Inspect the synthetic module", [
		{ name: "Read", file: "src/a.ts" }, { name: "Edit", file: "src/a.ts" }, { name: "Write", file: "src/b.ts" },
		{ name: "Grep", pattern: "token" }, { name: "TodoWrite" }, { name: "Bash", command: "pnpm test" },
		{ name: "Bash", command: "node build.js", error: "synthetic error" }, { name: "Read", file: "missing.ts", error: "not found" },
	], { finished: false });
	const codex = codexEvents("Inspect the synthetic module", [
		{ kind: "shell", command: "cat src/a.ts src/b.ts" }, { kind: "shell", command: "pnpm test", exit: 1 },
		{ kind: "exec-cell", command: "node build.js" }, { kind: "exec-cell", command: "pnpm test", exit: 1 },
		{ kind: "patch", file: "src/a.ts" }, { kind: "patch", file: "src/b.ts", add: true }, { kind: "plan" },
	], { finished: false });
	assert.equal(toJsonl(cc).split("\n").length, cc.length);
	const built = [parseClaudeCodeEvents(cc), parseCodexEvents(codex), parseClaudeCodeEvents(ccEvents("Synthetic", [])), parseCodexEvents(codexEvents("Synthetic", []))];
	for (const t of [...cases, ...built]) {
		const n = normalized(t);
		const original = normalizeTrace(t);
		assert.deepEqual(expandAll(n), original);
		assert.equal(new Set(n.events.flatMap((e) => e.members)).size, original.length);
		assert.equal(n.events.reduce((sum, e) => sum + e.members.length, 0), original.length);
		for (const e of n.events) {
			assert.deepEqual(expand(e, n.steps), e.members.map((index) => n.steps[index]));
			expand(e, n.steps).forEach((s, i) => assert.equal(s, n.steps[e.members[i] as number]));
		}
	}
});
