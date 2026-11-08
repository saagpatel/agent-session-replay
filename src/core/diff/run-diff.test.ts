import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTranscript } from "../parse.ts";
import { parseClaudeCodeEvents } from "../parsers/claude-code.ts";
import { parseCodexEvents } from "../parsers/codex.ts";
import { alignSteps, fit } from "./align.ts";
import {
	ccEvents,
	codexEvents,
	toJsonl,
	WORKSPACE_CC,
	WORKSPACE_CODEX,
} from "./fixtures.ts";
import { classifyCommand, normalizeTrace, relPath, resolveStatuses } from "./normalize.ts";
import { hasTestFailures, hasTestPasses } from "../test-signal.ts";
import { describeStep } from "./rank.ts";
import { diffRuns } from "./run-diff.ts";
import type { DiffAction, DiffStep } from "./types.ts";

const PROMPT = "Fix the failing date parser test";

function step(action: DiffAction, target: string | null, status: DiffStep["status"] = "ok"): DiffStep {
	return {
		index: 0,
		stepId: `${action}-${target}`,
		action,
		target,
		label: `${action} ${target ?? ""}`.trim(),
		status,
		startedAt: "2026-10-01T00:00:00.000Z",
		signature: `${action}:${target ?? ""}`,
	};
}

// ---- normalization -------------------------------------------------------

test("relPath strips the run's cwd so different worktrees line up", () => {
	assert.equal(relPath(`${WORKSPACE_CC}/src/date.ts`, WORKSPACE_CC), "src/date.ts");
	assert.equal(relPath("./src/date.ts", WORKSPACE_CC), "src/date.ts");
	assert.equal(relPath("/elsewhere/deep/pkg/file.ts", WORKSPACE_CC), "pkg/file.ts");
	assert.equal(relPath("src/date.ts", null), "src/date.ts");
});

test("classifyCommand maps shell commands onto harness-neutral verbs", () => {
	const c = (cmd: string) =>
		classifyCommand(cmd, WORKSPACE_CODEX).map((x) => `${x.action}:${x.target ?? `(${x.note})`}`);
	assert.deepEqual(c("sed -n 1,80p src/date.ts"), ["read:src/date.ts"]);
	assert.deepEqual(c(`cat ${WORKSPACE_CODEX}/README.md`), ["read:README.md"]);
	assert.deepEqual(c("rg -n parseDate src"), ["search:(rg)"]);
	assert.deepEqual(c("git status --short"), ["read:git status"]);
	assert.deepEqual(c("git commit -m x"), ["run:git commit"]);
	// sed -i edits in place; it is not a read
	assert.deepEqual(c("sed -i 's/a/b/' src/date.ts"), ["run:sed"]);
});

test("test runs normalize to the runner, ignoring flags, pipes and redirects", () => {
	const c = (cmd: string) => classifyCommand(cmd, null).map((x) => `${x.action}:${x.target}`);
	assert.deepEqual(c("pnpm test"), ["test:pnpm test"]);
	assert.deepEqual(c("npm test 2>&1 | head -40"), ["test:npm test"]);
	assert.deepEqual(c("cd /x && pnpm test -- date"), ["test:pnpm test"]);
	assert.deepEqual(c("CI=1 node --test src"), ["test:node --test"]);
	assert.deepEqual(c("bash -lc 'pytest -q'"), ["test:pytest"]);
	assert.deepEqual(c("python -m pytest tests/"), ["test:python -m pytest"]);
});

test("compound commands split into one step per stage, dropping shell noise", () => {
	const c = (cmd: string) => classifyCommand(cmd, null).map((x) => `${x.action}:${x.target ?? `(${x.note})`}`);
	assert.deepEqual(c("pwd; cat package.json; rg --files; npm test"), [
		"read:package.json",
		"search:(rg)",
		"test:npm test",
	]);
	assert.deepEqual(c("cat src/a.ts src/b.ts"), ["read:src/a.ts", "read:src/b.ts"]);
	// heredoc bodies are not commands
	assert.deepEqual(c("python3 - <<'PY'\nimport os; os.remove('x')\nPY"), ["run:python3"]);
});

