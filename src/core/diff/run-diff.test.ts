import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTranscript } from "../parse.ts";
import { parseClaudeCodeEvents } from "../parsers/claude-code.ts";
import { parseCodexEvents } from "../parsers/codex.ts";
import { alignSteps } from "./align.ts";
import {
	ccEvents,
	codexEvents,
	toJsonl,
	WORKSPACE_CC,
	WORKSPACE_CODEX,
} from "./fixtures.ts";
import { classifyCommand, normalizeTrace, relPath } from "./normalize.ts";
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
					{ type: "input_text", text: '{"exit_code":1,"output":"\\u2139 fail 1\\n"}' },
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
