import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseClaudeCodeTranscript } from "../../parsers/claude-code.ts";
import { parseCodexTranscript } from "../../parsers/codex.ts";
import { alignEquivalent } from "./align.ts";
import { evaluate, type EquivalencePair } from "./eval.ts";
import { expand, expandAll } from "./expand.ts";

const root = "fixtures/run-diff/equivalence";
const files = ["label.json", "left.jsonl", "right.jsonl"];
const slugs = () => readdirSync(root).sort();
function parse(text: string) {
	const first = JSON.parse(text.split("\n")[0] as string) as { type?: string };
	return first.type === "session_meta" ? parseCodexTranscript(text) : parseClaudeCodeTranscript(text);
}
function pairs(): EquivalencePair[] {
	return slugs().map((slug) => {
		const dir = join(root, slug);
		const label = JSON.parse(readFileSync(join(dir, "label.json"), "utf8")) as Pick<EquivalencePair, "label" | "why" | "category">;
		return { slug, ...label, left: parse(readFileSync(join(dir, "left.jsonl"), "utf8")), right: parse(readFileSync(join(dir, "right.jsonl"), "utf8")) };
	});
}

test("equiv-fixtures: forty labeled pairs regenerate byte-for-byte", () => {
	const names = slugs();
	assert.equal(names.length, 40);
	for (const slug of names) {
		assert.deepEqual(readdirSync(join(root, slug)).sort(), files);
		const label = JSON.parse(readFileSync(join(root, slug, "label.json"), "utf8"));
		assert.ok(["equivalent", "divergent"].includes(label.label));
		assert.ok(typeof label.why === "string" && label.why.length > 0);
		assert.ok(typeof label.category === "string" && label.category.length > 0);
	}
	const temp = mkdtempSync(".equiv-regenerate-");
	try {
		execFileSync(process.execPath, ["--experimental-strip-types", "scripts/gen-equiv-fixtures.ts", "--out-dir", temp]);
		assert.deepEqual(readdirSync(temp).sort(), names);
		for (const slug of names) for (const file of files)
			assert.deepEqual(readFileSync(join(temp, slug, file)), readFileSync(join(root, slug, file)), `${slug}/${file}`);
	} finally { rmSync(temp, { recursive: true, force: true }); }
});

test("equiv-eval: labeled-class rates and baseline arithmetic", () => {
	const result = evaluate(pairs());
	assert.ok(result.equivalentLabeled >= 18 && result.divergentLabeled >= 18);
	assert.equal(result.total, 40);
	assert.equal(result.incomplete, result.perPair.filter((p) => p.judged === "incomplete").length);
	assert.ok(result.incomplete / result.total < 0.1);
	const count = (label: string, field: "judged" | "baseline", value: string) => result.perPair.filter((p) => p.label === label && p[field] === value).length;
	assert.equal(result.falseMatches, count("divergent", "judged", "equivalent"));
	assert.equal(result.missedMatches, count("equivalent", "judged", "divergent"));
	assert.equal(result.falseMatchRate, result.falseMatches / result.divergentLabeled);
	assert.equal(result.missedMatchRate, result.missedMatches / result.equivalentLabeled);
	assert.equal(result.baseline.falseMatches, count("divergent", "baseline", "equivalent"));
	assert.equal(result.baseline.missedMatches, count("equivalent", "baseline", "divergent"));
	assert.equal(result.baseline.falseMatchRate, result.baseline.falseMatches / result.divergentLabeled);
	assert.equal(result.baseline.missedMatchRate, result.baseline.missedMatches / result.equivalentLabeled);
	assert.equal(result.falseMatchRate, 0);
	assert.ok(result.missedMatchRate <= 0.15);
});

test("every fixture event expands to its original members", () => {
	for (const pair of pairs()) {
		const alignment = alignEquivalent(pair.left, pair.right);
		for (const normalized of [alignment.left, alignment.right]) {
			assert.deepEqual(expandAll(normalized), normalized.steps, pair.slug);
			for (const event of normalized.events)
				assert.deepEqual(expand(event, normalized.steps), event.members.map((i) => normalized.steps[i]), pair.slug);
		}
	}
});
