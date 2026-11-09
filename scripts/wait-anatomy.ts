import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseTranscript } from "../src/core/parse.ts";
import { toWaitTrace } from "../src/core/wait-anatomy/export.ts";

/** Claude Code keeps subagent transcripts in `<session>/subagents/*.jsonl`; a missing directory is expected. */
function readSidechains(sessionPath: string): string[] {
	const subDir = join(sessionPath.replace(/\.jsonl$/, ""), "subagents");
	if (!existsSync(subDir)) return [];
	return readdirSync(subDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => readFileSync(join(subDir, name), "utf8"));
}

const args = process.argv.slice(2);
if (args.length !== 3 || args[1] !== "--out" || !args[0] || !args[2]) {
	console.error("Usage: node --experimental-strip-types scripts/wait-anatomy.ts <session.jsonl> --out <dir>");
	process.exit(1);
}
const { waitTrace } = toWaitTrace(parseTranscript(readFileSync(args[0], "utf8"), readSidechains(args[0])).trace);
if (waitTrace.window_ns[1] <= waitTrace.window_ns[0]) {
	console.log("No measurable time in this session (window is zero-length); nothing to analyze.");
	process.exit(0);
}
// Traceglass storage refuses symlinked path components, so hand it the real path.
mkdirSync(resolve(args[2]), { recursive: true });
const out = realpathSync(resolve(args[2]));
const tracePath = join(out, "wait-trace.json");
const analysisPath = join(out, "analysis.json");
const reportPath = join(out, "report.html");
const root = process.env.TRACEGLASS_ROOT ? resolve(process.env.TRACEGLASS_ROOT) : undefined;
if (root && (existsSync(analysisPath) || existsSync(reportPath))) throw new Error("Analysis or report output already exists");
writeFileSync(tracePath, JSON.stringify(waitTrace, null, 2) + "\n", { flag: "wx" });
if (!root) {
	console.log("Set TRACEGLASS_ROOT to a traceglass checkout and run: python3 -m traceglass.wait_anatomy analyze " + tracePath + " --json " + analysisPath);
	console.log("Then run: python3 -m traceglass.wait_anatomy report " + tracePath + " --html " + reportPath);
} else {
	const python = process.env.TRACEGLASS_PYTHON || "python3";
	for (const engineArgs of [["analyze", tracePath, "--json", analysisPath], ["report", tracePath, "--html", reportPath]]) {
		const result = spawnSync(python, ["-m", "traceglass.wait_anatomy", ...engineArgs], { cwd: root, env: { ...process.env, PYTHONPATH: root }, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`Traceglass ${engineArgs[0]} failed (status ${result.status ?? "unknown"})`);
	}
}
