import assert from "node:assert/strict";
import test from "node:test";
import { ATTR, type Step, type Trace } from "../../types.ts";
import { parseCodexEvents } from "../../parsers/codex.ts";
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
	// These helpers describe sequential calls; concurrency tests supply explicit intervals.
	steps: steps.map((step, index) => ({
		...step,
		started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString(),
		ended_at: step.ended_at == null ? step.ended_at : new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2 + 1)).toISOString(),
	})),
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

test("control steps preserve edit lineage and commit attribution", () => {
	for (const kind of ["llm", "decision", "compaction", "memory", "mode_change", "hook", "agent"] as const) {
		const control: Step = { ...tool("control", "unknown_tool", {}), kind };
		const { run, commit } = artifact("base\n", { [file]: "first second\n" });
		const { graph, check } = run([edit("first", "base", "first"), control, edit("second", "\n", " second\n"), commit]);
		assert.ok(graph.nodes.some((node) => node.stepId === "control"), kind);
		assert.equal(graph.endStateComplete, true, kind);
		assert.equal(graph.endState[file], "first second\n", kind);
		assert.deepEqual(graph.editEffects.map((effect) => effect.lineage), ["retained", "retained"], kind);
		assert.equal(check.claim.status, "resolved", kind);
		assert.deepEqual(check.effects.map((effect) => effect.status), ["retained", "retained"], kind);
	}
});

test("artifact paths require own string commit content and own boundary entries", () => {
	for (const path of ["constructor", "__proto__", "toString"]) {
		const repo = { commits: [{ parent: null, message: "synthetic artifact", files: {} as Record<string, string> }] };
		const short = fixtureRepoCommitShas(repo.commits)[0]!.slice(0, 7);
		const commit = tool("commit", "Bash", { command: "git commit -am fixture" });
		commit.attributes[ATTR.GIT_COMMIT] = { short };
		const graph = buildBranchGraph(trace([tool("edit", "Edit", { file_path: path, old_string: "base", new_string: "idea" }), commit]), { [path]: "base\n" });
		assert.equal(checkArtifacts(graph, repo).effects[0]?.status, "unknown", path);
		graph.claim.tree = {};
		assert.equal(checkArtifacts(graph, repo).effects[0]?.status, "unknown", path);
	}
	const repo = { commits: [{ parent: null, message: "synthetic artifact", files: { [file]: 42 as unknown as string } }] };
	const commit = tool("commit", "Bash", { command: "git commit -am fixture" });
	commit.attributes[ATTR.GIT_COMMIT] = { short: fixtureRepoCommitShas(repo.commits)[0]!.slice(0, 7) };
	const graph = buildBranchGraph(trace([edit("edit", "base", "idea"), commit]), { [file]: "base\n" });
	assert.equal(checkArtifacts(graph, repo).effects[0]?.status, "unknown");
});

