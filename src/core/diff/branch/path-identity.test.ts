import assert from "node:assert/strict";
import test from "node:test";
import { ATTR, type Step, type Trace } from "../../types.ts";
import { checkArtifacts } from "./artifact-check.ts";
import { fixtureRepoCommitShas } from "./git-sha.ts";
import { buildBranchGraph } from "./model.ts";

const root = "/work/fixture";
const base = { "src/a.ts": "base\n", "src/moved.ts": "untouched\n" };
const tool = (id: string, name: string, args: Record<string, unknown>): Step => ({
	step_id: id, kind: "tool_call", status: "ok",
	started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:01Z",
	attributes: { [ATTR.TOOL_NAME]: name, [ATTR.TOOL_ARGS]: args },
});
const trace = (steps: Step[], cwd: string | undefined = root): Trace => ({
	plumbline_version: "0.1.0",
	run: { run_id: "synthetic", harness: { name: "fixture" }, started_at: "2026-01-01T00:00:00Z", workspace: { cwd } },
	// These helpers describe sequential calls; concurrency tests supply explicit intervals.
	steps: steps.map((step, index) => ({
		...step,
		started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString(),
		ended_at: step.ended_at == null ? step.ended_at : new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2 + 1)).toISOString(),
	})),
});
const edit = (path: string, extra = {}) => tool("edit", "Edit", { file_path: path, old_string: "base", new_string: "idea", ...extra });
const patch = (input: string) => {
	const step = tool("patch", "apply_patch", { input: `*** Begin Patch\n${input}\n*** End Patch` });
	step.attributes[ATTR.PATCH_CONFIRMED] = true;
	return step;
};
function artifact(steps: Step[], files: Record<string, string> = { ...base, "src/a.ts": "idea\n" }) {
	const repo = { commits: [{ parent: null, message: "synthetic", files }] };
	const commit = tool("commit", "Bash", { command: "git commit -am fixture" });
	commit.attributes[ATTR.GIT_COMMIT] = { short: fixtureRepoCommitShas(repo.commits)[0]!.slice(0, 7) };
	const graph = buildBranchGraph(trace([...steps, commit]), base);
	return { graph, check: checkArtifacts(graph, repo), commit };
}

