import assert from "node:assert/strict";
import { test } from "node:test";

import type { AfrBundle } from "../afr/types.ts";
import { analyzeControlBundle } from "./engine.ts";

function bundle(overrides: Partial<AfrBundle> = {}): AfrBundle {
	return {
		name: "20260628T120000Z-all",
		records: [],
		malformedRecords: 0,
		archiveSuffix: "all",
		createdAt: "2026-06-28T12:00:00Z",
		privacyReport: { ok: true },
		validationReport: { ok: true },
		reconciliationReport: { ok: true, sources: {} },
		manifest: null,
		...overrides,
	};
}

test("analyzeControlBundle flags stale non-all archives as first-class findings", () => {
	const report = analyzeControlBundle(
		bundle({
			name: "20260620T120000Z-latest",
			archiveSuffix: "latest",
			createdAt: "2026-06-20T12:00:00Z",
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);

	assert.equal(report.findings[0].id, "missing_all_source_archive");
	assert.ok(report.findings.some((finding) => finding.id === "stale_source"));
	assert.equal(
		report.findings.find((finding) => finding.id === "missing_all_source_archive")
			?.nextCommand,
		"uv run afr-local collect all --limit 50",
	);
});

test("privacy and validation failures outrank freshness warnings", () => {
	const report = analyzeControlBundle(
		bundle({
			name: "20260620T120000Z-latest",
			archiveSuffix: "latest",
			createdAt: "2026-06-20T12:00:00Z",
			privacyReport: { ok: false, violations: [{ code: "p0" }] },
			validationReport: { ok: false, errors: [{ code: "schema" }] },
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);

	assert.equal(report.findings[0].severity, "critical");
	assert.deepEqual(
		report.findings.slice(0, 2).map((finding) => finding.id),
		["privacy_violation", "validation_failure"],
	);
});

test("reconciliation warnings preserve source next commands", () => {
	const report = analyzeControlBundle(
		bundle({
			reconciliationReport: {
				ok: false,
				sources: {
					bridge_db: {
						status: "warning",
						warnings: ["missing_freshness"],
						next_command: "uv run afr-local collect bridge-db",
					},
				},
			},
		}),
	);

	const finding = report.findings.find(
		(item) => item.id === "reconciliation_warning:bridge_db",
	);
	assert.equal(finding?.severity, "warning");
	assert.equal(finding?.sourceSystems[0], "bridge_db");
	assert.equal(finding?.nextCommand, "uv run afr-local collect bridge-db");
});

test("reconciliation warnings support local collector source rows", () => {
	const report = analyzeControlBundle(
		bundle({
			reconciliationReport: {
				ok: false,
				sources: [
					{
						source: "evals",
						status: "warning",
						warnings: ["source_reported_errors"],
						next_command: "afr-local latest timeline --source evals --limit 20",
					},
				],
			},
		}),
	);

	const finding = report.findings.find(
		(item) => item.id === "reconciliation_warning:evals",
	);
	assert.equal(finding?.severity, "warning");
	assert.equal(finding?.sourceSystems[0], "evals");
	assert.equal(
		finding?.nextCommand,
		"afr-local latest timeline --source evals --limit 20",
	);
});

test("reconciliation warnings get a safe inspect command when source rows omit one", () => {
	const report = analyzeControlBundle(
		bundle({
			reconciliationReport: {
				ok: false,
				sources: [
					{
						source: "cost-tracker",
						status: "warning",
						warnings: ["source_reported_errors"],
					},
				],
			},
		}),
	);

	const finding = report.findings.find(
		(item) => item.id === "reconciliation_warning:cost-tracker",
	);
	assert.equal(
		finding?.nextCommand,
		"uv run afr-local latest reconciliation --source cost-tracker",
	);
	assert.equal(report.actions[0]?.category, "inspect");
	assert.equal(
		report.actions[0]?.command,
		"uv run afr-local latest reconciliation --source cost-tracker",
	);
});


test("failure, cost, and boundary records become ranked evidence findings", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "f1",
					record_type: "failure_marker",
					source_system: "codex",
					privacy_tier: "P2",
					timestamp: "2026-06-28T12:00:01Z",
				},
				{
					record_id: "c1",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					privacy_tier: "P1",
					timestamp: "2026-06-28T12:00:02Z",
				},
				{
					record_id: "b1",
					record_type: "event",
					event_kind: "mcp_permission",
					source_system: "codex",
					privacy_tier: "P2",
					timestamp: "2026-06-28T12:00:03Z",
				},
			],
		}),
	);

	assert.ok(report.findings.some((finding) => finding.id === "failure_marker"));
	assert.ok(report.findings.some((finding) => finding.id === "cost_attention"));
	assert.ok(report.findings.some((finding) => finding.id === "boundary_event"));
	assert.equal(
		report.findings.find((finding) => finding.id === "cost_attention")
			?.privacyTier,
		"P1",
	);
});

