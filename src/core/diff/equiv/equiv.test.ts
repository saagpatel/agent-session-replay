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
	assert.equal(normalized(trace([unknown, unknown])).events.length, 1);
	assert.equal(alignEquivalent(trace([shell("rg token src && rg token src")]), trace([shell("rg token src")])).equivalent, true);
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
	assert.equal(alignEquivalent(trace([shell("sed -n 1,5p a.ts")]), trace([read(1, 5)])).equivalent, true);
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
	assert.equal(normalized(trace([read(1, 10), edit("a", "b", "b.ts"), read(11, 10)])).events.length, 2);
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
	assert.equal(normalized(literal).events.length, 1);
	assert.equal(normalized(literal).incomplete, false);
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

test("shell reads use full lexical file identities before commuting across edits", () => {
	for (const [command, path] of [
		["cat /work/external/shared/a.ts", "/work/external/shared/a.ts"],
		["cat /work/equiv/src/../a.ts", "/work/equiv/a.ts"],
		["cat a.ts", "/work/equiv/src/../a.ts"],
		["head -n 5 /work/equiv/src/../a.ts", "/work/equiv/a.ts"],
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
	assert.equal(normalized(distinct).events.length, 2);
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
		assert.equal(alignEquivalent(uncapped, uncapped).incomplete, false, command);
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
							const distinct = at !== null && bt !== null && at !== bt;
							const readAndKnownFileEdit = distinct && (
								(aa === "read" && ["edit", "write"].includes(ba) && bs === "ok") ||
								(ba === "read" && ["edit", "write"].includes(aa) && as === "ok")
							);
							assert.equal(canCommute(a, b), bothReadOnly || readAndKnownFileEdit, `${aa}/${as}/${at}, ${ba}/${bs}/${bt}`);
							assert.equal(canCommute(a, b), canCommute(b, a));
						}
					}
				}
			}
		}
	}
});

test("merged statuses aggregate failure then unknown, and status forks diverge", () => {
	assert.equal(normalized(trace([read(1, 5), read(6, 5, "a.ts", "unknown")])).events[0]?.status, "unknown");
	assert.equal(normalized(trace([read(1, 5, "a.ts", "unknown"), read(6, 5, "a.ts", "error")])).events[0]?.status, "error");
	assert.equal(normalized(trace([read(1, 5, "a.ts", "interrupted"), read(6, 5)])).events[0]?.status, "interrupted");
	assert.equal(alignEquivalent(trace([read(1, 5)]), trace([read(1, 5, "a.ts", "error")])).equivalent, false);
});

test("compound source membership uses indices even when stepIds repeat", () => {
	const t = trace([shell("sed -n '1,10p' a.ts && sed -n '11,20p' a.ts && head -n 5 b.ts")]);
	const n = normalized(t);
	assert.equal(n.steps.length, 3);
	assert.equal(n.events.length, 2);
	assert.deepEqual(n.events[0]?.memberStepIds, ["tool-0", "tool-0"]);
	assert.deepEqual(n.events[0]?.range, { start: 1, end: 20 });
});

test("unclassified tools, malformed data, and normalization caps are incomplete", () => {
	for (const t of [trace([["write_file", { path: "a.ts", content: "x" }]]), trace([["UnknownTool", {}]]),
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