test("direct edits and writes use normalized workspace identities without external aliases", () => {
	for (const path of ["src/./a.ts", "src/../src/a.ts", `${root}/src/../src/a.ts`, "../fixture/src/a.ts"])
		for (const operation of [edit(path), tool("write", "Write", { path, content: "idea\n" }), tool("codex-write", "write_file", { path, content: "idea\n" }), tool("multi", "MultiEdit", { path, edits: [{ old_string: "base", new_string: "idea" }] })]) {
			const { graph, check } = artifact([operation]);
			assert.equal(graph.editEffects[0]?.file, "src/a.ts", path);
			assert.equal(check.effects[0]?.status, "retained", path);
		}
	for (const path of ["/work/outside/src/a.ts", "../outside/src/a.ts", `${root}/../outside/src/a.ts`, "/work/fixture-other/src/a.ts"])
		for (const operation of [edit(path), tool("write", "Write", { path, content: "idea\n" }), tool("codex-write", "write_file", { path, content: "idea\n" }), tool("multi", "MultiEdit", { path, edits: [{ old_string: "base", new_string: "idea" }] })]) {
			const { graph, check } = artifact([operation], base);
			assert.match(graph.editEffects[0]!.file, /^external:\/work\//);
			assert.equal(graph.endState["src/a.ts"], "base\n", path);
			assert.equal(graph.editEffects[0]?.lineage, "unknown", path);
			assert.equal(check.effects[0]?.status, "unknown", path);
		}
});

test("patch add, update and delete paths cannot alias external files to repository files", () => {
	for (const header of ["Add", "Update", "Delete"]) {
		const body = header === "Add" ? "\n+idea" : header === "Update" ? "\n@@\n-base\n+idea" : "";
		const { graph, check } = artifact([patch(`*** ${header} File: /work/outside/src/a.ts${body}`)], base);
		assert.equal(graph.nodes[0]?.target, "external:/work/outside/src/a.ts");
		assert.equal(graph.endState["src/a.ts"], "base\n");
		assert.equal(check.effects[0]?.status, "unknown");
	}
	const { graph, check } = artifact([patch(`*** Update File: ${root}/src/../src/a.ts\n@@\n-base\n+idea`)]);
	assert.equal(graph.editEffects[0]?.file, "src/a.ts");
	assert.equal(check.effects[0]?.status, "retained");
});

test("patch moves normalize both paths and fail closed across the workspace boundary", () => {
	const operation = patch(`*** Update File: ${root}/src/../src/a.ts\n*** Move to: src/../src/new.ts\n@@\n-base\n+idea`);
	const inside = artifact([operation], { ...base, "src/new.ts": "idea\n" });
	assert.equal(inside.graph.editEffects[0]?.file, "src/new.ts");
	assert.equal(inside.check.effects[0]?.status, "retained");
	for (const [from, to] of [["src/a.ts", "/work/outside/src/moved.ts"], ["/work/outside/src/a.ts", "src/new.ts"]]) {
		const { graph, check } = artifact([patch(`*** Update File: ${from}\n*** Move to: ${to}\n@@\n-base\n+idea`)]);
		assert.equal(graph.endState["src/moved.ts"], "untouched\n");
		assert.equal(graph.editEffects[0]?.lineage, "unknown");
		assert.equal(check.effects[0]?.status, "unknown");
		assert.equal(graph.endState[to.startsWith("/") ? `external:${to}` : to], null);
	}
});

test("shell restore paths and workdirs use canonical identities including exec cells", () => {
	for (const workdir of [`${root}/src/../src`, "src/../src"])
		for (const name of ["Bash", "exec"]) {
			const operation = name === "Bash"
				? tool("restore", name, { command: "git restore ./a.ts", workdir })
				: tool("restore", name, { input: `text(await tools.exec_command(${JSON.stringify({ cmd: "git restore ./a.ts", workdir })}))` });
			if (name === "exec") Object.assign(operation.attributes, {
				[ATTR.EXEC_COMPLETED]: true,
				[ATTR.EXEC_PARTS]: [{ kind: "chunk", result: { exit_code: 0, session_id: null } }],
			});
			const { graph, check } = artifact([edit("src/a.ts"), operation], base);
			assert.equal(graph.endState["src/a.ts"], "base\n");
			assert.equal(check.effects[0]?.status, "abandoned");
		}
	for (const command of ["git restore a.ts", "git checkout -- .", "git reset --hard", "git stash"])
		for (const workdir of ["/work/outside/src", "../outside/src", `${root}/../outside/src`]) {
			const { graph, check } = artifact([edit("src/a.ts"), tool("restore", "Bash", { command, workdir })]);
			assert.equal(graph.endState["src/a.ts"], "idea\n", `${command}, ${workdir}`);
			assert.equal(check.effects[0]?.status, "retained");
		}
	const external = artifact([edit("src/a.ts"), tool("restore", "Bash", { command: "git restore /work/outside/src/a.ts" })]);
	assert.equal(external.check.effects[0]?.status, "retained");
});

test("unknown directories cannot prove edit lineage or repository commit claims", () => {
	const unknownPatch = patch("*** Update File: src/a.ts\n@@\n-base\n+idea");
	Object.assign(unknownPatch.attributes[ATTR.TOOL_ARGS] as Record<string, unknown>, { workdir: null });
	assert.equal(artifact([unknownPatch]).graph.editEffects[0]?.lineage, "unknown");
	for (const workdir of [null, "$WORKDIR", "~", ""])
		for (const operation of [edit("src/a.ts", { workdir }), tool("write", "Write", { path: "src/a.ts", content: "idea\n", workdir }), tool("restore", "Bash", { command: "git restore src/a.ts", workdir })]) {
			const { graph, check } = artifact([edit("src/a.ts"), operation]);
			assert.equal(graph.endState["src/a.ts"], null);
			assert.ok(graph.editEffects.every((effect) => effect.lineage === "unknown"));
			assert.ok(check.effects.every((effect) => effect.status === "unknown"));
		}
	const noRoot = trace([edit("src/a.ts")]);
	delete noRoot.run.workspace;
	const missing = buildBranchGraph(noRoot, base);
	assert.equal(missing.nodes[0]?.target, null);
	assert.equal(missing.editEffects[0]?.lineage, "unknown");
	const { commit } = artifact([]);
	for (const workdir of ["/work/outside", "$WORKDIR", null]) {
		const outsideCommit = { ...commit, attributes: { ...commit.attributes, [ATTR.TOOL_ARGS]: { command: "git commit -am fixture", workdir } } };
		assert.equal(buildBranchGraph(trace([edit("src/a.ts"), outsideCommit]), base).claim.commitShort, null);
	}
});
