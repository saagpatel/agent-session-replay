import assert from "node:assert/strict";
import { test } from "node:test";

import {
	routeTitleForSource,
	sourceFreshnessOverride,
	sourceFreshnessReason,
	staleSourceDecisionReason,
} from "./source-contracts.ts";

test("artifact-store contract marks healthy sampled archives as historical", () => {
	assert.equal(
		sourceFreshnessOverride("artifact-store", {
			status: "ok",
			warnings: [],
			source_counts: { artifact_records_sampled: 50 },
		}),
		"historical",
	);
});

test("artifact-store contract does not hide reconciliation warnings", () => {
	assert.equal(
		sourceFreshnessOverride("artifact-store", {
			status: "warning",
			warnings: ["digest_skipped"],
			source_counts: { artifact_records_sampled: 50 },
		}),
		null,
	);
});

test("artifact-store contract explains historical freshness when applied", () => {
	assert.match(
		sourceFreshnessReason("artifact-store", {
			status: "ok",
			warnings: [],
			source_counts: { artifact_records_sampled: 50 },
		}) ?? "",
		/historical/,
	);
	assert.equal(
		sourceFreshnessReason("artifact-store", {
			status: "warning",
			warnings: ["digest_skipped"],
			source_counts: { artifact_records_sampled: 50 },
		}),
		null,
	);
});

test("cost-tracker contract accepts healthy live billing-period evidence", () => {
	assert.equal(
		sourceFreshnessOverride("cost-tracker", {
			status: "ok",
			warnings: [],
			source_counts: { ccusage_live_used: true },
		}),
		"fresh",
	);
});

test("cost-tracker contract explains live billing-period freshness", () => {
	assert.match(
		sourceFreshnessReason("cost-tracker", {
			status: "ok",
			warnings: [],
			source_counts: { ccusage_live_used: true },
		}) ?? "",
		/live ccusage/,
	);
});

test("evals contract supplies decision labels without exposing eval details", () => {
	assert.equal(routeTitleForSource("evals"), "Route eval maintenance");
	assert.equal(staleSourceDecisionReason("evals"), "stale evals source");
});