test("insertion-only patch hunks require a proven position and preserve EOF newlines", () => {
	for (const [base, marker, expected] of [
		["base\n", "*** End of File\n", "base\nidea\n"],
		["base", "*** End of File\n", "base\nidea\n"],
		["", "", "idea\n"],
		["", "*** End of File\n", "idea\n"],
		["base\n", "", null],
	] as const) {
		const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n+idea\n${marker}*** End Patch`;
		const operation = tool("insert", "apply_patch", { input: patch });
		operation.attributes[ATTR.PATCH_CONFIRMED] = true;
		const cell = tool("cell", "exec", { input: `text(await tools.apply_patch(${JSON.stringify(patch)}))` });
		cell.attributes[ATTR.EXEC_COMPLETED] = true;
		cell.attributes[ATTR.EXEC_PARTS] = [{ kind: "empty-object" }];
		for (const step of [operation, cell]) {
			const { run, commit } = artifact(base, { [file]: expected ?? "base\nidea\n" });
			const { graph, check } = run([step, commit]);
			assert.equal(graph.endState[file], expected, patch);
			assert.equal(graph.claim.tree?.[file]?.text ?? null, expected, patch);
			assert.equal(graph.editEffects[0]?.lineage, expected === null ? "unknown" : "retained", patch);
			assert.equal(check.effects[0]?.status, expected === null ? "unknown" : "retained", patch);
		}
	}
});

test("test output writers cannot retain artifact ownership directly or in exec cells", () => {
	for (const command of [
		"go test -coverprofile=coverage.out ./...", "pytest --junitxml=report.xml",
		"pnpm test --update-snapshots", "pnpm vitest run -u", "npm test -- --coverage",
	]) {
		const cell = tool("cell", "exec", { input: `text(await tools.exec_command(${JSON.stringify({ cmd: command })}))` });
		cell.attributes[ATTR.EXEC_COMPLETED] = true;
		cell.attributes[ATTR.EXEC_PARTS] = [{ kind: "chunk", result: { exit_code: 0, session_id: null, test_failures: false, test_passes: true } }];
		for (const operation of [tool("writer", "Bash", { command }), cell]) {
			const { run, commit } = artifact("base\n", { [file]: "idea\n" });
			const { graph, check } = run([edit("edit", "base", "idea"), operation, commit]);
			assert.equal(graph.endState[file], null, command);
			assert.equal(graph.claim.tree?.[file], null, command);
			assert.equal(check.effects[0]?.status, "unknown", command);
		}
	}
});

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

test("artifact attribution follows confirmed moves even after the source is recreated", () => {
	for (const name of ["apply_patch", "Bash"]) {
		const source = "src/a.ts";
		const destination = "src/b.ts";
		const move = tool("move", name, name === "apply_patch"
			? { input: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${destination}\n*** End Patch` }
			: { command: `git mv ${source} ${destination}` });
		move.attributes[ATTR.PATCH_CONFIRMED] = true;
		const snapshots: Array<Record<string, string>> = [
			{ [source]: "different\n", [destination]: "idea\n" },
			{ [destination]: "idea\n" },
			{ [source]: "different\n" },
			{ [source]: "different\n", [destination]: "changed\n" },
		];
		for (const committed of snapshots) {
			const { commit } = artifact("", committed);
			const graph = buildBranchGraph(trace([
				tool("original", "Edit", { file_path: source, old_string: "base", new_string: "idea" }),
				move,
				tool("recreate", "Write", { file_path: source, content: "different\n" }),
				commit,
			]), { [source]: "base\n" });
			const repo = { commits: [{ parent: null, message: "synthetic artifact", files: committed }] };
			assert.equal(graph.claim.tree?.[destination]?.text, "idea\n", name);
			assert.equal(checkArtifacts(graph, repo).effects[0]?.status,
				!(destination in committed) ? "unknown" : committed[destination] === "idea\n" ? "retained" : "abandoned", name);
		}
	}
});

