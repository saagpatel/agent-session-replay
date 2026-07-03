/**
 * Read-only helper: rank existing Agent Flight Recorder archive folders by how
 * useful they are to drop into the Decision Flight Deck. It never collects,
 * writes, deletes, or mutates AFR state.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseAfrBundle } from "../src/core/afr/parse.ts";
import {
	buildArchiveCandidate,
	rankArchiveCandidates,
} from "../src/core/control/archive-candidates.ts";
import { analyzeControlBundle } from "../src/core/control/engine.ts";

const DEFAULT_RUNS_DIR = join(
	homedir(),
	".local/share/agent-flight-recorder/runs",
);

function usage(): never {
	console.error("usage: pnpm afr:archives [runs-dir] [--json]");
	process.exit(1);
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const paths = args.filter((arg) => arg !== "--json");
if (paths.length > 1) usage();
const runsDir = paths[0] ?? DEFAULT_RUNS_DIR;

function readIfPresent(dir: string, name: string): string | undefined {
	const path = join(dir, name);
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function archiveDirs(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.map((name) => join(root, name))
		.filter((path) => {
			try {
				return statSync(path).isDirectory() && existsSync(join(path, "trace.afr.jsonl"));
			} catch {
				return false;
			}
		})
		.sort();
}

const candidates = rankArchiveCandidates(
	archiveDirs(runsDir).map((dir) => {
		const bundle = parseAfrBundle({
			name: dir,
			traceText: readIfPresent(dir, "trace.afr.jsonl") ?? "",
			privacyReportText: readIfPresent(dir, "privacy-report.afr.json"),
			validationReportText: readIfPresent(dir, "validation-report.afr.json"),
			reconciliationReportText: readIfPresent(dir, "reconciliation-report.afr.json"),
			manifestText: readIfPresent(dir, "manifest.afr.json"),
		});
		return buildArchiveCandidate(bundle, analyzeControlBundle(bundle));
	}),
);

if (json) {
	console.log(JSON.stringify(candidates, null, 2));
	process.exit(0);
}

console.log("Decision Flight Deck archive candidates");
console.log(`runs dir: ${runsDir}`);
console.log("read-only: no archives collected or modified");
console.log("");

if (candidates.length === 0) {
	console.log("No AFR archive folders with trace.afr.jsonl were found.");
	process.exit(0);
}

for (const [index, candidate] of candidates.entries()) {
	const prefix = index === 0 ? "BEST" : candidate.rankLabel.toUpperCase();
	console.log(
		`${index + 1}. [${prefix}] ${candidate.name} score=${candidate.score}`,
	);
	console.log(
		`   records=${candidate.recordCount} sources=${candidate.sourceCount} findings=${candidate.findingCount} actions=${candidate.actionCount}`,
	);
	console.log(
		`   freshness=fresh:${candidate.freshnessCounts.fresh} stale:${candidate.freshnessCounts.stale} historical:${candidate.freshnessCounts.historical} unknown:${candidate.freshnessCounts.unknown}`,
	);
	if (candidate.reasons.length > 0) {
		console.log(`   why=${candidate.reasons.join(" / ")}`);
	}
	if (candidate.warnings.length > 0) {
		console.log(`   watch=${candidate.warnings.join(" / ")}`);
	}
	console.log(`   drop=${candidate.dropPath}`);
}
