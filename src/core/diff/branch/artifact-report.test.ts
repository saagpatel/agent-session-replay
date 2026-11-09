import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ATTR, type Step, type Trace } from "../../types.ts";
import { parseClaudeCodeTranscript } from "../../parsers/claude-code.ts";
import { parseCodexTranscript } from "../../parsers/codex.ts";
import { checkArtifacts } from "./artifact-check.ts";
import { buildBranchGraph } from "./model.ts";
import { fixtureRepoCommitShas } from "./git-sha.ts";
import { branchReport, renderBranchReport } from "./report.ts";

const dir = "fixtures/run-diff/branch";
test("fixture reports preserve step provenance and artifact claims fail closed", async () => {
	const files = (await readdir(dir)).filter((file) => /^\d\d-.+\.jsonl$/.test(file)).sort();
	assert.equal(files.length, 30);
	for (const file of files) {
		const slug = file.slice(0, -6);
		const labels = JSON.parse(await readFile(join(dir, `${slug}.labels.json`), "utf8"));
		const repo = JSON.parse(await readFile(join(dir, "repos", `${labels.repo}.json`), "utf8"));
		const raw = await readFile(join(dir, file), "utf8");
		const trace = labels.harness === "codex" ? parseCodexTranscript(raw) : parseClaudeCodeTranscript(raw);
		const graph = buildBranchGraph(trace, repo.commits[0].files);
		const check = checkArtifacts(graph, repo);
		const report = branchReport(graph, check, trace);
		const ids = [...report.retained, ...report.abandoned.flatMap((branch) => branch.steps), ...report.unknown, ...report.afterClaim, ...report.control].map((step) => step.id);
		assert.equal(new Set(ids).size, ids.length, slug);
		assert.deepEqual(new Set(ids), new Set(graph.nodes.map((node) => node.stepId)), slug);
		assert.equal(check.claim.status, labels.artifact.link, `${slug}: artifact link`);
		for (const status of ["retained", "abandoned", "partial", "unknown", "after-claim"] as const) {
			assert.deepEqual(
				[...new Set(check.effects.filter((effect) => effect.status === status).map((effect) => effect.node.stepId))].sort(),
				[...(labels.artifact[status] ?? [])].sort(),
				`${slug}: artifact ${status} effects`,
			);
		}
		for (const effect of check.effects.filter((effect) => effect.status === "retained")) {
			assert.ok(!labels.expected.abandoned.includes(effect.node.stepId), `${slug}: ${effect.node.stepId}`);
		}
	}
});

test("the dense fixture keeps control steps and all dead ends visible", async () => {
	const slug = "09-dense-dead-ends";
	const labels = JSON.parse(await readFile(join(dir, `${slug}.labels.json`), "utf8"));
	const repo = JSON.parse(await readFile(join(dir, "repos", `${labels.repo}.json`), "utf8"));
	const trace = parseClaudeCodeTranscript(await readFile(join(dir, `${slug}.jsonl`), "utf8"));
	const graph = buildBranchGraph(trace, repo.commits[0].files);
	const report = branchReport(graph, checkArtifacts(graph, repo), trace);
	const rendered = renderBranchReport(report, { dense: true });
	assert.ok(rendered.split("\n").every((line) => line.length < 120));
	assert.ok(!rendered.includes("toolu_"));
	const orderedIds = [...new Set(graph.nodes.map((node) => node.stepId))];
	for (const step of report.retained) assert.ok(rendered.includes(`#${orderedIds.indexOf(step.id) + 1} `));
	const dropped = rendered.split("Attempted and dropped\n")[1]!.split("\nUnknown")[0]!.split("\n");
	assert.deepEqual(dropped, [
		"11 superseded edits to src/value.ts (#2–#22, 11 steps), each replaced by the next",
		"12 backtracks on src/value.ts (#24–#46, 12 steps), each restored by the next edit",
	]);
	assert.equal(report.control.length, 27);
	assert.ok(rendered.includes("Control steps: 27 — not work, listed in the JSON report"));
	assert.ok(rendered.startsWith("Retained 3 · Dropped 23 (11 superseded, 12 backtrack) · Unknown 0 · Control 27 · Commit 3a6790b resolved\n"));
});

test("a partially surviving payload is partial in the artifact check, never wholly dropped", () => {
	const repo = { commits: [{ parent: null, message: "partial edit", files: { "src/value.ts": "next right\n" } }] };
	const sha = fixtureRepoCommitShas(repo.commits)[0]!;
	const steps: Step[] = [
		["first", "base", "left right"],
		["second", "left", "next"],
	].map(([id, old_string, new_string], index) => ({
		step_id: id!, kind: "tool_call", status: "ok",
		started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString(),
		ended_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2 + 1)).toISOString(),
		attributes: { [ATTR.TOOL_NAME]: "Edit", [ATTR.TOOL_ARGS]: { file_path: "src/value.ts", old_string, new_string } },
	}));
	steps.push({
		step_id: "commit", kind: "tool_call", status: "ok",
		started_at: "2026-01-01T00:00:04Z", ended_at: "2026-01-01T00:00:05Z",
		attributes: { [ATTR.TOOL_NAME]: "Bash", [ATTR.TOOL_ARGS]: { command: "git commit -am partial" }, [ATTR.GIT_COMMIT]: { short: sha.slice(0, 7) } },
	});
	const trace: Trace = {
		plumbline_version: "0.1.0",
		run: { run_id: "synthetic", harness: { name: "fixture" }, started_at: "2026-01-01T00:00:00Z", workspace: { cwd: "/work/fixture" } },
		steps,
	};
	const graph = buildBranchGraph(trace, { "src/value.ts": "base\n" });
	assert.equal(graph.editEffects[0]?.lineage, "partial");
	const check = checkArtifacts(graph, repo);
	assert.equal(check.claim.status, "resolved");
	assert.deepEqual(check.effects.map((effect) => effect.status), ["partial", "retained"]);
	const report = branchReport(graph, check, trace);
	assert.deepEqual(report.unknown.map((step) => step.id), ["first"]);
	assert.deepEqual(report.retained.map((step) => step.id), ["second", "commit"]);
	assert.deepEqual(report.abandoned, []);
});