test("cost signals include amount quality and become warning when estimated", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "c1",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					privacy_tier: "P0",
					amount_usd: 12.5,
					cost_quality: "authoritative",
					timestamp: "2026-06-28T12:00:02Z",
				},
				{
					record_id: "c2",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					privacy_tier: "P0",
					amount_usd: 3,
					cost_quality: "estimated",
					timestamp: "2026-06-28T12:00:03Z",
				},
			],
		}),
	);

	const finding = report.findings.find((item) => item.id === "cost_attention");
	assert.equal(finding?.severity, "warning");
	assert.match(finding?.costSignal ?? "", /\$15\.50/);
	assert.match(finding?.costSignal ?? "", /1 estimated/);
});

test("validation warnings are surfaced even when validation ok is true", () => {
	const report = analyzeControlBundle(
		bundle({
			validationReport: { ok: true, warnings: ["estimated_cost"] },
		}),
	);

	const finding = report.findings.find((item) => item.id === "validation_warning");
	assert.equal(finding?.severity, "warning");
	assert.match(finding?.title ?? "", /1 validation warning/);
});

test("failed eval observations become outcome findings", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "e1",
					record_type: "eval_observation",
					source_system: "evals",
					validation_status: "failed",
					status: "failed",
					privacy_tier: "P0",
					timestamp: "2026-06-28T12:00:01Z",
				},
			],
		}),
	);

	const finding = report.findings.find((item) => item.id === "eval_failure");
	assert.equal(finding?.severity, "warning");
	assert.equal(finding?.sourceSystems[0], "evals");
	assert.match(finding?.outcomeSignal ?? "", /failed eval/);
});

test("bridge-db pending handoff records become control findings", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "h1",
					record_type: "span",
					source_system: "bridge-db",
					privacy_tier: "P0",
					timestamp: "2026-06-28T12:00:01Z",
					attributes: { handoff_status: "pending" },
				},
			],
		}),
	);

	const finding = report.findings.find(
		(item) => item.id === "bridge_pending_handoff",
	);
	assert.equal(finding?.severity, "warning");
	assert.equal(finding?.nextCommand, "bridge-db:get_pending_handoffs");
});

test("summary includes per-source freshness", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "old",
					record_type: "event",
					source_system: "bridge-db",
					timestamp: "2026-06-20T12:00:00Z",
				},
				{
					record_id: "fresh",
					record_type: "event",
					source_system: "codex",
					timestamp: "2026-06-28T11:00:00Z",
				},
			],
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);

	assert.equal(report.summary.sourceFreshness["bridge-db"]?.freshness, "stale");
	assert.equal(report.summary.sourceFreshness.codex?.freshness, "fresh");
	assert.ok(
		report.findings.some((finding) => finding.id === "stale_source:bridge-db"),
	);
	assert.ok(
		report.actions.some(
			(action) =>
				action.category === "refresh" &&
				action.findingIds.includes("stale_source:bridge-db"),
		),
	);
});

test("control actions group repeated safe commands by priority and source", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "old-a",
					record_type: "event",
					source_system: "artifact-store",
					timestamp: "2026-06-20T12:00:00Z",
				},
				{
					record_id: "old-e",
					record_type: "eval_observation",
					source_system: "evals",
					timestamp: "2026-06-20T12:00:00Z",
				},
			],
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);

	const refresh = report.actions.find(
		(action) =>
			action.category === "refresh" &&
			action.command === "uv run afr-local collect all --limit 50",
	);
	assert.deepEqual(refresh?.sourceSystems, ["artifact-store", "evals"]);
	assert.deepEqual(refresh?.findingIds, [
		"stale_source:artifact-store",
		"stale_source:evals",
	]);
	assert.equal(refresh?.title, "Refresh 2 sources");
});

test("malformed records are surfaced as archive integrity risk", () => {
	const report = analyzeControlBundle(bundle({ malformedRecords: 2 }));
	const finding = report.findings.find(
		(item) => item.id === "malformed_records",
	);
	assert.equal(finding?.severity, "warning");
	assert.match(finding?.title ?? "", /2/);
});
