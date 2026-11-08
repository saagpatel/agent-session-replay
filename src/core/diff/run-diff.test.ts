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
	assert.deepEqual(c("git commit -m x"), ["run:git commit -m x"]);
	// sed -i edits in place; it is not a read
	assert.deepEqual(c("sed -i 's/a/b/' src/date.ts"), ["run:sed -i s/a/b/ src/date.ts"]);
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
	assert.deepEqual(c("python3 - <<'PY'\nimport os; os.remove('x')\nPY"), ["run:python3 -"]);
});

test("stage splitting respects quotes", () => {
	assert.deepEqual(
		classifyCommand(`node -e "const a = 1; console.log(a)"; git status`, null).map((x) => `${x.action}:${x.target}`),
		["run:node -e const a = 1; console.log(a)", "read:git status"],
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
	const input = `text(await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Update File: ${WORKSPACE_CODEX}/src/date.ts\n@@\n-a\n+b\n*** End Patch`)}));\ntext(await tools.exec_command({"cmd":"npm test","max_output_tokens":2000}));`;
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
	assert.equal(describeStep(step("test", "pnpm test")), "ran `pnpm test`, which exited cleanly");
	assert.equal(describeStep({ ...step("test", "pnpm test"), summary: "pass" }), "ran `pnpm test`, which passed");
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
	// Failure output in a compound command could come from any stage.
	assert.deepEqual(resolveStatuses(one, "and", "error", true), ["unknown", "unknown"]);
	// Only a test run that is the whole command owns its summary.
	assert.deepEqual(resolveStatuses(classifyCommand("npm test", null), "single", "ok", true, true), ["error"]);
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
	// The exit status of `npm test; echo done` is echo's, even though echo is dropped.
	const trailing = classifyCommand("npm test; echo done", null);
	assert.deepEqual(resolveStatuses(trailing, "seq", "ok", false), ["unknown"]);
	assert.deepEqual(resolveStatuses(trailing, "seq", "ok", true), ["unknown"]);
	const and = classifyCommand("npm test && npm run build", null);
	assert.deepEqual(resolveStatuses(and, "and", "ok", false), ["ok", "ok"]);
	const piped = classifyCommand("npm test 2>&1 | tail -5", null);
	assert.equal(piped[0]?.piped, true);
	assert.deepEqual(resolveStatuses(piped, "single", "ok", false), ["unknown"]);
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

// ---- review regressions, round 3 -------------------------------------------

test("a passing summary never overrides a known failing exit", () => {
	const t = classifyCommand("pnpm test", null);
	assert.deepEqual(resolveStatuses(t, "single", "error", false), ["error"]);
	assert.deepEqual(resolveStatuses(t, "single", "interrupted", false), ["interrupted"]);
	const trace = parseClaudeCodeEvents(
		ccEvents(PROMPT, [
			{ name: "Bash", command: "pnpm test", error: "Tests  10 passed (10)\nERROR: Coverage for lines (60%) does not meet threshold (80%)" },
		]),
	);
	assert.equal(diffRuns(trace, trace).left.verdict, "failed");
});

test("a call whose result never arrived is unknown, in both harnesses", () => {
	const cc = parseClaudeCodeEvents(ccEvents(PROMPT, [{ name: "Bash", command: "npm test" }]).slice(0, 2));
	assert.deepEqual(normalizeTrace(cc).map((s) => `${s.action}:${s.status}`), ["test:unknown"]);
	assert.equal(diffRuns(cc, cc).left.verdict, "unclear");
	const codex = parseCodexEvents(
		codexEvents(PROMPT, [{ kind: "shell", command: "npm test" }]).slice(0, 4),
	);
	assert.deepEqual(normalizeTrace(codex).map((s) => `${s.action}:${s.status}`), ["test:unknown"]);
	assert.equal(diffRuns(codex, codex).left.verdict, "unclear");
});

test("every line of a script counts, heredoc bodies never do", () => {
	assert.deepEqual(sig("npm test\nprintf done"), ["test:npm test"]);
	const trailing = classifyCommand("npm test\nprintf done", null);
	// printf decides the exit status, so the test's own result is unknown.
	assert.deepEqual(resolveStatuses(trailing, "seq", "ok", false), ["unknown"]);
	assert.deepEqual(sig("# setup\nnpm ci\n\nnpm test"), ["run:npm ci", "test:npm test"]);
	assert.deepEqual(
		sig("python3 - <<'PY'\nimport os\nos.system('npm test')\nPY\ngit status"),
		["run:python3 -", "read:git status"],
	);
	assert.deepEqual(sig("cat a.ts \\\n  b.ts && npm test"), ["read:a.ts", "read:b.ts", "test:npm test"]);
	const trace = parseClaudeCodeEvents(
		ccEvents(PROMPT, [{ name: "Bash", command: "npm test\nprintf done" }]),
	);
	assert.equal(diffRuns(trace, trace).left.verdict, "unclear");
});

test("shell control flow never hands its exit status to one stage", () => {
	assert.deepEqual(sig("for f in a b; do npm test; done"), ["test:npm test"]);
	assert.deepEqual(sig("if npm test; then echo ok; fi"), ["test:npm test"]);
	const trace = parseClaudeCodeEvents(
		ccEvents(PROMPT, [{ name: "Bash", command: "if npm test; then echo ok; fi" }]),
	);
	assert.deepEqual(normalizeTrace(trace).map((s) => s.status), ["unknown"]);
});

test("JSON a cell prints as data is not a failed command", () => {
	const trace = rawCell(
		'const r = JSON.parse(await tools.exec_command({cmd:"cat report.json"})); text(JSON.stringify(r));',
		parts("Script completed\n", JSON.stringify({ exit_code: 1, note: "fixture data" })),
	);
	assert.equal(trace.steps[0]?.status, "ok");
});

test("test evidence from an intermediate poll survives the final one", () => {
	const steps = normalizeTrace(
		parseCodexEvents(
			cellEvents([
				{ input: execCall("npm test | cat"), chunks: [{ session_id: 7 }] },
				{ input: pollCall(7), chunks: [{ session_id: 7, output: "ℹ tests 3\nℹ pass 2\nℹ fail 1" }] },
				{ input: pollCall(7), chunks: [{ exit_code: 0 }] },
			]),
		),
	);
	assert.deepEqual(steps.map((s) => `${s.action}:${s.status}`), ["test:error"]);
});

test("a one-sided call with no recorded result cannot headline the diff", () => {
	const tools = [
		{ name: "Edit", file: "src/a.ts" },
		{ name: "Bash", command: "npm test" },
	] as const;
	const left = parseClaudeCodeEvents(ccEvents(PROMPT, [...tools]));
	// The right run also issued a test call whose result never came back.
	const events = ccEvents(PROMPT, [{ name: "Bash", command: "npm run lint" }, ...tools]);
	const right = parseClaudeCodeEvents(events.filter((e) => e["uuid"] !== "r0"));
	const diff = diffRuns(left, right);
	assert.equal(diff.flagged?.cosmetic, true);
});

// ---- simplified verdict ------------------------------------------------------

test("passed needs both a clean exit and the runner's passing summary", () => {
	const verdict = (command: string, output?: string, error?: string) => {
		const trace = parseClaudeCodeEvents(
			ccEvents(PROMPT, [{ name: "Bash", command, ...(output ? { output } : {}), ...(error ? { error } : {}) }]),
		);
		return diffRuns(trace, trace).left;
	};
	assert.equal(verdict("npm test", "ℹ tests 2\nℹ pass 2\nℹ fail 0").verdict, "passed");
	// Clean exit, no summary.
	const quiet = verdict("npm test", "done");
	assert.equal(quiet.verdict, "unclear");
	assert.match(quiet.verdictReason, /no passing summary/);
	// Passing summary, but the exit belongs to `tail`.
	const piped = verdict("npm test | tail -3", "ℹ tests 2\nℹ pass 2\nℹ fail 0");
	assert.equal(piped.verdict, "unclear");
	assert.match(piped.verdictReason, /exit status is unknown/);
	// A failing summary or a failing exit is enough to fail.
	assert.equal(verdict("npm test | tail -3", "ℹ tests 2\nℹ pass 1\nℹ fail 1").verdict, "failed");
	assert.equal(verdict("npm test", undefined, "Exit code 1").verdict, "failed");
});

// ---- review regressions, round 4 -------------------------------------------

/** A plain-format Codex function call and its string output. */
function plainCalls(calls: Array<{ name: string; args: Record<string, unknown>; output: string }>) {
	let t = 0;
	const ts = () => `2026-10-01T13:00:${String(t++).padStart(2, "0")}.000Z`;
	return parseCodexEvents([
		{ timestamp: ts(), type: "session_meta", payload: { id: "plain", cwd: WORKSPACE_CODEX } },
		...calls.flatMap((c, i) => [
			{
				timestamp: ts(),
				type: "response_item",
				payload: { type: "function_call", name: c.name, call_id: `p${i}`, arguments: JSON.stringify(c.args) },
			},
			{ timestamp: ts(), type: "response_item", payload: { type: "function_call_output", call_id: `p${i}`, output: c.output } },
		]),
	]);
}

test("a yielded plain-format command is settled by its write_stdin poll", () => {
	const yielded = { name: "exec_command", args: { cmd: "pnpm test" }, output: "Wall time: 10s\nProcess running with session ID 123\nOutput:\n" };
	const failing = plainCalls([
		yielded,
		{ name: "write_stdin", args: { session_id: 123, chars: "" }, output: "Process exited with code 1\nOutput:\nℹ tests 2\nℹ pass 1\nℹ fail 1" },
	]);
	assert.deepEqual(normalizeTrace(failing).map((s) => `${s.action}:${s.status}`), ["test:error"]);
	assert.equal(diffRuns(failing, failing).left.verdict, "failed");
	const passing = plainCalls([
		yielded,
		{ name: "write_stdin", args: { session_id: 123, chars: "" }, output: "Process exited with code 0\nOutput:\nℹ tests 2\nℹ pass 2\nℹ fail 0" },
	]);
	assert.equal(diffRuns(passing, passing).left.verdict, "passed");
	const never = plainCalls([yielded]);
	assert.deepEqual(normalizeTrace(never).map((s) => s.status), ["unknown"]);
	assert.equal(diffRuns(never, never).left.verdict, "unclear");
});

test("the stage cap never drops a test run or the final stage", () => {
	const cmd = "npm test; git status; git diff; cat a; cat b; cat c; npm run test:integration";
	assert.deepEqual(sig(cmd).at(-1), "test:npm test:integration");
	const trace = parseClaudeCodeEvents(ccEvents(PROMPT, [{ name: "Bash", command: cmd, error: "Exit code 1" }]));
	assert.equal(diffRuns(trace, trace).left.verdict, "failed");
});

test("a fan-out cell's passing summary cannot make an unattributed test pass", () => {
	const input =
		'const [t, g] = await Promise.all([tools.exec_command({cmd:"npm test"}), tools.exec_command({cmd:"git status"})]); text(t); text(g);';
	const trace = rawCell(
		input,
		parts(
			"Script completed\n",
			JSON.stringify({ chunk_id: "1", exit_code: 1, output: "Tests  4 passed (4)\nERROR: coverage below threshold" }),
			JSON.stringify({ chunk_id: "2", exit_code: 0 }),
		),
	);
	assert.equal(trace.steps[0]?.status, "error");
	assert.notEqual(diffRuns(trace, trace).left.verdict, "passed");
});

test("TAP and here-strings are read correctly", () => {
	assert.equal(hasTestFailures("ok 1 - a\nnot ok 2 - b"), true);
	assert.equal(hasTestPasses("ok 1 - a\nok 2 - b"), false);
	assert.equal(hasTestPasses("ok  \texample.com/pkg\t0.012s"), true);
	assert.deepEqual(sig('grep foo <<< "bar"\nnpm test'), ["search:(grep)", "test:npm test"]);
	assert.deepEqual(sig('echo "<<EOF"\nnpm test'), ["test:npm test"]);
	assert.deepEqual(sig("cat <<EOF > notes.md\nnpm test\nEOF\ngit status"), ["write:notes.md", "read:git status"]);
	assert.deepEqual(sig("cat > src/a.ts <<'EOF'\nx\nEOF"), ["write:src/a.ts"]);
	assert.deepEqual(sig("echo done >> log.txt; npm test 2>&1 >/dev/null"), ["write:log.txt", "test:npm test"]);
	assert.deepEqual(sig("cat a.ts 2>/dev/null"), ["read:a.ts"]);
});

test("an all-cosmetic diff points at where its first difference starts", () => {
	const left = parseClaudeCodeEvents(ccEvents(PROMPT, [{ name: "Edit", file: "a.ts" }]));
	const right = parseClaudeCodeEvents(
		ccEvents(PROMPT, [{ name: "Read", file: "README.md" }, { name: "TodoWrite" }, { name: "Edit", file: "a.ts" }]),
	);
	const diff = diffRuns(left, right);
	assert.equal(diff.flagged?.cosmetic, true);
	assert.match(diff.explanation, /^At row 1 Claude Code B read `README\.md`/);
});

// ---- review regressions, round 5 -------------------------------------------

test("an edit with no recorded result cannot headline over a completed fork", () => {
	const left = parseClaudeCodeEvents(
		ccEvents(PROMPT, [
			{ name: "Bash", command: "npm run build" },
			{ name: "Edit", file: "src/a.ts" },
		]).filter((e) => e["uuid"] !== "r1"),
	);
	const right = parseClaudeCodeEvents(ccEvents(PROMPT, []));
	const diff = diffRuns(left, right);
	const pivot = diff.rows[diff.flagged?.pivotRow ?? -1];
	assert.equal(pivot?.left?.signature, "run:npm run build");
	assert.ok(!diff.flagged?.reasons.includes("touches a file the other run never edits"));
	assert.equal(
		describeStep({ ...step("edit", "src/a.ts"), status: "unknown" }),
		"tried to edit `src/a.ts` (no result recorded)",
	);
});

test("file targets resolve against the command's working directory", () => {
	const root = WORKSPACE_CODEX;
	const at = (cmd: string, workdir?: string) =>
		normalizeTrace(
			plainCalls([{ name: "exec_command", args: { cmd, ...(workdir ? { workdir } : {}) }, output: "Process exited with code 0\nOutput:\nx" }]),
		).map((s) => s.signature);
	assert.deepEqual(at("cat src/a.ts", `${root}/packages/api`), ["read:packages/api/src/a.ts"]);
	assert.deepEqual(at("cat src/a.ts", "packages/api"), ["read:packages/api/src/a.ts"]);
	assert.deepEqual(at("cd packages/api && cat src/a.ts"), ["read:packages/api/src/a.ts"]);
	assert.deepEqual(at("cat src/a.ts; cd packages/web; cat src/a.ts"), ["read:src/a.ts", "read:packages/web/src/a.ts"]);
	assert.deepEqual(at("cd packages/api && cat ../web/src/a.ts > ../web/out.txt"), ["write:packages/web/out.txt"]);
	assert.deepEqual(at("cat src/a.ts"), ["read:src/a.ts"]);
	// An exec cell's static workdir argument counts too.
	const cell = rawCell(
		`text(await tools.exec_command({cmd:"cat src/a.ts", workdir:"${root}/packages/api"}));`,
		parts("Script completed\n", JSON.stringify({ chunk_id: "1", exit_code: 0 })),
	);
	assert.deepEqual(normalizeTrace(cell).map((s) => s.signature), ["read:packages/api/src/a.ts"]);
});

test("git branch is a read only when it lists", () => {
	assert.deepEqual(sig("git branch"), ["read:git branch"]);
	assert.deepEqual(sig("git branch -a"), ["read:git branch"]);
	assert.deepEqual(sig("git branch --show-current"), ["read:git branch"]);
	assert.deepEqual(sig("git branch -D feature"), ["run:git branch -D feature"]);
	assert.deepEqual(sig("git branch -m renamed"), ["run:git branch -m renamed"]);
	assert.deepEqual(sig("git branch new-work"), ["run:git branch new-work"]);
});

test("only unquoted redirects write files", () => {
	assert.deepEqual(sig('echo "==> Building"'), []);
	assert.deepEqual(sig("printf 'a > b'"), []);
	assert.deepEqual(sig('echo "x" > out.txt'), ["write:out.txt"]);
	assert.deepEqual(sig("echo x >>log.txt"), ["write:log.txt"]);
	assert.deepEqual(sig('echo "a | tee b"'), []);
	assert.deepEqual(sig("npm run build | tee build.log"), ["run:npm run build", "write:build.log"]);
	assert.deepEqual(sig("npm test 2>&1 | tee test.log"), ["test:npm test", "write:test.log"]);
});

// ---- review regressions, round 6: narrowed evidence --------------------------

test("a finished cell vouches only for patches it certainly reached", () => {
	// A static JS string literal (the cell source is parsed, never run).
	const patch = String.raw`"*** Begin Patch\n*** Update File: /work/b/fixture-repo/src/a.ts\n@@\n-{}\n+{ x }\n*** End Patch"`;
	const done = parts("Script completed\n", "{}");
	const at = (input: string) => statusesOf(rawCell(input, done));
	assert.deepEqual(at(`text(await tools.apply_patch(${patch}));`), ["edit:ok"]);
	assert.deepEqual(at(`if (false) { await tools.apply_patch(${patch}); }`), ["edit:unknown"]);
	assert.deepEqual(at(`if (ready)\n  await tools.apply_patch(${patch});`), ["edit:unknown"]);
	assert.deepEqual(at(`try { await tools.apply_patch(${patch}); } catch (e) { text(e); }`), ["edit:unknown"]);
	assert.deepEqual(at(`const later = async () => { await tools.apply_patch(${patch}); };`), ["edit:unknown"]);
	// A brace inside the patch text is data, not a block.
	assert.deepEqual(at(`const p = "{"; text(await tools.apply_patch(${patch}));`), ["edit:ok"]);
});

test("a summary speaks for a test only when the test is the whole command", () => {
	const stale = "ℹ tests 3\nℹ pass 2\nℹ fail 1\n\nℹ tests 3\nℹ pass 3\nℹ fail 0";
	const trace = parseClaudeCodeEvents(
		ccEvents(PROMPT, [{ name: "Bash", command: "cat old-test.log; npm test", output: stale }]),
	);
	const steps = normalizeTrace(trace);
	assert.deepEqual(steps.map((s) => `${s.action}:${s.status}:${s.summary ?? "-"}`), ["read:ok:-", "test:ok:-"]);
	assert.equal(diffRuns(trace, trace).left.verdict, "unclear");
	const codex = plainCalls([
		{ name: "exec_command", args: { cmd: "cat old-test.log && npm test" }, output: `Process exited with code 0\nOutput:\n${stale}` },
	]);
	assert.notEqual(diffRuns(codex, codex).left.verdict, "failed");
});

test("a leading cd stays a dependency of the command after it", () => {
	const failedCd = parseClaudeCodeEvents(
		ccEvents(PROMPT, [{ name: "Bash", command: "cd missing-dir && npm test", error: "cd: no such file or directory" }]),
	);
	assert.deepEqual(normalizeTrace(failedCd).map((s) => s.status), ["unknown"]);
	assert.equal(diffRuns(failedCd, failedCd).left.verdict, "unclear");
	// The cd prints nothing, so the test still owns its own failing summary.
	const failedTest = parseClaudeCodeEvents(
		ccEvents(PROMPT, [{ name: "Bash", command: "cd pkg && npm test", error: "ℹ tests 2\nℹ pass 1\nℹ fail 1" }]),
	);
	assert.equal(diffRuns(failedTest, failedTest).left.verdict, "failed");
	const passed = parseClaudeCodeEvents(
		ccEvents(PROMPT, [{ name: "Bash", command: "cd pkg && npm test", output: "ℹ tests 2\nℹ pass 2\nℹ fail 0" }]),
	);
	assert.equal(diffRuns(passed, passed).left.verdict, "passed");
});

test("passed and completed rest on different evidence and are not a proven difference", () => {
	const tested = parseClaudeCodeEvents(ccEvents(PROMPT, [{ name: "Edit", file: "a.ts" }, { name: "Bash", command: "npm test" }]));
	const untested = parseCodexEvents(codexEvents(PROMPT, [{ kind: "patch", file: "a.ts" }]));
	const diff = diffRuns(tested, untested);
	assert.equal(diff.left.verdict, "passed");
	assert.equal(diff.right.verdict, "completed");
	assert.ok(!diff.flagged?.reasons.includes("comes before the different outcomes"));
	assert.match(diff.explanation, /rest on different evidence, so this (fork|difference) is not proven/);
});

test("two unclear runs never claim the outcome was unchanged", () => {
	const left = parseClaudeCodeEvents(ccEvents(PROMPT, [{ name: "Edit", file: "a.ts" }, { name: "Bash", command: "npm test | tail" }]));
	const right = parseClaudeCodeEvents(ccEvents(PROMPT, [{ name: "Edit", file: "b.ts" }, { name: "Bash", command: "npm test | tail" }]));
	const diff = diffRuns(left, right);
	assert.equal(diff.left.verdict, "unclear");
	assert.match(diff.explanation, /whether it changed the outcome is unknown/);
});

// ---- round 7: fail closed --------------------------------------------------

test("script and tool commands keep their full text as the target", () => {
	assert.deepEqual(sig("npm run build"), ["run:npm run build"]);
	assert.deepEqual(sig("npm run lint"), ["run:npm run lint"]);
	assert.deepEqual(sig("npx tsc --noEmit"), ["run:npx tsc --noEmit"]);
	assert.deepEqual(sig("npx eslint ."), ["run:npx eslint ."]);
	assert.deepEqual(sig("FORCE=1 npm run build 2>&1"), ["run:npm run build"]);
});

test("comments and strings in an exec cell are never read as calls", () => {
	const done = parts("Script completed\n");
	const commented = rawCell('// await tools.apply_patch("*** Update File: src/a.ts");\nconst x = 1;', done);
	assert.ok(normalizeTrace(commented).every((s) => s.action !== "edit"));
	const inString = rawCell('const note = "text(await tools.exec_command({cmd:\\"npm test\\"}))";', done);
	assert.ok(normalizeTrace(inString).every((s) => s.action !== "test"));
	const blockComment = rawCell('/* tools.apply_patch("x") */ text(await tools.exec_command({cmd:"git status"}));', parts("Script completed\n", JSON.stringify({ chunk_id: "1", exit_code: 0 })));
	assert.deepEqual(statusesOf(blockComment), ["read:ok"]);
});

test("any cell that is not straight-line keeps its calls but marks them unknown", () => {
	const patch = JSON.stringify(`*** Begin Patch\n*** Update File: ${WORKSPACE_CODEX}/src/a.ts\n*** End Patch`);
	const chunk = JSON.stringify({ chunk_id: "1", exit_code: 0, output: "ℹ tests 1\nℹ pass 1\nℹ fail 0" });
	// A rejected patch inside allSettled still completes the cell.
	const settled = rawCell(
		`text(await Promise.allSettled([tools.apply_patch(${patch})]));`,
		parts("Script completed\n", JSON.stringify([{ status: "rejected", reason: "patch failed" }])),
	);
	assert.deepEqual(statusesOf(settled), ["edit:unknown"]);
	// Branches, unprinted results and extra prints all fail closed.
	assert.deepEqual(statusesOf(rawCell(`if (ok) { text(await tools.exec_command({cmd:"npm test"})); }`, parts("Script completed\n", chunk))), ["test:unknown"]);
	assert.deepEqual(statusesOf(rawCell(`await tools.apply_patch(${patch});`, parts("Script completed\n"))), ["edit:unknown"]);
	assert.deepEqual(
		statusesOf(rawCell(`text("start");\ntext(await tools.exec_command({cmd:"npm test"}));`, parts("Script completed\n", "start", chunk))),
		["test:unknown"],
	);
	// The same calls, straight-line and each printed once, are read.
	assert.deepEqual(
		statusesOf(rawCell(`text(await tools.apply_patch(${patch}));\ntext(await tools.exec_command({cmd:"npm test"}));`, parts("Script completed\n", "{}", chunk))),
		["edit:ok", "test:ok"],
	);
});

test("a patch counts as applied only when its own output confirms it", () => {
	const patchCall = (output: string) =>
		normalizeTrace(
			parseCodexEvents([
				{ timestamp: "2026-10-01T14:00:00.000Z", type: "session_meta", payload: { id: "p", cwd: WORKSPACE_CODEX } },
				{
					timestamp: "2026-10-01T14:00:01.000Z",
					type: "response_item",
					payload: { type: "custom_tool_call", name: "apply_patch", call_id: "a1", status: "completed", input: `*** Begin Patch\n*** Update File: ${WORKSPACE_CODEX}/a.ts\n*** End Patch` },
				},
				{ timestamp: "2026-10-01T14:00:02.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "a1", output } },
			]),
		).map((s) => `${s.action}:${s.status}`);
	assert.deepEqual(patchCall("Success. Updated the following files:\nM a.ts"), ["edit:ok"]);
	assert.deepEqual(patchCall(""), ["edit:unknown"]);
	assert.deepEqual(patchCall("Process exited with code 1\nOutput:\nerror: hunk failed"), ["edit:error"]);
});

test("test summary detection stays linear on long blank runs", () => {
	const big = `x${"\n".repeat(200_000)}${" ".repeat(200_000)}y`;
	const start = Date.now();
	hasTestFailures(big);
	hasTestPasses(big);
	assert.ok(Date.now() - start < 500, "summary regexes must not backtrack across lines");
});

// ---- #112: exact signatures ------------------------------------------------

test("long targets keep their full text in the signature (#112 item 2)", () => {
	const deep = (leaf: string) => `src/${"very-long-directory-name/".repeat(4)}${leaf}.ts`;
	const left = parseClaudeCodeEvents(ccEvents(PROMPT, [{ name: "Edit", file: deep("alpha") }]));
	const right = parseClaudeCodeEvents(ccEvents(PROMPT, [{ name: "Edit", file: deep("beta") }]));
	const [a] = normalizeTrace(left);
	const [b] = normalizeTrace(right);
	assert.ok((a?.target ?? "").length > 80);
	assert.notEqual(a?.signature, b?.signature);
	const diff = diffRuns(left, right);
	assert.notEqual(diff.flagged, null);
	assert.ok(diff.flagged?.reasons.includes("touches a file the other run never edits"));
	// Labels and explanations stay readable.
	assert.ok((a?.label.length ?? 0) <= 90);
	assert.ok(diff.explanation.includes("…"));
});

test("sed that edits in place is a command, never a read (#112 item 5)", () => {
	assert.deepEqual(sig("sed --in-place 's/a/b/' src/a.ts"), ["run:sed --in-place s/a/b/ src/a.ts"]);
	assert.deepEqual(sig("sed -i.bak 's/a/b/' src/a.ts"), ["run:sed -i.bak s/a/b/ src/a.ts"]);
	assert.deepEqual(sig("sed -Ei 's/a/b/' src/a.ts"), ["run:sed -Ei s/a/b/ src/a.ts"]);
	assert.deepEqual(sig("sed -n 1,20p src/a.ts"), ["read:src/a.ts"]);
	assert.deepEqual(sig("sed -E -n 's/a/b/p' src/a.ts"), ["read:src/a.ts"]);
	// Option arguments are not flags: an `i` inside them is not in-place.
	assert.deepEqual(sig("sed -fscript.sed src/a.ts"), ["read:script.sed", "read:src/a.ts"]);
	assert.deepEqual(sig("sed -f script.sed src/a.ts"), ["read:script.sed", "read:src/a.ts"]);
	assert.deepEqual(sig("sed -eicmd src/a.ts"), ["read:src/a.ts"]);
	assert.deepEqual(sig("sed -n -e 'i\\x' src/a.ts"), ["read:src/a.ts"]);
	assert.deepEqual(sig("sed --expression=p -i src/a.ts"), ["run:sed --expression=p -i src/a.ts"]);
});

test("a spaced redirect's target never leaks into the command (#112 item 6)", () => {
	assert.deepEqual(sig("npm run build > build.log"), ["run:npm run build"]);
	assert.deepEqual(sig("npm run build 2> err.log"), ["run:npm run build"]);
	assert.deepEqual(sig("npm run build >> build.log 2>&1"), ["run:npm run build"]);
	assert.deepEqual(sig("npm run build 2>&1"), ["run:npm run build"]);
	assert.deepEqual(sig("head -5 src/a.ts > top.txt"), ["read:src/a.ts"]);
	assert.deepEqual(sig("sort < input.txt"), ["run:sort"]);
	// A read keeps the file on its stdin.
	assert.deepEqual(sig("cat < src/a.ts"), ["read:src/a.ts"]);
	assert.deepEqual(sig("sed -n 1,20p < src/a.ts"), ["read:src/a.ts"]);
	assert.deepEqual(sig("cat <<EOF > notes.md\nx\nEOF"), ["write:notes.md"]);
	// A quoted ">" is data, not a redirect.
	assert.deepEqual(sig('node -e "1 > 0" x.js'), ["run:node -e 1 > 0 x.js"]);
});