test("stage splitting respects quotes", () => {
	assert.deepEqual(
		classifyCommand(`node -e "const a = 1; console.log(a)"; git status`, null).map((x) => `${x.action}:${x.target}`),
		["run:node", "read:git status"],
	);
});

test("a failing suite both runs hit at different times is not the flagged fork", () => {
	// Left tests first (failing), then fixes; right explores first, then hits the
	// same failure and never fixes it. The fork is the left run's edit.
	const left = parseClaudeCodeEvents(
		ccEvents(PROMPT, [
			{ name: "Bash", command: "pnpm test", error: "Exit code 1" },
			{ name: "Read", file: "src/date.ts" },
			{ name: "Edit", file: "src/date.ts" },
			{ name: "Bash", command: "pnpm test" },
		]),
	);
	const right = parseCodexEvents(
		codexEvents(PROMPT, [
			{ kind: "shell", command: "cat README.md" },
			{ kind: "shell", command: "sed -n 1,80p src/date.ts" },
			{ kind: "exec-cell", command: "pnpm test", exit: 1 },
		]),
	);
	const diff = diffRuns(left, right);
	const pivot = diff.rows[diff.flagged?.pivotRow ?? -1];
	assert.equal(pivot?.left?.signature, "edit:src/date.ts");
	assert.match(diff.explanation, /Claude Code edited `src\/date\.ts`, a step Codex never took here/);
	assert.match(diff.explanation, /Claude Code ended with passing tests while Codex ended with failing tests/);
});

