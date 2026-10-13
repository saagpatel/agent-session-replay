import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAfrBundle } from "./parse.ts";

test("parseAfrBundle parses trace records and sibling reports", () => {
	const bundle = parseAfrBundle({
		name: "20260628T120000Z-all",
		traceText:
			'{"record_id":"r1","record_type":"decision","source_system":"codex","privacy_tier":"P2","timestamp":"2026-06-28T12:00:01Z"}\n',
		privacyReportText: '{"ok":true,"checks":["metadata-only"]}',
		validationReportText: '{"ok":true,"warnings":[]}',
		reconciliationReportText:
			'{"ok":true,"sources":{"codex":{"status":"ok","warnings":[]}}}',
		manifestText: '{"schema_version":"1"}',
	});

	assert.equal(bundle.records.length, 1);
	assert.equal(bundle.malformedRecords, 0);
	assert.equal(bundle.archiveSuffix, "all");
	assert.equal(bundle.createdAt, "2026-06-28T12:00:00Z");
	assert.equal(bundle.privacyReport?.ok, true);
	assert.equal(bundle.validationReport?.ok, true);
	const sources = bundle.reconciliationReport?.sources;
	assert.equal(Array.isArray(sources) ? undefined : sources?.codex?.status, "ok");
	assert.equal(bundle.manifest?.schema_version, "1");
	assert.deepEqual(bundle.reportStatuses, {
		privacyReport: "valid",
		validationReport: "valid",
		reconciliationReport: "valid",
		manifest: "valid",
	});
	assert.deepEqual(bundle.diagnostics, []);
});

test("parseAfrBundle tolerates malformed trace lines and bad optional reports", () => {
	const bundle = parseAfrBundle({
		name: "trace.afr.jsonl",
		traceText: '{"record_id":"r1"}\nnot json\n{"record_id":"r2"}',
		privacyReportText: "not json",
	});

	assert.deepEqual(
		bundle.records.map((record) => record.record_id),
		["r1", "r2"],
	);
	assert.equal(bundle.malformedRecords, 1);
	assert.equal(bundle.archiveSuffix, null);
	assert.equal(bundle.createdAt, null);
	assert.equal(bundle.privacyReport, null);
	assert.equal(bundle.reportStatuses.privacyReport, "invalid");
	assert.equal(bundle.reportStatuses.validationReport, "absent");
	assert.equal(bundle.diagnostics[0]?.message, "privacyReport: invalid JSON");
});

test("parseAfrBundle reports malformed report fields and keeps usable source rows", () => {
	const bundle = parseAfrBundle({
		name: "trace.afr.jsonl",
		traceText: "",
		privacyReportText: '{"ok":"yes","checks":["metadata-only"]}',
		reconciliationReportText:
			'{"ok":true,"sources":[null,{"source":"codex","status":"ok"},{"source":4}]}',
	});

	assert.equal(bundle.reportStatuses.privacyReport, "invalid");
	assert.equal(bundle.privacyReport?.ok, undefined);
	assert.deepEqual(bundle.privacyReport?.checks, ["metadata-only"]);
	assert.equal(bundle.reportStatuses.reconciliationReport, "invalid");
	assert.deepEqual(bundle.reconciliationReport?.sources, [
		{ source: "codex", status: "ok" },
	]);
	assert.deepEqual(bundle.diagnostics.map((diagnostic) => diagnostic.message), [
		"privacyReport.ok: expected a valid value",
		"reconciliationReport.sources[0]: expected an object; row skipped",
		"reconciliationReport.sources[2].source: expected a valid value",
	]);
});

test("parseAfrBundle distinguishes absent, invalid roots, and valid reports", () => {
	const bundle = parseAfrBundle({
		name: "trace.afr.jsonl",
		traceText: "",
		privacyReportText: "null",
		validationReportText: '{"ok":true,"warnings":[]}',
	});

	assert.equal(bundle.reportStatuses.privacyReport, "invalid");
	assert.equal(bundle.reportStatuses.validationReport, "valid");
	assert.equal(bundle.reportStatuses.reconciliationReport, "absent");
	assert.equal(bundle.reportStatuses.manifest, "absent");
	assert.deepEqual(bundle.diagnostics, [
		{
			report: "privacyReport",
			status: "invalid",
			message: "privacyReport: expected an object",
		},
	]);
});

test("parseAfrBundle parses archive names even when given a dropped file path", () => {
	const bundle = parseAfrBundle({
		name: "20260628T120000Z-latest/trace.afr.jsonl",
		traceText: "",
	});

	assert.equal(bundle.archiveSuffix, "latest");
	assert.equal(bundle.createdAt, "2026-06-28T12:00:00Z");
});

test("parseAfrBundle infers all-source archives when file inputs lose folder names", () => {
	const bundle = parseAfrBundle({
		name: "trace.afr.jsonl",
		traceText: "",
		manifestText:
			'{"expected_counts":{"sources":{"artifact-store":1,"bridge-db":1,"codex":1,"cost-tracker":1,"evals":1,"notification-hub":1,"personal-ops":1}}}',
		reconciliationReportText:
			'{"ok":true,"sources":[{"source":"artifact-store"},{"source":"bridge-db"},{"source":"codex"},{"source":"cost-tracker"},{"source":"evals"},{"source":"notification-hub"},{"source":"personal-ops"}]}',
	});

	assert.equal(bundle.archiveSuffix, "all");
	assert.equal(bundle.createdAt, null);
});
