import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTR, type Trace } from "../src/core/types.ts";
import { parseClaudeCodeEvents } from "../src/core/parsers/claude-code.ts";
import { parseCodexEvents } from "../src/core/parsers/codex.ts";
import { alignEquivalent } from "../src/core/diff/equiv/align.ts";
import { evaluate, type EquivalencePair } from "../src/core/diff/equiv/eval.ts";
import { expand } from "../src/core/diff/equiv/expand.ts";
import type { CanonicalEvent, EquivalentRow } from "../src/core/diff/equiv/types.ts";

const FIXTURES = resolve(fileURLToPath(new URL("../fixtures/run-diff/equivalence/", import.meta.url)));

async function jsonLines(path: string): Promise<unknown[]> {
	const raw = await readFile(path, "utf8");
	return raw.split(/\r?\n/).filter((line) => line.trim()).map((line, i) => {
		try { return JSON.parse(line) as unknown; }
		catch { throw new Error(`${path}:${i + 1}: invalid JSON`); }
	});
}

async function traceAt(path: string): Promise<Trace> {
	const events = await jsonLines(path);
	if (events.length === 1 && typeof events[0] === "object" && events[0] !== null && "plumbline_version" in events[0])
		return events[0] as Trace;
	const codex = events.some((event) => typeof event === "object" && event !== null &&
		"type" in event && ["response_item", "session_meta", "turn_context", "event_msg"].includes(String(event.type)));
	return codex ? parseCodexEvents(events) : parseClaudeCodeEvents(events);
}

async function loadPairs(): Promise<EquivalencePair[]> {
	const slugs = (await readdir(FIXTURES, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	const pairs: EquivalencePair[] = [];
	for (const slug of slugs) {
		const dir = resolve(FIXTURES, slug);
		const label = JSON.parse(await readFile(resolve(dir, "label.json"), "utf8")) as Record<string, unknown>;
		if (label.label !== "equivalent" && label.label !== "divergent") throw new Error(`${slug}: invalid label`);
		if (typeof label.why !== "string" || typeof label.category !== "string") throw new Error(`${slug}: label needs why and category`);
		const [left, right] = await Promise.all([traceAt(resolve(dir, "left.jsonl")), traceAt(resolve(dir, "right.jsonl"))]);
		pairs.push({ slug, label: label.label, why: label.why, category: label.category, left, right });
	}
	return pairs;
}

function percent(rate: number): string { return `${(rate * 100).toFixed(1)}%`; }

async function printEval(pairs: EquivalencePair[]): Promise<void> {
	const result = evaluate(pairs);
	console.log(`pairs=${result.total} equivalent-labeled=${result.equivalentLabeled} divergent-labeled=${result.divergentLabeled} incomplete=${result.incomplete}`);
	console.log(`equivalence false-match=${result.falseMatches}/${result.divergentLabeled} (${percent(result.falseMatchRate)}) missed-match=${result.missedMatches}/${result.equivalentLabeled} (${percent(result.missedMatchRate)})`);
	console.log(`linear baseline false-match=${result.baseline.falseMatches}/${result.divergentLabeled} (${percent(result.baseline.falseMatchRate)}) missed-match=${result.baseline.missedMatches}/${result.equivalentLabeled} (${percent(result.baseline.missedMatchRate)})`);
	const bad = result.perPair.filter((pair) => pair.judged !== "incomplete" && pair.judged !== pair.label);
	if (!bad.length) { console.log("misjudged: none"); return; }
	console.log("misjudged pairs:");
	for (const pair of bad) console.log(`- ${pair.slug}: labeled ${pair.label}, judged ${pair.judged}; ${pair.why}`);
}

function eventLabel(event: CanonicalEvent): string {
	const range = event.range ? ` ${event.range.start}-${event.range.end}` : "";
	return `${event.action} ${event.target ?? "?"}${range}`;
}

function printEvent(side: "left" | "right", event: CanonicalEvent, steps: import("../src/core/diff/types.ts").DiffStep[], trace: Trace): void {
	const rule = event.rule ? ` [${event.rule}: ${event.memberStepIds.join(",")}]` : "";
	console.log(`${side} + ${eventLabel(event)}${rule}`);
	if (event.members.length > 1) {
		for (const original of expand(event, steps)) {
			const source = trace.steps.find((step) => step.step_id === original.stepId);
			console.log(`    ${original.stepId}: ${original.label} ${JSON.stringify(source?.attributes[ATTR.TOOL_ARGS] ?? {})}`);
		}
	}
}

function printRow(row: EquivalentRow, leftSteps: import("../src/core/diff/types.ts").DiffStep[], rightSteps: import("../src/core/diff/types.ts").DiffStep[], left: Trace, right: Trace): void {
	console.log(`row ${row.row + 1}: ${row.relation}${row.statusDiffers ? " (status differs)" : ""}`);
	if (row.left) printEvent("left", row.left, leftSteps, left);
	if (row.right) printEvent("right", row.right, rightSteps, right);
}

async function printSlug(pairs: EquivalencePair[], slug: string): Promise<void> {
	const pair = pairs.find((candidate) => candidate.slug === slug);
	if (!pair) throw new Error(`unknown fixture slug: ${slug}`);
	const aligned = alignEquivalent(pair.left, pair.right);
	console.log(`${slug}: ${pair.label} — ${pair.why}`);
	console.log(`judged ${aligned.incomplete ? "incomplete" : aligned.equivalent ? "equivalent" : "divergent"}${aligned.incompleteReasons.length ? ` (${aligned.incompleteReasons.join(", ")})` : ""}`);
	for (const row of aligned.rows) printRow(row, aligned.left.steps, aligned.right.steps, pair.left, pair.right);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const pairs = await loadPairs();
	if (args.length !== 1 || !["--count", "--eval"].includes(args[0] as string)) {
		if (args.length === 1 && args[0] !== "--count" && args[0] !== "--eval") return printSlug(pairs, args[0] as string);
		throw new Error("usage: run-diff-equiv.ts --count | --eval | <slug>");
	}
	if (args[0] === "--count") console.log(`${pairs.length} pairs`);
	else await printEval(pairs);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