test("a Codex exec cell that patches and then tests yields both steps", () => {
	const input = `const r = await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Update File: ${WORKSPACE_CODEX}/src/date.ts\n@@\n-a\n+b\n*** End Patch`)});\ntext(await tools.exec_command({"cmd":"npm test","max_output_tokens":2000}));`;
	const trace = parseCodexEvents([
		{ timestamp: "2026-10-01T11:00:00.000Z", type: "session_meta", payload: { id: "x", cwd: WORKSPACE_CODEX } },
		{
			timestamp: "2026-10-01T11:00:01.000Z",
			type: "response_item",
			payload: { type: "custom_tool_call", name: "exec", call_id: "c1", status: "completed", input },
		},
		{
			timestamp: "2026-10-01T11:00:02.000Z",
			type: "response_item",
			payload: {
				type: "custom_tool_call_output",
				call_id: "c1",
				output: [
					{ type: "input_text", text: "Script completed\nOutput:\n" },
					{ type: "input_text", text: "{}" },
					{ type: "input_text", text: '{"chunk_id":"a1","exit_code":1,"output":"\\u2139 fail 1\\n"}' },
				],
			},
		},
	]);
	const steps = normalizeTrace(trace);
	assert.deepEqual(
		steps.map((s) => `${s.signature}:${s.status}`),
		["edit:src/date.ts:ok", "test:npm test:error"],
	);
});

test("Claude Code and Codex steps for the same work normalize identically", () => {
	const cc = normalizeTrace(
		parseClaudeCodeEvents(
			ccEvents(PROMPT, [
				{ name: "Read", file: "src/date.ts" },
				{ name: "Edit", file: "src/date.ts" },
				{ name: "Bash", command: "pnpm test" },
				{ name: "TodoWrite" },
			]),
		),
	);
	const codex = normalizeTrace(
		parseCodexEvents(
			codexEvents(PROMPT, [
				{ kind: "shell", command: "sed -n 1,120p src/date.ts" },
				{ kind: "patch", file: "src/date.ts" },
				{ kind: "exec-cell", command: "pnpm test" },
				{ kind: "plan" },
			]),
		),
	);
	assert.deepEqual(
		cc.map((s) => s.signature),
		["read:src/date.ts", "edit:src/date.ts", "test:pnpm test", "plan:"],
	);
	assert.deepEqual(
		codex.map((s) => s.signature),
		cc.map((s) => s.signature),
	);
});

test("a piped test run that exits 0 but reports failures counts as failed", () => {
	const steps = normalizeTrace(
		parseClaudeCodeEvents(
			ccEvents(PROMPT, [
				{ name: "Bash", command: "npm test 2>&1 | head -40", output: "ℹ tests 2\nℹ pass 1\nℹ fail 1" },
			]),
		),
	);
	assert.equal(steps[0]?.action, "test");
	assert.equal(steps[0]?.status, "error");
	assert.equal(steps[0]?.error, "output reports failing tests");
});

test("a whole-file Write over a file the run already read counts as an edit", () => {
	const steps = normalizeTrace(
		parseClaudeCodeEvents(
			ccEvents(PROMPT, [
				{ name: "Read", file: "src/date.ts" },
				{ name: "Write", file: "src/date.ts" },
				{ name: "Write", file: "src/fresh.ts" },
			]),
		),
	);
	assert.deepEqual(
		steps.map((s) => s.signature),
		["read:src/date.ts", "edit:src/date.ts", "write:src/fresh.ts"],
	);
});

test("failures, created files and guard trips carry through normalization", () => {
	const steps = normalizeTrace(
		parseClaudeCodeEvents(
			ccEvents(PROMPT, [
				{ name: "Write", file: "src/new.ts" },
				{ name: "Bash", command: "pnpm test", error: "Exit code 1\n1 failing" },
				{ name: "Bash", command: "curl example.invalid", error: "Blocked (egress-guard): no network" },
			]),
		),
	);
	assert.equal(steps[0]?.signature, "write:src/new.ts");
	assert.equal(steps[1]?.status, "error");
	assert.match(steps[1]?.error ?? "", /1 failing/);
	assert.equal(steps[2]?.action, "blocked");
	assert.equal(steps[2]?.target, "egress-guard: run");
});

test("Codex shell exit codes mark the normalized step as failed", () => {
	const steps = normalizeTrace(
		parseCodexEvents(
			codexEvents(PROMPT, [{ kind: "exec-cell", command: "pnpm test", exit: 1 }]),
		),
	);
	assert.equal(steps[0]?.action, "test");
	assert.equal(steps[0]?.status, "error");
});

// ---- alignment -----------------------------------------------------------

test("identical sequences align row for row", () => {
	const a = [step("read", "a"), step("edit", "a"), step("test", "t")];
	const { rows } = alignSteps(a, a);
	assert.deepEqual(rows.map((r) => r.relation), ["same", "same", "same"]);
});

test("an extra step shows up as a one-sided row, not a shifted mismatch", () => {
	const left = [step("read", "a"), step("edit", "a"), step("test", "t")];
	const right = [step("read", "a"), step("read", "b"), step("edit", "a"), step("test", "t")];
	const { rows } = alignSteps(left, right);
	assert.deepEqual(rows.map((r) => r.relation), ["same", "right-only", "same", "same"]);
});

test("the same verb on a different target pairs as changed; different verbs never pair", () => {
	const { rows } = alignSteps(
		[step("edit", "a"), step("test", "t")],
		[step("edit", "b"), step("run", "lint")],
	);
	assert.deepEqual(rows.map((r) => r.relation), ["changed", "left-only", "right-only"]);
});

test("a step that fails on only one side is flagged statusDiffers", () => {
	const { rows } = alignSteps([step("test", "t")], [step("test", "t", "error")]);
	assert.equal(rows[0]?.relation, "same");
	assert.equal(rows[0]?.statusDiffers, true);
});

// ---- ranking + explanation -----------------------------------------------

/**
 * The canonical scenario: Codex first reads an extra file (a cosmetic
 * difference), then patches the wrong module and its tests fail, while Claude
 * Code edits the right module and passes.
 */
function scenario() {
	const cc = parseClaudeCodeEvents(
		ccEvents(PROMPT, [
			{ name: "Read", file: "README.md" },
			{ name: "Grep", pattern: "parseDate" },
			{ name: "Read", file: "src/date.ts" },
			{ name: "Edit", file: "src/date.ts" },
			{ name: "Bash", command: "pnpm test" },
		]),
	);
	const codex = parseCodexEvents(
		codexEvents(PROMPT, [
			{ kind: "shell", command: "cat README.md" },
			{ kind: "shell", command: "cat package.json" },
			{ kind: "shell", command: "rg -n parseDate src" },
			{ kind: "shell", command: "sed -n 1,200p src/date.ts" },
			{ kind: "patch", file: "src/format.ts" },
			{ kind: "exec-cell", command: "pnpm test", exit: 1 },
		]),
	);
	return { cc, codex };
}

test("the ranker flags the fork that changed the outcome, not the first cosmetic difference", () => {
	const { cc, codex } = scenario();
	const diff = diffRuns(cc, codex);
	assert.equal(diff.left.label, "Claude Code");
	assert.equal(diff.right.label, "Codex");
	assert.equal(diff.left.verdict, "passed");
	assert.equal(diff.right.verdict, "failed");

	// First difference: Codex's extra `cat package.json`, a cosmetic read.
	const firstRow = diff.rows[diff.firstDifferenceRow ?? -1];
	assert.equal(firstRow?.relation, "right-only");
	assert.equal(firstRow?.right?.signature, "read:package.json");
	const firstBlock = diff.blocks.find((b) => b.startRow === diff.firstDifferenceRow);
	assert.equal(firstBlock?.cosmetic, true);

	// Flagged: the edit of a different file, from which the runs never recover.
	const flagged = diff.flagged;
	assert.ok(flagged);
	assert.notEqual(flagged.startRow, diff.firstDifferenceRow);
	const flaggedRow = diff.rows[flagged.startRow];
	assert.equal(flaggedRow?.left?.signature, "edit:src/date.ts");
	assert.equal(flaggedRow?.right?.signature, "edit:src/format.ts");
	assert.ok(flagged.reasons.includes("touches a file the other run never edits"));
	assert.ok(flagged.reasons.includes("hits an error the other run never does"));

	assert.match(diff.explanation, /Claude Code edited `src\/date\.ts`/);
	assert.match(diff.explanation, /Codex edited `src\/format\.ts`/);
	assert.match(diff.explanation, /Claude Code ended with passing tests while Codex ended with failing tests/);
	const sentences = diff.explanation.split(/(?<=\.)\s+(?=[A-Z])/);
	assert.ok(sentences.length <= 2, `expected at most two sentences: ${diff.explanation}`);
});

test("the same step failing on one side is explained as a one-sided failure", () => {
	const left = parseClaudeCodeEvents(
		ccEvents(PROMPT, [
			{ name: "Edit", file: "src/date.ts" },
			{ name: "Bash", command: "pnpm test" },
		]),
	);
	const right = parseClaudeCodeEvents(
		ccEvents(PROMPT, [
			{ name: "Edit", file: "src/date.ts" },
			{ name: "Bash", command: "pnpm test", error: "Exit code 1" },
		]),
	);
	const diff = diffRuns(left, right);
	assert.equal(diff.left.label, "Claude Code A");
	assert.equal(diff.right.label, "Claude Code B");
	assert.equal(diff.flagged?.startRow, 1);
	assert.match(diff.explanation, /both runs ran `pnpm test`, but it failed only for Claude Code B/);
});

test("when both runs end the same way, the fork is framed as an approach change", () => {
	const left = parseClaudeCodeEvents(
		ccEvents(PROMPT, [
			{ name: "Read", file: "src/date.ts" },
			{ name: "Edit", file: "src/date.ts" },
			{ name: "Bash", command: "pnpm test" },
		]),
	);
	const right = parseCodexEvents(
		codexEvents(PROMPT, [
			{ kind: "shell", command: "sed -n 1,80p src/date.ts" },
			{ kind: "patch", file: "src/date.ts" },
			{ kind: "patch", file: "src/date.test.ts" },
			{ kind: "shell", command: "pnpm test" },
		]),
	);
	const diff = diffRuns(left, right);
	assert.equal(diff.flagged?.startRow, 2);
	assert.match(diff.explanation, /Codex edited `src\/date\.test\.ts`/);
	assert.match(diff.explanation, /Both runs still ended with passing tests/);
});

test("step-identical runs flag nothing and say so", () => {
	const tools = [
		{ name: "Read", file: "src/date.ts" },
		{ name: "Bash", command: "pnpm test" },
	] as const;
	const diff = diffRuns(
		parseClaudeCodeEvents(ccEvents(PROMPT, [...tools])),
		parseClaudeCodeEvents(ccEvents(PROMPT, [...tools])),
	);
	assert.equal(diff.flagged, null);
	assert.equal(diff.firstDifferenceRow, null);
	assert.match(diff.explanation, /no divergence to flag/);
});

test("without tests, the harness completion signal decides the verdict", () => {
	const done = parseCodexEvents(codexEvents(PROMPT, [{ kind: "patch", file: "a.ts" }]));
	const stalled = parseCodexEvents(
		codexEvents(PROMPT, [{ kind: "patch", file: "a.ts" }, { kind: "shell", command: "git diff" }], {
			finished: false,
		}),
	);
	const diff = diffRuns(done, stalled);
	assert.equal(diff.left.verdict, "completed");
	assert.equal(diff.right.verdict, "unfinished");
	assert.match(diff.explanation, /ended reporting the task complete while Codex B ended without finishing/);
});

test("raw JSONL for both harnesses flows through the shared parseTranscript sniffer", () => {
	const { cc, codex } = scenario();
	const fromText = diffRuns(
		parseTranscript(toJsonl(ccEvents(PROMPT, [{ name: "Read", file: "README.md" }]))).trace,
		parseTranscript(toJsonl(codexEvents(PROMPT, [{ kind: "shell", command: "cat README.md" }]))).trace,
	);
	assert.equal(fromText.left.label, "Claude Code");
	assert.equal(fromText.right.label, "Codex");
	assert.equal(fromText.rows[0]?.relation, "same");
	// sanity: the scenario traces themselves parsed
	assert.ok(cc.steps.length > 0 && codex.steps.length > 0);
});

test("describeStep reads like a sentence fragment", () => {
	assert.equal(describeStep(step("test", "pnpm test", "error")), "ran `pnpm test`, which failed");
	assert.equal(describeStep(step("test", "pnpm test")), "ran `pnpm test`, which passed");
	assert.equal(describeStep(step("write", "src/new.ts")), "created `src/new.ts`");
	assert.equal(describeStep(step("plan", null)), "updated its plan");
});

// ---- review regressions: test detection and result attribution ------------

const sig = (cmd: string) =>
	classifyCommand(cmd, null).map((x) => `${x.action}:${x.target ?? `(${x.note})`}`);

test("test runners only count at the command position, never as file names or data", () => {
	assert.deepEqual(sig("sed -n 1,80p vitest.config.ts"), ["read:vitest.config.ts"]);
	assert.deepEqual(sig("cat jest.config.js"), ["read:jest.config.js"]);
	assert.deepEqual(sig("cat pytest.ini"), ["read:pytest.ini"]);
	assert.deepEqual(sig("rg -n jest src"), ["search:(rg)"]);
	assert.deepEqual(sig('rg "npm test" README.md'), ["search:(rg)"]);
	assert.deepEqual(sig('echo "run npm test"'), []);
	assert.deepEqual(sig("npx vitest run"), ["test:vitest"]);
	assert.deepEqual(sig("pnpm exec jest --ci"), ["test:jest"]);
	assert.deepEqual(sig("FORCE_COLOR=0 pnpm test"), ["test:pnpm test"]);
});

test("reading a test config after a failing test does not flip the verdict", () => {
	const trace = parseCodexEvents(
		codexEvents(PROMPT, [
			{ kind: "exec-cell", command: "pnpm test", exit: 1 },
			{ kind: "exec-cell", command: "sed -n 1,80p vitest.config.ts" },
		]),
	);
	const diff = diffRuns(trace, trace);
	assert.equal(diff.left.verdict, "failed");
});

test("a failed && chain without per-stage evidence leaves its commands unknown", () => {
	const parts = classifyCommand("npm test && npm run test:integration", null);
	assert.deepEqual(resolveStatuses(parts, "and", "error", false), ["unknown", "unknown"]);
	// Both stages are test runs, so failure output cannot say which one failed.
	assert.deepEqual(resolveStatuses(parts, "and", "error", true), ["unknown", "unknown"]);
	const one = classifyCommand("npm test && git status", null);
	assert.deepEqual(resolveStatuses(one, "and", "error", true), ["error", "unknown"]);
	const read = classifyCommand("cat a.ts && npm test && npm run build", null);
	assert.deepEqual(resolveStatuses(read, "and", "error", false), ["unknown", "unknown", "unknown"]);
	// A `;` chain exits with its last stage's status.
	const seq = classifyCommand("npm test; npm run lint", null);
	assert.deepEqual(resolveStatuses(seq, "seq", "error", false), ["unknown", "error"]);
});

test("an unattributable compound failure makes the verdict unclear, not passed", () => {
	const trace = parseClaudeCodeEvents(
		ccEvents(PROMPT, [
			{ name: "Bash", command: "npm test && npm run test:integration", error: "Exit code 1" },
		]),
	);
	const steps = normalizeTrace(trace);
	assert.deepEqual(steps.map((s) => s.status), ["unknown", "unknown"]);
	const diff = diffRuns(trace, trace);
	assert.equal(diff.left.verdict, "unclear");
	assert.match(diff.left.verdictReason, /no clear result/);
});

/** A Codex exec cell with explicit per-call chunks. */
function cellEvents(
	cells: Array<{ input: string; chunks: Array<Record<string, unknown>> }>,
): Record<string, unknown>[] {
	let t = 0;
	const ts = () => `2026-10-01T12:00:${String(t++).padStart(2, "0")}.000Z`;
	const out: Record<string, unknown>[] = [
		{ timestamp: ts(), type: "session_meta", payload: { id: "cells", cwd: WORKSPACE_CODEX } },
	];
	cells.forEach((cell, i) => {
		out.push(
			{
				timestamp: ts(),
				type: "response_item",
				payload: { type: "custom_tool_call", name: "exec", call_id: `k${i}`, status: "completed", input: cell.input },
			},
			{
				timestamp: ts(),
				type: "response_item",
				payload: {
					type: "custom_tool_call_output",
					call_id: `k${i}`,
					output: [
						{ type: "input_text", text: "Script completed\nOutput:\n" },
						...cell.chunks.map((c, j) => ({
							type: "input_text",
							text: JSON.stringify({ chunk_id: `k${i}-${j}`, output: "", ...c }),
						})),
					],
				},
			},
		);
	});
	return out;
}
const execCall = (cmd: string) => `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}));\n`;
const pollCall = (session: number) => `text(await tools.write_stdin({session_id:${session},chars:""}));\n`;

test("each call in an exec cell keeps its own exit code", () => {
	const steps = normalizeTrace(
		parseCodexEvents(
			cellEvents([
				{
					input: execCall("rg foo src") + execCall("pnpm test"),
					chunks: [{ exit_code: 1 }, { exit_code: 0, output: "ℹ pass 3\nℹ fail 0" }],
				},
			]),
		),
	);
	assert.deepEqual(
		steps.map((s) => `${s.action}:${s.status}`),
		["search:error", "test:ok"],
	);
});

test("a yielded test takes the result of the write_stdin poll that finishes it", () => {
	const run = (final: Record<string, unknown> | null) =>
		normalizeTrace(
			parseCodexEvents(
				cellEvents([
					{ input: execCall("pnpm test"), chunks: [{ session_id: 4242 }] },
					{ input: pollCall(4242), chunks: [{ session_id: 4242 }] },
					...(final ? [{ input: pollCall(4242), chunks: [final] }] : []),
				]),
			),
		).map((s) => `${s.action}:${s.status}`);
	assert.deepEqual(run({ exit_code: 1, output: "ℹ fail 2" }), ["test:error"]);
	assert.deepEqual(run({ exit_code: 0 }), ["test:ok"]);
	assert.deepEqual(run(null), ["test:unknown"]);
});

test("cosmetic-only forks never claim to explain different outcomes", () => {
	const done = parseCodexEvents(
		codexEvents(PROMPT, [{ kind: "shell", command: "cat README.md" }, { kind: "patch", file: "a.ts" }]),
	);
	const stalled = parseCodexEvents(
		codexEvents(PROMPT, [{ kind: "patch", file: "a.ts" }], { finished: false }),
	);
	const diff = diffRuns(done, stalled);
	assert.equal(diff.flagged?.cosmetic, true);
	assert.match(diff.explanation, /do not explain why Codex A ended reporting the task complete while Codex B ended without finishing/);
	assert.doesNotMatch(diff.explanation, /After this fork/);
});

// ---- review regressions, round 2 -------------------------------------------

test("a successful compound command only vouches for the stages it proves ran", () => {
	const mixed = classifyCommand("false && npm test || true", null);
	assert.deepEqual(resolveStatuses(mixed, "mixed", "ok", false), mixed.map(() => "unknown"));
	const seq = classifyCommand("npm test; git status", null);
	assert.deepEqual(resolveStatuses(seq, "seq", "ok", false), ["unknown", "ok"]);
	assert.deepEqual(resolveStatuses(seq, "seq", "ok", false, true), ["ok", "ok"]);
	// The exit status of `npm test; echo done` is echo's, even though echo is dropped.
	const trailing = classifyCommand("npm test; echo done", null);
	assert.deepEqual(resolveStatuses(trailing, "seq", "ok", false), ["unknown"]);
	assert.deepEqual(resolveStatuses(trailing, "seq", "ok", true), ["error"]);
	const and = classifyCommand("npm test && npm run build", null);
	assert.deepEqual(resolveStatuses(and, "and", "ok", false), ["ok", "ok"]);
	const piped = classifyCommand("npm test 2>&1 | tail -5", null);
	assert.equal(piped[0]?.piped, true);
	assert.deepEqual(resolveStatuses(piped, "single", "ok", false), ["unknown"]);
	assert.deepEqual(resolveStatuses(piped, "single", "ok", false, true), ["ok"]);
});

test("a mixed chain that exits 0 does not make the verdict passed", () => {
	const trace = parseClaudeCodeEvents(
		ccEvents(PROMPT, [{ name: "Bash", command: "false && npm test || true" }]),
	);
	assert.equal(diffRuns(trace, trace).left.verdict, "unclear");
});

test("test names are suites: run is optional, script names are kept", () => {
	assert.deepEqual(sig("pnpm run test"), ["test:pnpm test"]);
	assert.deepEqual(sig("npm run test:unit"), ["test:npm test:unit"]);
	assert.deepEqual(sig("npm run test-integration -- --ci"), ["test:npm test-integration"]);
});

/** One exec cell with a free-form output list. */
function rawCell(input: string, output: unknown, status = "completed") {
	return parseCodexEvents([
		{ timestamp: "2026-10-01T12:00:00.000Z", type: "session_meta", payload: { id: "raw", cwd: WORKSPACE_CODEX } },
		{
			timestamp: "2026-10-01T12:00:01.000Z",
			type: "response_item",
			payload: { type: "custom_tool_call", name: "exec", call_id: "z1", status, input },
		},
		{
			timestamp: "2026-10-01T12:00:02.000Z",
			type: "response_item",
			payload: { type: "custom_tool_call_output", call_id: "z1", output },
		},
	]);
}
const parts = (...texts: string[]) => texts.map((text) => ({ type: "input_text", text }));
const statusesOf = (trace: ReturnType<typeof rawCell>) =>
	normalizeTrace(trace).map((s) => `${s.action}:${s.status}`);

test("a cell that finished without printing a command's result leaves it unknown", () => {
	const trace = rawCell('await tools.exec_command({cmd:"npm test"});', parts("Script completed\nOutput:\n"));
	assert.deepEqual(statusesOf(trace), ["test:unknown"]);
	assert.equal(diffRuns(trace, trace).left.verdict, "unclear");
});

test("an aggregate printed by the cell is evidence of failure, not of which command", () => {
	const input =
		'text(await Promise.allSettled([tools.exec_command({cmd:"npm test"}), tools.exec_command({cmd:"git status"})]));';
	const trace = rawCell(
		input,
		parts("Script completed\nOutput:\n", JSON.stringify([{ status: "fulfilled", value: { exit_code: 1 } }, { status: "fulfilled", value: { exit_code: 0 } }])),
	);
	assert.equal(trace.steps[0]?.status, "error");
	assert.deepEqual(statusesOf(trace), ["test:unknown", "read:unknown"]);
	assert.equal(diffRuns(trace, trace).left.verdict, "unclear");
});

test("chunks are not matched by position when the cell prints out of call order", () => {
	const input =
		'const a = await tools.exec_command({cmd:"npm test"});\nconst b = await tools.exec_command({cmd:"git status"});\ntext(b);\ntext(a);';
	const trace = rawCell(
		input,
		parts("Script completed\n", JSON.stringify({ chunk_id: "1", exit_code: 0 }), JSON.stringify({ chunk_id: "2", exit_code: 1 })),
	);
	assert.deepEqual(statusesOf(trace), ["test:unknown", "read:unknown"]);
	// Printed right after each await, the same calls map by position.
	const inOrder = rawCell(
		'const a = await tools.exec_command({cmd:"npm test"});\ntext(a);\nconst b = await tools.exec_command({cmd:"git status"});\ntext(b);',
		parts("Script completed\n", JSON.stringify({ chunk_id: "1", exit_code: 1 }), JSON.stringify({ chunk_id: "2", exit_code: 0 })),
	);
	assert.deepEqual(statusesOf(inOrder), ["test:error", "read:ok"]);
});

test("single-quoted and static template commands are read; dynamic ones stay visible", () => {
	const chunk = (code: number) => parts("Script completed\n", JSON.stringify({ chunk_id: "1", exit_code: code }));
	const single = rawCell("text(await tools.exec_command({cmd:'npm test'}));", chunk(1));
	assert.deepEqual(statusesOf(single), ["test:error"]);
	assert.equal(diffRuns(single, single).left.verdict, "failed");
	const template = rawCell("text(await tools.exec_command({cmd:`npm test`}));", chunk(0));
	assert.deepEqual(statusesOf(template), ["test:ok"]);
	const dynamic = rawCell("text(await tools.exec_command({cmd:`npm test ${x}`}));", chunk(1));
	const steps = normalizeTrace(dynamic);
	assert.equal(steps[0]?.action, "run");
	assert.equal(steps[0]?.note, "unparsed command");
	assert.equal(steps[0]?.status, "error");
});

test("a failed cell whose only call is a patch records a failed edit", () => {
	const trace = rawCell(
		`text(await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Update File: ${WORKSPACE_CODEX}/src/a.ts\n*** End Patch`)}));`,
		parts("Script failed\nError: patch rejected"),
		"failed",
	);
	assert.deepEqual(statusesOf(trace), ["edit:error"]);
});

