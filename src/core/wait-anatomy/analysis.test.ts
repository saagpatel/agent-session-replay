import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWaitAnalysis } from "./analysis.ts";
const sample = () => JSON.parse(readFileSync(new URL("./sample-analysis.json", import.meta.url), "utf8"));
test("accepts sample with or without optional arrays", () => {
	const data = sample();
	assert.equal(parseWaitAnalysis(data).wall_clock_ns, 10_000_000);
	data.declared_gaps = []; data.notes = [];
	assert.deepEqual(parseWaitAnalysis(data).notes, []);
	delete data.declared_gaps; delete data.notes;
	assert.doesNotThrow(() => parseWaitAnalysis(data));
});
test("rejects broken tiling, bucket and fractional time", () => {
	const gap = sample(); gap.critical_path[1].start_ns++;
	assert.throws(() => parseWaitAnalysis(gap), /tile/);
	const bucket = sample(); bucket.critical_path[0].bucket = "other";
	assert.throws(() => parseWaitAnalysis(bucket), /bucket/);
	const fraction = sample(); fraction.spans[0].end_ns = 1.5;
	assert.throws(() => parseWaitAnalysis(fraction), /integer/);
});
test("rejects accounting that disagrees with critical path and window", () => {
	const totals = sample(); totals.totals_ns.unattributed = 10_000_000; totals.totals_ns.useful_execution = 0;
	assert.throws(() => parseWaitAnalysis(totals), /critical path/);
	const attributed = sample(); attributed.attributed_ns = 10_000_001;
	assert.throws(() => parseWaitAnalysis(attributed), /attributed/);
	const wall = sample(); wall.wall_clock_ns--;
	assert.throws(() => parseWaitAnalysis(wall), /wall clock/);
});
