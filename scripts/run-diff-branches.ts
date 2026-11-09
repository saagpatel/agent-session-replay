import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseClaudeCodeTranscript } from "../src/core/parsers/claude-code.ts";
import { parseCodexTranscript } from "../src/core/parsers/codex.ts";
import { buildBranchGraph } from "../src/core/diff/branch/model.ts";
import { checkArtifacts } from "../src/core/diff/branch/artifact-check.ts";
import { branchReport, renderBranchReport } from "../src/core/diff/branch/report.ts";

const dir = "fixtures/run-diff/branch";
const slugs = (await readdir(dir)).filter((file) => /^\d{2}-.+\.jsonl$/.test(file)).map((file) => file.slice(0, -6)).sort();
const arg = process.argv[2];
if (arg === "--count") console.log(slugs.length);
else if (arg === "--all" || (arg && slugs.includes(arg))) {
	for (const slug of arg === "--all" ? slugs : [arg]) {
		const labels = JSON.parse(await readFile(join(dir, `${slug}.labels.json`), "utf8"));
		const repo = JSON.parse(await readFile(join(dir, "repos", `${labels.repo}.json`), "utf8"));
		const raw = await readFile(join(dir, `${slug}.jsonl`), "utf8");
		const trace = labels.harness === "codex" ? parseCodexTranscript(raw) : parseClaudeCodeTranscript(raw);
		const graph = buildBranchGraph(trace, repo.commits[0].files);
		const report = branchReport(graph, checkArtifacts(graph, repo));
		if (arg === "--all") console.log(`${slug}: ${report.claim.status} · ${report.retained.length} retained · ${report.abandoned.reduce((n, b) => n + b.steps.length, 0)} dropped · ${report.unknown.length} unknown`);
		else console.log(renderBranchReport(report, { dense: true }));
	}
} else {
	console.error("Usage: run-diff:branches --count | --all | <fixture-slug>");
	process.exitCode = 1;
}