test("a chunk's exit code wins even when its output quotes a legacy exit header", () => {
	const trace = rawCell(
		'text(await tools.exec_command({cmd:"npm test"}));',
		parts("Script completed\n", JSON.stringify({ chunk_id: "1", exit_code: 1, output: "Process exited with code 0" })),
	);
	assert.equal(trace.steps[0]?.status, "error");
	assert.deepEqual(statusesOf(trace), ["test:error"]);
});

test("test summaries are read from summary lines, not from test names or logs", () => {
	const passing = "✔ marks 2 failed uploads as retryable (1ms)\nretry: 1 failed attempt\nℹ tests 4\nℹ pass 4\nℹ fail 0";
	assert.equal(hasTestFailures(passing), false);
	assert.equal(hasTestPasses(passing), true);
	assert.equal(hasTestFailures("ℹ tests 4\nℹ pass 3\nℹ fail 1"), true);
	assert.equal(hasTestFailures("===== 1 failed, 3 passed in 0.2s ====="), true);
	assert.equal(hasTestPasses("===== 4 passed in 0.2s ====="), true);
	assert.equal(hasTestFailures(" Tests  1 failed | 3 passed (4)"), true);
});

test("fit keeps the table under the cap and trims the long run first", () => {
	const short = Array.from({ length: 3 }, (_, i) => i);
	const long = Array.from({ length: 1000 }, (_, i) => i);
	const [a, b] = fit(short, long, 400);
	assert.equal(a.length, 3);
	assert.ok((a.length + 1) * (b.length + 1) <= 400);
	const [c, d] = fit(long, long, 400);
	assert.ok((c.length + 1) * (d.length + 1) <= 400);
	const [e, f] = fit([1], Array.from({ length: 5000 }, (_, i) => i), 1000);
	assert.ok((e.length + 1) * (f.length + 1) <= 1000);
});
