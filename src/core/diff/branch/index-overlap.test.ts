import assert from "node:assert/strict";
import test from "node:test";
import { ATTR, type Step, type Trace } from "../../types.ts";
import { checkArtifacts } from "./artifact-check.ts";
import { fixtureRepoCommitShas } from "./git-sha.ts";
import { buildBranchGraph } from "./model.ts";

const file = "src/a.ts";
const other = "src/b.ts";
const time = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const tool = (id: string, name: string, args: Record<string, unknown>, start: number, end: number | null): Step => ({
	step_id: id, kind: "tool_call", status: "ok",
	started_at: time(start), ended_at: end === null ? null : time(end),
	attributes: { [ATTR.TOOL_NAME]: name, [ATTR.TOOL_ARGS]: args },
});
const edit = (id: string, old_string: string, new_string: string, start: number, end: number | null) =>
	tool(id, "Edit", { file_path: file, old_string, new_string }, start, end);
const shell = (command: string, start: number, end: number | null = start + 1) =>
	tool(`shell-${start}`, "Bash", { command }, start, end);

function artifact(steps: Step[], command = "git commit -m fixture", content = "one\n", start = 20, end: number | null = start + 1) {
	const repo = { commits: [{ parent: null, message: "fixture", files: { [file]: content, [other]: "other\n" } }] };
	const commit = shell(command, start, end);
	commit.attributes[ATTR.GIT_COMMIT] = { short: fixtureRepoCommitShas(repo.commits)[0]!.slice(0, 7) };
	const trace: Trace = {
		plumbline_version: "0.1.0",
		run: { run_id: "synthetic", harness: { name: "fixture" }, started_at: time(0), workspace: { cwd: "/work/fixture" } },
		steps: [...steps, commit].sort((a, b) => a.started_at.localeCompare(b.started_at)),
	};
	const graph = buildBranchGraph(trace, { [file]: "base\n", [other]: "other\n" });
	return { graph, check: checkArtifacts(graph, repo) };
}

test("an edit after staging makes commit provenance unknown while worktree lineage stays known", () => {
	const { graph, check } = artifact([
		edit("first", "base", "one", 0, 1), shell(`git add ${file}`, 2), edit("second", "one", "two", 4, 5),
	]);
	assert.equal(graph.claim.tree?.[file], null);
	assert.equal(graph.endState[file], "two\n");
	assert.deepEqual(graph.editEffects.map((effect) => effect.lineage), ["abandoned", "retained"]);
	assert.deepEqual(check.effects.map((effect) => effect.status), ["unknown", "unknown"]);
});

test("literal staging coverage or commit all proves the worktree boundary after the last mutation", () => {
	for (const command of [`git add ${file}`, `git add -- ${file}`, "git add src", "git add -A", "git add --all", "git add ."]) {
		const { graph, check } = artifact([
			edit("first", "base", "one", 0, 1), shell(command, 2),
		]);
		assert.equal(graph.claim.tree?.[file]?.text, "one\n", command);
		assert.equal(check.effects[0]?.status, "retained", command);
	}
	for (const command of ["git commit -a -m fixture", "git commit -am fixture", "git commit --all --message=fixture"]) {
		const { check } = artifact([
			edit("first", "base", "one", 0, 1), shell(`git add ${file}`, 2), edit("second", "one", "two", 4, 5),
		], command, "two\n");
		assert.deepEqual(check.effects.map((effect) => effect.status), ["abandoned", "retained"], command);
	}
	const restaged = artifact([
		edit("first", "base", "one", 0, 1), shell(`git add ${file}`, 2), edit("second", "one", "two", 4, 5), shell(`git add ${file}`, 6),
	], "git commit -m fixture", "two\n");
	assert.deepEqual(restaged.check.effects.map((effect) => effect.status), ["abandoned", "retained"]);
});

test("unproven staging and explicit commit pathspecs fail closed", () => {
	for (const command of ["git add -p src/a.ts", "git add -u", "git add --force src/a.ts", "git add ':(literal)src/a.ts'"]) {
		const { graph, check } = artifact([edit("first", "base", "one", 0, 1), shell(command, 2)]);
		assert.equal(graph.claim.tree?.[file], null, command);
		assert.equal(check.effects[0]?.status, "unknown", command);
	}
	for (const command of ["git commit -m fixture src/a.ts", "git commit -am fixture -- src/a.ts", "git commit --include src/a.ts -m fixture", "git commit --interactive -m fixture"]) {
		assert.equal(artifact([edit("first", "base", "one", 0, 1), shell("git add .", 2)], command).check.effects[0]?.status, "unknown", command);
	}
	const unproven = artifact([edit("first", "base", "one", 0, 1), shell("git add .", 2), shell("git add -p src/a.ts", 4)]);
	assert.equal(unproven.check.effects[0]?.status, "unknown");
});

