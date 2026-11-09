import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseClaudeCodeTranscript } from "../../parsers/claude-code.ts";
import { parseCodexTranscript } from "../../parsers/codex.ts";
import { checkArtifacts } from "./artifact-check.ts";
import { buildBranchGraph } from "./model.ts";
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
		const graph = buildBranchGraph(labels.harness === "codex" ? parseCodexTranscript(raw) : parseClaudeCodeTranscript(raw), repo.commits[0].files);
		const check = checkArtifacts(graph, repo);
		const report = branchReport(graph, check);
		const ids = [...report.retained, ...report.abandoned.flatMap((branch) => branch.steps), ...report.unknown].map((step) => step.id);
		assert.equal(new Set(ids).size, ids.length, slug);
		assert.deepEqual(new Set(ids), new Set(graph.nodes.map((node) => node.stepId)), slug);
		if (slug === "12-claim-outside-repo") {
			assert.equal(check.claim.status, "not-found");
			assert.ok(check.effects.every((effect) => effect.status === "unknown"));
		}
		if (slug === "11-artifact-omits-edit") {
			assert.equal(check.effects.find((effect) => effect.node.stepId === "toolu_0")?.status, "abandoned");
		}
		if (slug === "14-no-commit") {
			assert.equal(check.claim.status, "no-claim");
			assert.ok(check.effects.every((effect) => effect.status === "unknown"));
		}
		if (slug === "27-identical-edit-reintroduced") {
			assert.equal(check.effects.find((effect) => effect.node.stepId === "toolu_0")?.status, "unknown");
			assert.equal(check.effects.find((effect) => effect.node.stepId === "toolu_2")?.status, "retained");
		}
		for (const effect of check.effects.filter((effect) => effect.status === "retained")) {
			assert.ok(!labels.expected.abandoned.includes(effect.node.stepId), `${slug}: ${effect.node.stepId}`);
		}
		if (slug === "09-dense-dead-ends") {
			const rendered = renderBranchReport(report, { dense: true });
			assert.ok(rendered.split("\n").every((line) => line.length < 120));
			for (const step of report.retained) assert.ok(rendered.includes(step.id));
			const dropped = rendered.split("Attempted and dropped\n")[1]!.split("\nUnknown")[0]!.split("\n");
			assert.equal(dropped.length, report.abandoned.length);
			for (const branch of report.abandoned) for (const step of branch.steps) assert.ok(dropped.some((line) => line.includes(step.id)));
		}
	}
});
