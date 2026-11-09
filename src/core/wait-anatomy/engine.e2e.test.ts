import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BUCKETS, parseWaitAnalysis } from "./analysis.ts";
import { waitAnatomyView } from "./view-model.ts";

test("external engine analyzes the synthetic session", { skip: !process.env.TRACEGLASS_ROOT }, () => {
	const out = realpathSync(mkdtempSync(join(tmpdir(), "wait-engine-")));
	try {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/wait-anatomy.ts", "fixtures/wait-anatomy-session.jsonl", "--out", out], { encoding: "utf8" });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const analysis = parseWaitAnalysis(JSON.parse(readFileSync(join(out, "analysis.json"), "utf8")));
		assert.equal(BUCKETS.reduce((sum, bucket) => sum + analysis.totals_ns[bucket], 0), analysis.wall_clock_ns);
		assert.ok(analysis.naive_span_sum_ns > analysis.wall_clock_ns);
		assert.ok(readFileSync(join(out, "report.html"), "utf8").startsWith("<!doctype html>"));
		assert.equal(waitAnatomyView(analysis).buckets.length, BUCKETS.length);
	} finally { rmSync(out, { recursive: true, force: true }); }
});
