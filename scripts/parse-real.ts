/**
 * Read-only smoke: run the Claude Code parser against a real transcript and print
 * a derived summary. Never mutates the transcript; reads only. Used to verify the
 * parser survives the messy reality of a full session before we trust it.
 *
 *   npm run parse:real -- ~/.claude/projects/<encoded>/<session>.jsonl
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseClaudeCodeTranscript } from "../src/core/parsers/claude-code.ts";
import { ATTR, type Step } from "../src/core/types.ts";

const path = process.argv[2];
if (!path) {
	console.error("usage: npm run parse:real -- <transcript.jsonl>");
	process.exit(1);
}

const mainText = readFileSync(path, "utf8");
const subDir = join(path.replace(/\.jsonl$/, ""), "subagents");
const subTexts = existsSync(subDir)
	? readdirSync(subDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => readFileSync(join(subDir, f), "utf8"))
	: [];

const trace = parseClaudeCodeTranscript(mainText, subTexts);

const num = (s: Step, k: string): number =>
	typeof s.attributes[k] === "number" ? (s.attributes[k] as number) : 0;
const tally = <T extends string | undefined>(
	items: T[],
): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const i of items) if (i) out[i] = (out[i] ?? 0) + 1;
	return out;
};

const byKind = tally(trace.steps.map((s) => s.kind));
const guardTrips = trace.steps.filter((s) => s.attributes[ATTR.GUARD_TRIPPED]);
const staleReads = trace.steps.filter(
	(s) => s.attributes[ATTR.STALE_READ],
).length;
const hookDenies = trace.steps.filter(
	(s) => s.kind === "hook" && s.attributes[ATTR.HOOK_VERDICT] === "deny",
).length;
const errors = trace.steps.filter((s) => s.status === "error").length;
const subagents = new Set(trace.steps.map((s) => s.subagent_id).filter(Boolean))
	.size;

let inTok = 0;
let outTok = 0;
let cacheRead = 0;
for (const s of trace.steps) {
	if (s.kind !== "llm") continue;
	inTok += num(s, ATTR.INPUT_TOKENS);
	outTok += num(s, ATTR.OUTPUT_TOKENS);
	cacheRead += num(s, ATTR.CACHE_READ_TOKENS);
}

console.log("=== Agent Session Replay :: real transcript smoke ===");
console.log("file           :", path.split("/").slice(-2).join("/"));
console.log("run_id         :", trace.run.run_id);
console.log(
	"harness/version:",
	trace.run.harness.name,
	trace.run.harness.version,
);
console.log("model          :", trace.run.model);
console.log("span           :", trace.run.started_at, "->", trace.run.ended_at);
console.log("outcome        :", trace.run.outcome?.status);
console.log("total steps    :", trace.steps.length);
console.log("steps by kind  :", JSON.stringify(byKind));
console.log("subagents      :", subagents);
console.log("tool errors    :", errors);
console.log(
	"guard trips    :",
	guardTrips.length,
	JSON.stringify(
		tally(guardTrips.map((s) => String(s.attributes[ATTR.GUARD_NAME]))),
	),
);
console.log("stale reads    :", staleReads);
console.log("hook denials   :", hookDenies);
console.log(
	"tokens in/out  :",
	inTok.toLocaleString(),
	"/",
	outTok.toLocaleString(),
);
console.log("cache-read tok :", cacheRead.toLocaleString());