test("never-staged paths use their previous boundary content", () => {
	for (const staging of [[], [shell("git add src/b.ts", 2)], [shell("git add src/a.ts.backup", 2)]]) {
		const { graph, check } = artifact([edit("first", "base", "one", 0, 1), ...staging], "git commit -m fixture", "base\n");
		assert.equal(graph.claim.tree?.[file]?.text, "base\n");
		assert.equal(check.effects[0]?.status, "abandoned");
	}
	const previous = artifact([
		edit("first", "base", "one", 0, 1), shell("git add src/a.ts", 2),
		shell("git commit -m earlier", 4), edit("second", "one", "two", 6, 7),
	], "git commit -m fixture", "one\n");
	assert.equal(previous.graph.claim.tree?.[file]?.text, "one\n");
	assert.deepEqual(previous.check.effects.map((effect) => effect.status), ["retained", "abandoned"]);
	const uncertainCommit = shell("git commit -m earlier", 2);
	uncertainCommit.status = "interrupted";
	const uncertain = artifact([uncertainCommit, edit("first", "base", "one", 4, 5)], "git commit -m fixture", "base\n");
	assert.equal(uncertain.graph.claim.tree?.[file], null);
	assert.equal(uncertain.check.effects[0]?.status, "unknown");
});

test("staging provenance is per path and resolves literal working directories", () => {
	const stage = shell("git add ./a.ts", 2);
	(stage.attributes[ATTR.TOOL_ARGS] as Record<string, unknown>)["workdir"] = "/work/fixture/src";
	const second = tool("other", "Edit", { file_path: other, old_string: "other", new_string: "next" }, 4, 5);
	const { graph, check } = artifact([edit("first", "base", "one", 0, 1), stage, second]);
	assert.equal(graph.claim.tree?.[file]?.text, "one\n");
	assert.equal(graph.claim.tree?.[other]?.text, "other\n");
	assert.deepEqual(check.effects.map((effect) => effect.status), ["retained", "abandoned"]);
});

test("overlapping writes, including sidechains and missing end times, have unknown lineage", () => {
	for (const end of [4, null]) {
		const first = tool("first", "Write", { file_path: file, content: "one\n" }, 0, end);
		const second = tool("second", "write_file", { path: file, content: "two\n" }, 2, 5);
		second.subagent_id = "synthetic-worker";
		const { graph, check } = artifact([first, second], "git commit -am fixture");
		assert.equal(graph.endState[file], null);
		assert.equal(graph.claim.tree?.[file], null);
		assert.equal(graph.endState[other], "other\n");
		assert.deepEqual(graph.editEffects.map((effect) => effect.lineage), ["unknown", "unknown"]);
		assert.deepEqual(check.effects.map((effect) => effect.status), ["unknown", "unknown"]);
	}
});

test("writes crossing a commit boundary invalidate its snapshot in either start order", () => {
	for (const [writeStart, writeEnd, commitStart] of [[0, 5, 2], [2, 5, 0], [0, null, 2]] as const) {
		const { graph, check } = artifact([edit("first", "base", "one", writeStart, writeEnd)], "git commit -am fixture", "one\n", commitStart, 4);
		assert.equal(graph.claim.tree?.[file], null);
		assert.equal(graph.endState[file], null);
		assert.equal(graph.editEffects[0]?.lineage, "unknown");
		assert.equal(check.effects[0]?.status, writeStart > commitStart ? "after-claim" : "unknown");
	}
});

test("a post-claim overlap makes earlier owners unknown without changing a proven earlier boundary", () => {
	const { graph, check } = artifact([
		edit("committed", "base", "one", 0, 1),
		tool("later", "Write", { file_path: file, content: "two\n" }, 24, 28),
		tool("parallel", "Write", { file_path: file, content: "three\n" }, 26, 29),
	], "git commit -am fixture");
	assert.equal(graph.endState[file], null);
	assert.equal(graph.claim.tree?.[file]?.text, "one\n");
	assert.equal(check.effects[0]?.status, "retained");
});

test("disjoint writes on different paths and read overlap preserve known lineage", () => {
	const first = edit("first", "base", "one", 0, 4);
	const second = tool("other", "Write", { file_path: other, content: "next\n" }, 2, 5);
	const read = tool("read", "Read", { file_path: file }, 0, null);
	const { graph, check } = artifact([first, second, read], "git commit -am fixture");
	assert.equal(graph.claim.tree?.[file]?.text, "one\n");
	assert.equal(graph.claim.tree?.[other]?.text, "next\n");
	assert.deepEqual(graph.editEffects.map((effect) => effect.lineage), ["retained", "retained"]);
	assert.equal(check.effects[0]?.status, "retained");
});
