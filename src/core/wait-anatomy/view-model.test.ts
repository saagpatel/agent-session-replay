import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWaitAnalysis } from "./analysis.ts";
import { waitAnatomyView } from "./view-model.ts";
test("calculates percentages and carries unattributed reasons", () => {
	const data = JSON.parse(readFileSync(new URL("./sample-analysis.json", import.meta.url), "utf8"));
	data.critical_path[0].bucket = "unattributed";
	data.totals_ns.unattributed = data.totals_ns.useful_execution;
	data.totals_ns.useful_execution = 0;
	data.unattributed = [{ start_ns: 0, end_ns: 2_000_000, reason: "No evidence" }];
	const view = waitAnatomyView(parseWaitAnalysis(data));
	assert.ok(Math.abs(view.buckets.reduce((sum, row) => sum + row.percent, 0) - 100) < 0.001);
	assert.equal(view.unattributed[0]?.reason, "No evidence");
	assert.equal(view.segments[0]?.end, 0.2);
	assert.equal(view.sentence, "Naive span sum 10 ms vs wall clock 10 ms: overlapping work is not double counted.");
});
