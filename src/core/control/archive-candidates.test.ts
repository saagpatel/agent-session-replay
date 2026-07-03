import assert from "node:assert/strict";
import { test } from "node:test";

import type { AfrBundle } from "../afr/types.ts";
import { analyzeControlBundle } from "./engine.ts";
import {
	buildArchiveCandidate,
	rankArchiveCandidates,
} from "./archive-candidates.ts";

function bundle(overrides: Partial<AfrBundle> = {}): AfrBundle {
	return {
		name: "20260703T120000Z-all",
		records: [],
		malformedRecords: 0,
		archiveSuffix: "all",
		createdAt: "2026-07-03T12:00:00Z",
		privacyReport: { ok: true },
		validationReport: { ok: true },
		reconciliationReport: { ok: true, sources: {} },
		manifest: null,
		...overrides,
	};
}

test("archive candidate ranking prefers fresh all-source metadata", () => {
	const allSource = bundle({
		name: "/runs/20260703T120000Z-all",
		records: [
			{
				record_id: "evals:case-1",
				record_type: "eval_observation",
				source_system: "evals",
				status: "failed",
				timestamp: "2026-07-03T11:59:00Z",
			},
			{
				record_id: "bridge-db:event-1",
				record_type: "event",
				source_system: "bridge-db",
				timestamp: "2026-07-03T11:58:00Z",
			},
		],
	});
	const sourceSpecific = bundle({
		name: "/runs/20260703T130000Z-evals",
		archiveSuffix: "evals",
		createdAt: "2026-07-03T13:00:00Z",
		records: [
			{
				record_id: "evals:case-2",
				record_type: "eval_observation",
				source_system: "evals",
				status: "failed",
				timestamp: "2026-07-03T12:59:00Z",
			},
		],
	});
	const candidates = [allSource, sourceSpecific].map((item) =>
		buildArchiveCandidate(
			item,
			analyzeControlBundle(item, Date.parse("2026-07-03T13:05:00Z")),
		),
	);

	const ranked = rankArchiveCandidates(candidates);

	assert.equal(ranked[0]?.name, "20260703T120000Z-all");
	assert.equal(ranked[0]?.rankLabel, "best");
	assert.ok(ranked[0]?.reasons.includes("all-source archive"));
	assert.ok(ranked[1]?.warnings.includes("not all-source"));
});

test("archive candidate surfaces malformed and failed report warnings", () => {
	const candidate = buildArchiveCandidate(
		bundle({
			name: "/runs/20260703T120000Z-all",
			malformedRecords: 2,
			privacyReport: { ok: false },
			validationReport: { ok: false },
			reconciliationReport: { ok: false, sources: {} },
		}),
		analyzeControlBundle(
			bundle({
				name: "/runs/20260703T120000Z-all",
				malformedRecords: 2,
				privacyReport: { ok: false },
				validationReport: { ok: false },
				reconciliationReport: { ok: false, sources: {} },
			}),
			Date.parse("2026-07-03T13:05:00Z"),
		),
	);

	assert.ok(candidate.warnings.includes("2 malformed line(s)"));
	assert.ok(candidate.warnings.includes("privacy failed"));
	assert.ok(candidate.warnings.includes("validation failed"));
	assert.ok(candidate.warnings.includes("reconciliation failed"));
	assert.equal(candidate.rankLabel, "weak");
});
