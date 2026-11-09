import assert from "node:assert/strict";
import test from "node:test";
import { ATTR, type Step, type Trace } from "../../types.ts";
import { checkArtifacts } from "./artifact-check.ts";
import { fixtureRepoCommitShas } from "./git-sha.ts";
import { buildBranchGraph } from "./model.ts";
import { branchReport, renderBranchReport } from "./report.ts";

const file = "src/value.ts";
const tool = (id: string, name: string, args: Record<string, unknown>): Step => ({
	step_id: id, kind: "tool_call", status: "ok",
	started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:01Z",
	attributes: { [ATTR.TOOL_NAME]: name, [ATTR.TOOL_ARGS]: args },
});
const edit = (id: string, old_string: string, new_string: string) => tool(id, "Edit", { file_path: file, old_string, new_string });
const trace = (steps: Step[]): Trace => ({
	plumbline_version: "0.1.0",
	run: { run_id: "synthetic", harness: { name: "fixture" }, started_at: "2026-01-01T00:00:00Z", workspace: { cwd: "/work/fixture" } },
	steps,
});
function artifact(base: string, committed: Record<string, string>) {
	const repo = { commits: [{ parent: null, message: "synthetic artifact", files: committed }] };
	const short = fixtureRepoCommitShas(repo.commits)[0]!.slice(0, 7);
	const commit = tool("commit", "Bash", { command: "git commit -am fixture" });
	commit.attributes[ATTR.GIT_COMMIT] = { short };
	const run = (steps: Step[]) => {
		const graph = buildBranchGraph(trace(steps), { [file]: base });
		const check = checkArtifacts(graph, repo);
		return { graph, check, report: branchReport(graph, check) };
	};
	return { run, commit, short };
}

test("commit attribution uses boundary ownership before revert and identical reintroduction", () => {
	const { run, commit } = artifact("base\n", { [file]: "idea\n" });
	const { graph, check, report } = run([
		edit("committed", "base", "idea"), commit,
		edit("revert", "idea", "base"), edit("later", "base", "idea"),
	]);
	assert.deepEqual(graph.editEffects.map((effect) => effect.lineage), ["abandoned", "abandoned", "retained"]);
	assert.deepEqual(check.effects.map((effect) => effect.status), ["retained", "after-claim", "after-claim"]);
	assert.deepEqual(report.retained.map((step) => step.id), ["committed", "commit"]);
	assert.deepEqual(report.afterClaim.map((step) => step.id), ["revert", "later"]);
	assert.deepEqual(report.abandoned, []);
	assert.match(renderBranchReport(report), /Operations made after the claimed commit\n.*after-claim\n.*after-claim/);
});

test("an unparsed writer after the commit cannot invalidate the boundary snapshot", () => {
	const { run, commit } = artifact("base\n", { [file]: "idea\n" });
	const { graph, check } = run([edit("committed", "base", "idea"), commit, tool("writer", "Bash", { command: "python3 mutate.py" })]);
	assert.equal(graph.endStateComplete, false);
	assert.equal(graph.editEffects[0]?.lineage, "unknown");
	assert.equal(check.effects[0]?.status, "retained");
	assert.equal(graph.claim.tree?.[file]?.text, "idea\n");
});

test("commit boundary identifies the exact exec operation and splits later operations into their section", () => {
	const { run, short } = artifact("base\n", { [file]: "idea\n" });
	const cell = tool("cell", "exec", { input:
		'text(await tools.write_file({path:"src/value.ts",content:"idea\\n"})); text(await tools.exec_command({cmd:"git commit -am fixture"})); text(await tools.write_file({path:"src/value.ts",content:"later\\n"}));',
	});
	Object.assign(cell.attributes, {
		[ATTR.EXEC_COMPLETED]: true,
		[ATTR.EXEC_PARTS]: [
			{ kind: "empty-object" },
			{ kind: "chunk", result: { exit_code: 0, session_id: null, test_failures: false, test_passes: false } },
			{ kind: "empty-object" },
		],
		[ATTR.GIT_COMMIT]: { short }, [ATTR.GIT_COMMIT_CALL]: 1,
	});
	const { graph, check, report } = run([cell]);
	assert.equal(graph.claim.stepId, "cell");
	assert.equal(graph.claim.part, 1);
	assert.deepEqual(check.effects.map((effect) => [effect.node.part, effect.status]), [[0, "retained"], [2, "after-claim"]]);
	assert.deepEqual(report.retained[0]?.nodes.map((node) => node.part), [0, 1]);
	assert.deepEqual(report.afterClaim[0]?.nodes.map((node) => node.part), [2]);
});

test("equal base text elsewhere cannot prove retention of an omitted introduced occurrence", () => {
	const { run, commit } = artifact("old\nmarker\nnew\n", { [file]: "marker\nnew\n" });
	const { graph, check } = run([edit("omitted", "old", "new"), commit]);
	assert.equal(graph.editEffects[0]?.lineage, "retained");
	assert.equal(check.effects[0]?.status, "abandoned");
});

test("alignment distinguishes partial line retention from a changed line", () => {
	const { run, commit } = artifact("base\n", { [file]: "left\nchanged\n" });
	const { check } = run([edit("two-lines", "base\n", "left\nright\n"), commit]);
	assert.equal(check.effects[0]?.status, "partial");
	const changed = artifact("base\n", { [file]: "prefix idea suffix\n" });
	assert.equal(changed.run([edit("whole-line", "base", "idea"), changed.commit]).check.effects[0]?.status, "abandoned");
});

test("unknown boundary writers, missing committed files and binary content never prove retention", () => {
	const contents: Array<Record<string, string>> = [{}, { [file]: "idea\u0000\n" }];
	for (const committed of contents) {
		const { run, commit } = artifact("base\n", committed);
		assert.equal(run([edit("edit", "base", "idea"), commit]).check.effects[0]?.status, "unknown");
	}
	const { run, commit } = artifact("base\n", { [file]: "idea\n" });
	const unknown = run([edit("edit", "base", "idea"), tool("writer", "Bash", { command: "python3 mutate.py" }), commit]);
	assert.equal(unknown.check.effects[0]?.status, "unknown");
	assert.equal(unknown.graph.claim.tree?.[file], null);
	const deletion = run([edit("delete", "base", ""), commit]);
	assert.equal(deletion.check.effects[0]?.status, "unknown");
});