test("parser-to-artifact claims the last successful commit call in an exec cell", () => {
	const first = { parent: null, message: "first", files: { [file]: "first\n" } };
	const commits = [first, { parent: fixtureRepoCommitShas([first])[0]!, message: "second", files: { [file]: "second\n" } }];
	const shas = fixtureRepoCommitShas(commits);
	const input = [
		`text(await tools.write_file({path:"${file}",content:"first\\n"}));`,
		'text(await tools.exec_command({cmd:"git commit -am first"}));',
		`text(await tools.write_file({path:"${file}",content:"second\\n"}));`,
		'text(await tools.exec_command({cmd:"git commit -am second"}));',
	].join(" ");
	const event = (type: string, payload: unknown) => ({ type, timestamp: "2026-01-01T00:00:00Z", payload });
	const parsed = parseCodexEvents([
		event("session_meta", { id: "synthetic", cwd: "/work/fixture" }),
		event("response_item", { type: "function_call", name: "exec", call_id: "cell", arguments: JSON.stringify({ input }) }),
		event("response_item", { type: "function_call_output", call_id: "cell", output: [
			{ type: "text", text: "Script completed\n" },
			{ type: "text", text: "{}" },
			{ type: "text", text: JSON.stringify({ chunk_id: "first", exit_code: 0, output: `[main ${shas[0]!.slice(0, 7)}] first` }) },
			{ type: "text", text: "{}" },
			{ type: "text", text: JSON.stringify({ chunk_id: "second", exit_code: 0, output: `[main ${shas[1]!.slice(0, 7)}] second` }) },
		] }),
	]);
	assert.deepEqual(parsed.steps[0]?.attributes[ATTR.GIT_COMMIT], { branch: "main", short: shas[1]!.slice(0, 7) });
	assert.equal(parsed.steps[0]?.attributes[ATTR.GIT_COMMIT_CALL], 3);
	const graph = buildBranchGraph(parsed, { [file]: "base\n" });
	const check = checkArtifacts(graph, { commits });
	assert.equal(graph.claim.part, 3);
	assert.equal(check.claim.sha, shas[1]);
	assert.equal(graph.claim.tree?.[file]?.text, "second\n");
	assert.deepEqual(check.effects.map((effect) => [effect.node.part, effect.status]), [[0, "abandoned"], [2, "retained"]]);
	assert.deepEqual(branchReport(graph, check).afterClaim, []);
});

test("uncertain move destinations cannot prove the original edit abandoned", () => {
	const source = "src/a.ts";
	const destination = "src/b.ts";
	const { commit } = artifact("", { [source]: "different\n", [destination]: "idea\n" });
	const steps = [
		tool("original", "Edit", { file_path: source, old_string: "base", new_string: "idea" }),
		tool("move", "Bash", { command: `git mv ${source} ${destination}` }),
		tool("pending", "write_file", { path: destination, content: "unknown\n" }),
		tool("recreate", "Write", { file_path: source, content: "different\n" }), commit,
	];
	steps[2]!.ended_at = null;
	const graph = buildBranchGraph(trace(steps), { [source]: "base\n" });
	const repo = { commits: [{ parent: null, message: "synthetic artifact", files: { [source]: "different\n", [destination]: "idea\n" } }] };
	assert.equal(graph.claim.tree?.[destination], null);
	assert.equal(checkArtifacts(graph, repo).effects[0]?.status, "unknown");
});

test("equal base text elsewhere cannot prove retention of an omitted introduced occurrence", () => {
	const { run, commit } = artifact("old\nmarker\nnew\n", { [file]: "marker\nnew\n" });
	const { graph, check } = run([edit("omitted", "old", "new"), commit]);
	assert.equal(graph.editEffects[0]?.lineage, "retained");
	assert.equal(check.effects[0]?.status, "abandoned");
});

test("duplicate introduced lines are unknown whether they precede or follow base text", () => {
	for (const base of ["old\nnew\n", "new\nold\n"]) {
		const { run, commit } = artifact(base, { [file]: "new\n" });
		const { check } = run([edit("duplicate", "old", "new"), commit]);
		assert.equal(check.effects[0]?.status, "unknown", base);
	}
});

test("external paths stay unknown even if a commit fixture names their identity", () => {
	const external = "external:/tmp/source.ts";
	const repo = { commits: [{ parent: null, message: "synthetic artifact", files: { [external]: "idea\n" } }] };
	const short = fixtureRepoCommitShas(repo.commits)[0]!.slice(0, 7);
	const operation = tool("external-edit", "Edit", {
		file_path: "/tmp/source.ts", old_string: "base", new_string: "idea",
	});
	const commit = tool("commit", "Bash", { command: "git commit -am fixture" });
	commit.attributes[ATTR.GIT_COMMIT] = { short };
	const graph = buildBranchGraph(trace([operation, commit]), { [external]: "base\n" });
	assert.equal(checkArtifacts(graph, repo).effects[0]?.status, "unknown");
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
