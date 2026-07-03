import assert from "node:assert/strict";
import { test } from "node:test";

import type { AfrBundle } from "../afr/types.ts";
import {
	analyzeControlBundle,
	buildActionBundlePreview,
	buildCommandSafetyLedger,
	compareCommandActions,
	emptyPresetGuidance,
	exportActionBundle,
	exportDecisionNote,
	exportMetadataEvidenceRefs,
	exportRunnableReadOnlyCommands,
	filterControlReportBySourcePreset,
	previewImportedActionBundle,
} from "./engine.ts";

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
			records: [
				{
					record_id: "old-codex",
					record_type: "event",
					source_system: "codex",
					timestamp: "2026-06-20T12:00:00Z",
				},
			],
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);

	assert.equal(report.findings[0].id, "stale_source:codex");
	assert.ok(report.findings.some((finding) => finding.id === "stale_source"));
	assert.ok(report.findings.some((finding) => finding.id === "stale_source:codex"));
	assert.equal(
		report.findings.find((finding) => finding.id === "missing_all_source_archive")
			?.nextCommand,
		"uv run afr-local collect all --limit 50",
	);
	const inspect = report.actions.find(
		(action) =>
			action.command ===
			"uv run afr-local latest timeline --source codex --limit 20",
	);
	assert.equal(inspect?.commandSafety, "read_only");
	assert.equal(inspect?.commandReadiness.state, "runnable_now");
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

test("reconciliation error rows surface even without warning codes", () => {
	const report = analyzeControlBundle(
		bundle({
			reconciliationReport: {
				ok: false,
				sources: [
					{
						source: "bridge-db",
						status: "error",
					},
				],
			},
		}),
	);

	const finding = report.findings.find(
		(item) => item.id === "reconciliation_warning:bridge-db",
	);
	assert.equal(finding?.severity, "critical");
	assert.equal(finding?.sourceSystems[0], "bridge-db");
	assert.equal(
		finding?.nextCommand,
		"uv run afr-local latest reconciliation --source bridge-db",
	);
	assert.equal(report.actions[0]?.severity, "critical");
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
	assert.ok(
		report.findings.some((finding) => finding.id === "boundary_event:codex"),
	);
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

test("validation warnings are attributed to dominant cost-quality buckets", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "cost-row",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					timestamp: "2026-06-28T12:00:00Z",
				},
			],
			validationReport: {
				ok: true,
				warnings: [
					"line 124: cost-tracker-snapshot-20260702T000000Z-session-0016: cost quality is estimated",
					"line 124: cost-tracker-snapshot-20260702T000000Z-session-0016: correlation confidence is heuristic",
					"bundle contains multiple trace_id values: cost-tracker-snapshot-20260702T000000Z",
				],
			},
		}),
	);

	const finding = report.findings.find((item) => item.id === "validation_warning");
	assert.deepEqual(finding?.sourceSystems, ["cost-tracker"]);
	assert.match(finding?.detail ?? "", /cost_quality_estimated 1/);
	assert.match(finding?.detail ?? "", /correlation_confidence_heuristic 1/);
	assert.match(finding?.validationSignal ?? "", /likely source cost-tracker 2/);
	assert.equal(finding?.freshness, "stale");
	assert.equal(finding?.nextCommand, "uv run afr-local latest costs --limit 5");
	const action = report.actions.find((item) =>
		item.findingIds.includes("validation_warning"),
	);
	assert.equal(action?.command, "uv run afr-local latest costs --limit 5");
	assert.equal(action?.title, "Review estimated cost signals");
	assert.equal(action?.trace[0]?.validationSignal, finding?.validationSignal);
	assert.match(
		exportActionBundle(action!).text,
		/Decision Flight Deck action bundle: Review estimated cost signals/,
	);
	assert.match(
		exportActionBundle(action!).text,
		/validation=correlation_confidence_heuristic 1 \/ cost_quality_estimated 1/,
	);
});

test("non-cost validation warnings keep validate command and archive source scope", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "codex-row",
					record_type: "event",
					source_system: "codex",
					timestamp: "2026-06-28T12:00:00Z",
				},
			],
			validationReport: {
				ok: true,
				warnings: ["line 2: codex-record missing required field"],
			},
		}),
	);

	const finding = report.findings.find((item) => item.id === "validation_warning");
	assert.deepEqual(finding?.sourceSystems, ["codex"]);
	assert.match(finding?.validationSignal ?? "", /schema_field 1/);
	assert.equal(finding?.nextCommand, "uv run afr validate <archive>");
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
					attributes: {
						command_results_count: 1,
						tests_failed_count: 2,
						tests_passed_count: 1,
					},
				},
			],
		}),
	);

	const finding = report.findings.find((item) => item.id === "eval_failure");
	assert.equal(finding?.severity, "warning");
	assert.equal(finding?.sourceSystems[0], "evals");
	assert.match(finding?.detail ?? "", /redacted by AFR privacy policy/);
	assert.match(finding?.outcomeSignal ?? "", /1 failed eval/);
	assert.match(finding?.outcomeSignal ?? "", /2 failed test assertions/);
	assert.match(finding?.outcomeSignal ?? "", /1 passed assertion/);
	assert.match(finding?.outcomeSignal ?? "", /1 command result/);
	assert.equal(
		finding?.nextCommand,
		"uv run afr-local latest timeline --source evals --limit 20",
	);
});

test("failed eval observations stay useful when assertion counts are redacted", () => {
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
					evidence_ref: "evals:root-1#file-1",
				},
				{
					record_id: "e2",
					record_type: "eval_observation",
					source_system: "evals",
					validation_status: "failed",
					status: "failed",
					privacy_tier: "P0",
					timestamp: "2026-06-28T12:10:01Z",
					evidence_ref: "evals:root-1#file-1",
				},
			],
		}),
	);

	const finding = report.findings.find((item) => item.id === "eval_failure");
	assert.equal(finding?.severity, "warning");
	assert.match(
		finding?.outcomeSignal ?? "",
		/failed status without exposed assertion count/,
	);
	assert.match(
		finding?.outcomeSignal ?? "",
		/failed window 2026-06-28T12:00:01Z to 2026-06-28T12:10:01Z/,
	);
	assert.deepEqual(finding?.evidenceRefs, ["evals:root-1#file-1"]);
	assert.equal(
		report.actions.find((action) =>
			action.findingIds.includes("eval_failure"),
		)?.title,
		"Route eval maintenance",
	);
	assert.equal(
		report.actions.find((action) =>
			action.findingIds.includes("eval_failure"),
		)?.decisionReason,
		"warning eval failures",
	);
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
	assert.equal(finding?.boundaryEvent, "bridge handoff pressure");
	assert.equal(finding?.nextCommand, "bridge-db:get_pending_handoffs");
	const action = report.actions.find((item) =>
		item.findingIds.includes("bridge_pending_handoff"),
	);
	assert.equal(action?.title, "Review bridge handoffs");
	assert.equal(action?.decisionReason, "bridge handoff pressure");
	assert.deepEqual(action?.boundaryEvents, ["bridge handoff pressure"]);
	assert.match(action?.safetyNote ?? "", /bridge-db read tool/);
	assert.equal(action?.commandSafety, "read_only");
	assert.deepEqual(action?.sourceExplanations, [
		{
			source: "bridge-db",
			freshness: "stale",
			freshnessReason: "derived from newest source record timestamp",
		},
	]);
});

test("boundary event actions use source contract wording", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "n1",
					record_type: "event",
					event_kind: "guardrail_delivery",
					source_system: "notification-hub",
					privacy_tier: "P2",
					timestamp: "2026-06-28T12:00:01Z",
				},
			],
		}),
	);

	const action = report.actions.find((item) =>
		item.findingIds.includes("boundary_event:notification-hub"),
	);
	const finding = report.findings.find(
		(item) => item.id === "boundary_event:notification-hub",
	);
	assert.equal(finding?.boundaryEvent, "notification delivery boundary");
	assert.equal(action?.title, "Inspect notification routing");
	assert.equal(action?.decisionReason, "notification delivery boundary");
	assert.deepEqual(action?.boundaryEvents, ["notification delivery boundary"]);
	assert.equal(
		action?.command,
		"uv run afr-local latest timeline --source notification-hub --limit 20",
	);
	assert.match(action?.safetyNote ?? "", /latest local AFR metadata archive/);
	assert.equal(action?.sourceExplanations[0]?.source, "notification-hub");
});

test("hook and MCP source contracts provide boundary wording", () => {
	const hookReport = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "hook1",
					record_type: "event",
					event_kind: "pre_tool_hook",
					source_system: "codex-hooks",
					timestamp: "2026-06-28T12:00:01Z",
				},
			],
		}),
	);
	const mcpReport = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "mcp1",
					record_type: "event",
					event_kind: "mcp_permission",
					source_system: "mcp-config",
					timestamp: "2026-06-28T12:00:01Z",
				},
			],
		}),
	);

	assert.equal(
		hookReport.actions.find((item) =>
			item.findingIds.includes("boundary_event:codex-hooks"),
		)?.title,
		"Inspect hook boundary",
	);
	assert.equal(
		hookReport.actions.find((item) =>
			item.findingIds.includes("boundary_event:codex-hooks"),
		)?.decisionReason,
		"hook boundary event",
	);
	assert.deepEqual(
		hookReport.actions.find((item) =>
			item.findingIds.includes("boundary_event:codex-hooks"),
		)?.boundaryEvents,
		["hook boundary event"],
	);
	assert.equal(
		mcpReport.actions.find((item) =>
			item.findingIds.includes("boundary_event:mcp-config"),
		)?.title,
		"Inspect MCP boundary",
	);
	assert.equal(
		mcpReport.actions.find((item) =>
			item.findingIds.includes("boundary_event:mcp-config"),
		)?.decisionReason,
		"MCP boundary event",
	);
	assert.deepEqual(
		mcpReport.actions.find((item) =>
			item.findingIds.includes("boundary_event:mcp-config"),
		)?.boundaryEvents,
		["MCP boundary event"],
	);
});

test("mixed boundary sources produce separate action rows", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "hook1",
					record_type: "event",
					event_kind: "pre_tool_hook",
					source_system: "codex-hooks",
					timestamp: "2026-06-28T12:00:01Z",
				},
				{
					record_id: "mcp1",
					record_type: "event",
					event_kind: "mcp_permission",
					source_system: "mcp-config",
					timestamp: "2026-06-28T12:00:02Z",
				},
				{
					record_id: "notify1",
					record_type: "event",
					event_kind: "guardrail_delivery",
					source_system: "notification-hub",
					timestamp: "2026-06-28T12:00:03Z",
				},
			],
		}),
	);

	assert.deepEqual(
		report.findings
			.filter((finding) => finding.kind === "boundary_event")
			.map((finding) => finding.id)
			.sort(),
		[
			"boundary_event:codex-hooks",
			"boundary_event:mcp-config",
			"boundary_event:notification-hub",
		],
	);
	assert.deepEqual(
		report.actions
			.filter((action) =>
				action.findingIds.some((id) => id.startsWith("boundary_event:")),
			)
			.map((action) => action.title)
			.sort(),
		[
			"Inspect MCP boundary",
			"Inspect hook boundary",
			"Inspect notification routing",
		],
	);
	assert.deepEqual(
		report.actions
			.filter((action) =>
				action.findingIds.some((id) => id.startsWith("boundary_event:")),
			)
			.map((action) => action.boundaryEvents[0])
			.sort(),
		[
			"MCP boundary event",
			"hook boundary event",
			"notification delivery boundary",
		],
	);
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
	assert.equal(
		report.summary.sourceFreshness["bridge-db"]?.reason,
		"derived from newest source record timestamp",
	);
	assert.ok(
		report.findings.some((finding) => finding.id === "stale_source:bridge-db"),
	);
	assert.ok(
		report.actions.some(
			(action) =>
				action.category === "inspect" &&
				action.findingIds.includes("stale_source:bridge-db"),
		),
	);
	assert.equal(
		report.findings.find((finding) => finding.id === "stale_source:bridge-db")
			?.nextCommand,
		"uv run afr-local latest timeline --source bridge-db --limit 20",
	);
});

test("source-bound findings use source freshness rather than archive freshness", () => {
	const report = analyzeControlBundle(
		bundle({
			createdAt: "2026-07-03T02:26:52Z",
			records: [
				{
					record_id: "fresh-bridge",
					record_type: "event",
					source_system: "bridge-db",
					timestamp: "2026-07-03T02:26:02Z",
				},
				{
					record_id: "old-eval",
					record_type: "eval_observation",
					source_system: "evals",
					validation_status: "failed",
					status: "failed",
					privacy_tier: "P0",
					timestamp: "2026-04-12T21:46:19Z",
					evidence_ref: "evals:root-1#file-1",
					attributes: { tests_failed_count: 1 },
				},
			],
		}),
		Date.parse("2026-07-03T06:10:00Z"),
	);

	assert.equal(report.summary.sourceFreshness["bridge-db"]?.freshness, "fresh");
	assert.equal(report.summary.sourceFreshness.evals?.freshness, "stale");
	assert.equal(
		report.findings.find((finding) => finding.id === "eval_failure")
			?.freshness,
		"stale",
	);
	assert.equal(
		report.actions
			.find((action) => action.findingIds.includes("eval_failure"))
			?.sourceExplanations.find((row) => row.source === "evals")?.freshness,
		"stale",
	);
});

test("healthy live cost feeds are fresh despite period-boundary timestamps", () => {
	const report = analyzeControlBundle(
		bundle({
			createdAt: "2026-07-03T02:00:00Z",
			records: [
				{
					record_id: "cost-day",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					timestamp: "2026-07-02T00:00:00Z",
					amount_usd: 12,
					cost_quality: "authoritative",
				},
			],
			reconciliationReport: {
				ok: true,
				sources: [
					{
						source: "cost-tracker",
						status: "ok",
						warnings: [],
						source_counts: { ccusage_live_used: true },
					},
				],
			},
		}),
		Date.parse("2026-07-03T02:30:00Z"),
	);

	assert.equal(
		report.summary.sourceFreshness["cost-tracker"]?.freshness,
		"fresh",
	);
	assert.match(
		report.summary.sourceFreshness["cost-tracker"]?.reason ?? "",
		/live ccusage/,
	);
	assert.equal(
		report.findings.some((finding) => finding.id === "stale_source:cost-tracker"),
		false,
	);
	assert.ok(report.findings.some((finding) => finding.id === "cost_attention"));
});

test("cost feeds with reconciliation warnings still surface stale source findings", () => {
	const report = analyzeControlBundle(
		bundle({
			createdAt: "2026-07-03T02:00:00Z",
			records: [
				{
					record_id: "cost-day",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					timestamp: "2026-07-02T00:00:00Z",
					amount_usd: 12,
					cost_quality: "authoritative",
				},
			],
			reconciliationReport: {
				ok: false,
				sources: [
					{
						source: "cost-tracker",
						status: "warning",
						warnings: ["source_reported_errors"],
						source_counts: { ccusage_live_used: true },
					},
				],
			},
		}),
		Date.parse("2026-07-03T02:30:00Z"),
	);

	assert.equal(
		report.summary.sourceFreshness["cost-tracker"]?.freshness,
		"stale",
	);
	assert.ok(
		report.findings.some((finding) => finding.id === "stale_source:cost-tracker"),
	);
});

test("healthy artifact-store samples are historical instead of stale", () => {
	const report = analyzeControlBundle(
		bundle({
			createdAt: "2026-07-03T02:00:00Z",
			records: [
				{
					record_id: "artifact-old",
					record_type: "artifact_ref",
					source_system: "artifact-store",
					timestamp: "2026-06-28T11:48:27Z",
				},
			],
			reconciliationReport: {
				ok: true,
				sources: [
					{
						source: "artifact-store",
						status: "ok",
						warnings: [],
						source_counts: { artifact_records_sampled: 50 },
					},
				],
			},
		}),
		Date.parse("2026-07-03T02:30:00Z"),
	);

	assert.equal(
		report.summary.sourceFreshness["artifact-store"]?.freshness,
		"historical",
	);
	assert.match(
		report.summary.sourceFreshness["artifact-store"]?.reason ?? "",
		/historical/,
	);
	assert.equal(
		report.findings.some((finding) => finding.id === "stale_source:artifact-store"),
		false,
	);
});

test("artifact-store reconciliation warnings still surface stale source findings", () => {
	const report = analyzeControlBundle(
		bundle({
			createdAt: "2026-07-03T02:00:00Z",
			records: [
				{
					record_id: "artifact-old",
					record_type: "artifact_ref",
					source_system: "artifact-store",
					timestamp: "2026-06-28T11:48:27Z",
				},
			],
			reconciliationReport: {
				ok: false,
				sources: [
					{
						source: "artifact-store",
						status: "warning",
						warnings: ["digest_skipped"],
						source_counts: { artifact_records_sampled: 50 },
					},
				],
			},
		}),
		Date.parse("2026-07-03T02:30:00Z"),
	);

	assert.equal(
		report.summary.sourceFreshness["artifact-store"]?.freshness,
		"stale",
	);
	assert.ok(
		report.findings.some((finding) => finding.id === "stale_source:artifact-store"),
	);
});

test("stale all-source archives do not fan out per-source stale findings", () => {
	const report = analyzeControlBundle(
		bundle({
			createdAt: "2026-06-20T12:00:00Z",
			records: [
				{
					record_id: "old-bridge",
					record_type: "event",
					source_system: "bridge-db",
					timestamp: "2026-06-20T12:00:00Z",
				},
				{
					record_id: "old-codex",
					record_type: "event",
					source_system: "codex",
					timestamp: "2026-06-20T12:00:00Z",
				},
			],
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);

	assert.ok(report.findings.some((finding) => finding.id === "stale_source"));
	assert.equal(
		report.findings.some((finding) => finding.id === "stale_source:bridge-db"),
		false,
	);
	assert.equal(
		report.findings.some((finding) => finding.id === "stale_source:codex"),
		false,
	);
	assert.equal(report.summary.sourceFreshness["bridge-db"]?.freshness, "stale");
	assert.equal(report.summary.sourceFreshness.codex?.freshness, "stale");
	assert.deepEqual(
		report.actions.find((action) => action.category === "refresh")?.findingIds,
		["stale_source"],
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

	const inspect = report.actions.find(
		(action) =>
			action.category === "inspect" &&
			action.command ===
				"uv run afr-local latest timeline --source artifact-store --limit 20",
	);
	assert.deepEqual(inspect?.sourceSystems, ["artifact-store"]);
	assert.deepEqual(inspect?.findingIds, ["stale_source:artifact-store"]);
	assert.equal(inspect?.title, "Inspect artifact-store");
	assert.ok(
		report.actions.some(
			(action) =>
				action.category === "inspect" &&
				action.command ===
					"uv run afr-local latest timeline --source evals --limit 20",
		),
	);
});

test("route actions get source-specific decision titles", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "c1",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					timestamp: "2026-06-28T12:00:00Z",
					cost_quality: "estimated",
				},
			],
		}),
	);

	const action = report.actions.find((item) =>
		item.findingIds.includes("cost_attention"),
	);
	assert.equal(action?.category, "route");
	assert.equal(action?.title, "Review cost routing");
	assert.equal(action?.decisionReason, "estimated cost signal");
});

test("inspect actions explain stale source reasons", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
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

	const action = report.actions.find((item) =>
		item.findingIds.includes("stale_source:evals"),
	);
	assert.equal(action?.category, "inspect");
	assert.equal(action?.decisionReason, "stale evals source");
});

test("actions merge route and inspect pressure for the same command", () => {
	const report = analyzeControlBundle(
		bundle({
			createdAt: "2026-07-03T02:00:00Z",
			records: [
				{
					record_id: "old-eval",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					validation_status: "failed",
					timestamp: "2026-04-13T05:59:47Z",
					attributes: { tests_failed_count: 2 },
				},
				{
					record_id: "old-eval-2",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					validation_status: "failed",
					timestamp: "2026-04-13T06:00:47Z",
				},
				{
					record_id: "old-eval-3",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					validation_status: "failed",
					timestamp: "2026-04-13T06:01:47Z",
				},
			],
		}),
		Date.parse("2026-07-03T02:30:00Z"),
	);

	const actions = report.actions.filter(
		(action) =>
			action.command === "uv run afr-local latest timeline --source evals --limit 20",
	);
	assert.equal(actions.length, 1);
	assert.deepEqual(actions[0]?.findingIds.sort(), [
		"eval_failure",
		"stale_source:evals",
	]);
	assert.equal(actions[0]?.category, "route");
	assert.deepEqual(actions[0]?.categories, ["inspect", "route"]);
	assert.equal(actions[0]?.title, "Route eval maintenance");
	assert.deepEqual(actions[0]?.decisionReasons, [
		"critical eval failures",
		"stale evals source",
	]);
	assert.match(actions[0]?.safetyNote ?? "", /latest local AFR metadata archive/);
	assert.equal(actions[0]?.commandSafety, "read_only");
	assert.equal(actions[0]?.commandReadiness.state, "runnable_now");
	assert.match(
		actions[0]?.commandReadiness.reason ?? "",
		/read-only local inspection/,
	);
	assert.match(actions[0]?.preview.boundary ?? "", /Read-only inspection/);
	assert.deepEqual(actions[0]?.preview.why, [
		"critical eval failures",
		"stale evals source",
	]);
	assert.deepEqual(actions[0]?.preview.evidenceRefs, [
		"old-eval",
		"old-eval-2",
		"old-eval-3",
		"2026-04-13T06:01:47.000Z",
	]);
	assert.deepEqual(actions[0]?.sourceExplanations, [
		{
			source: "evals",
			freshness: "stale",
			freshnessReason: "derived from newest source record timestamp",
		},
	]);
});

test("refresh actions explain local collection side effects", () => {
	const report = analyzeControlBundle(
		bundle({
			name: "20260620T120000Z-latest",
			archiveSuffix: "latest",
			createdAt: "2026-06-20T12:00:00Z",
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);

	const action = report.actions.find(
		(item) => item.command === "uv run afr-local collect all --limit 50",
	);
	assert.match(action?.safetyNote ?? "", /Creates a fresh local AFR metadata archive/);
	assert.equal(action?.commandSafety, "local_write");
	assert.equal(action?.commandReadiness.state, "needs_approval");
	assert.match(action?.commandReadiness.reason ?? "", /Creates local artifacts/);
	assert.match(action?.preview.boundary ?? "", /Local write/);
	assert.deepEqual(action?.preview.evidenceRefs, [
		"20260620T120000Z-latest",
		"2026-06-20T12:00:00Z",
	]);
	assert.equal(action?.sourceExplanations.length, 0);
});

test("validation actions are classified as read-only commands", () => {
	const report = analyzeControlBundle(
		bundle({
			validationReport: { ok: false, errors: [{ code: "schema" }] },
		}),
	);

	const action = report.actions.find(
		(item) => item.command === "uv run afr validate <archive>",
	);
	assert.equal(action?.commandSafety, "read_only");
	assert.equal(action?.commandReadiness.state, "needs_placeholder");
	assert.match(action?.commandReadiness.reason ?? "", /placeholder/);
	assert.match(action?.safetyNote ?? "", /without uploading archive contents/);
});

test("command export includes only runnable read-only actions", () => {
	const report = analyzeControlBundle(
		bundle({
			name: "20260620T120000Z-latest",
			archiveSuffix: "latest",
			createdAt: "2026-06-20T12:00:00Z",
			validationReport: { ok: false, errors: [{ code: "schema" }] },
			records: [
				{
					record_id: "cost-1",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					privacy_tier: "P2",
					status: "ok",
					timestamp: "2026-06-20T12:01:00Z",
					amount_usd: 1.5,
					cost_quality: "authoritative",
				},
				{
					record_id: "eval-1",
					record_type: "eval_observation",
					source_system: "evals",
					privacy_tier: "P2",
					status: "failed",
					timestamp: "2026-06-20T12:02:00Z",
				},
			],
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);

	const commandExport = exportRunnableReadOnlyCommands(report.actions);

	assert.deepEqual(commandExport.commands, [
		"uv run afr-local latest timeline --source evals --limit 20",
		"uv run afr-local latest timeline --source cost-tracker --limit 20",
		"uv run afr-local latest costs --limit 5",
	]);
	assert.match(
		commandExport.text,
		/^# Decision Flight Deck runnable read-only commands\n/,
	);
	assert.equal(commandExport.includedCount, 3);
	assert.equal(commandExport.excludedCount, 2);
	assert.deepEqual(commandExport.excludedReasons, [
		{ reason: "needs_placeholder", count: 1 },
		{ reason: "needs_approval", count: 1 },
	]);
	assert.doesNotMatch(commandExport.text, /<archive>/);
	assert.doesNotMatch(commandExport.text, /collect all/);
});

test("command safety ledger groups all surfaced commands by safety", () => {
	const report = analyzeControlBundle(
		bundle({
			name: "20260620T120000Z-latest",
			archiveSuffix: "latest",
			createdAt: "2026-06-20T12:00:00Z",
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-20T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
			],
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);
	const ledger = buildCommandSafetyLedger(report.actions);
	const readOnly = ledger.groups.find((group) => group.safety === "read_only");
	const localWrite = ledger.groups.find((group) => group.safety === "local_write");

	assert.equal(ledger.totalCount, report.actions.length);
	assert.equal(ledger.exportEligibleCount, readOnly?.actions.length);
	assert.ok(
		readOnly?.actions.some((action) =>
			action.command.includes("latest timeline --source evals"),
		),
	);
	assert.ok(readOnly?.actions.every((action) => action.exportEligible));
	assert.ok(
		localWrite?.actions.some((action) =>
			action.command.includes("afr-local collect all"),
		),
	);
	assert.ok(localWrite?.actions.every((action) => !action.exportEligible));
	assert.deepEqual(
		ledger.groups.map((group) => group.safety),
		["read_only", "local_write", "external_write", "unknown"],
	);
});

test("command delta preview shows appeared hidden and changed commands", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
				{
					record_id: "bridge-db:handoff-1",
					record_type: "handoff",
					source_system: "bridge-db",
					timestamp: "2026-06-28T12:03:00Z",
					evidence_ref: "bridge-db:handoff-1",
					attributes: { handoff_status: "pending" },
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const evals = filterControlReportBySourcePreset(report, "evals");
	const hiddenDelta = compareCommandActions(report.actions, evals.actions);
	const appearedDelta = compareCommandActions(evals.actions, report.actions);
	const changedDelta = compareCommandActions(report.actions, [
		{
			...report.actions[0]!,
			title: `${report.actions[0]!.title} changed`,
			commandSafety: "unknown",
			commandReadiness: {
				state: "needs_approval",
				reason: "operator approval required",
			},
		},
		...report.actions.slice(1),
	]);

	assert.equal(hiddenDelta.appeared.length, 0);
	assert.ok(hiddenDelta.disappeared.length > 0);
	assert.ok(
		hiddenDelta.disappeared.some((action) =>
			action.command.includes("--source bridge-db"),
		),
	);
	assert.ok(appearedDelta.appeared.length > 0);
	assert.equal(changedDelta.changed.length, 1);
	assert.equal(changedDelta.changed[0]?.beforeSafety, "read_only");
	assert.equal(changedDelta.changed[0]?.afterSafety, "unknown");
	assert.equal(changedDelta.changed[0]?.afterReadiness.state, "needs_approval");
	assert.equal(
		changedDelta.unchangedCount,
		report.actions.length - changedDelta.changed.length,
	);
});

test("metadata evidence export groups refs by source and excludes raw-looking values", () => {
	const evidenceExport = exportMetadataEvidenceRefs({
		title: "Review bridge handoffs",
		sourceSystems: ["bridge-db", "evals"],
		evidenceRefs: [
			"bridge-db:handoff-21",
			"evals:case-3#run",
			"bridge-db:handoff-21",
			"{\"raw\":\"row\"}",
			"line one\nline two",
		],
	});

	assert.deepEqual(evidenceExport.groups, [
		{ source: "bridge-db", refs: ["bridge-db:handoff-21"] },
		{ source: "evals", refs: ["evals:case-3#run"] },
	]);
	assert.equal(evidenceExport.includedCount, 2);
	assert.equal(evidenceExport.excludedCount, 2);
	assert.match(
		evidenceExport.text,
		/^# Decision Flight Deck evidence refs: Review bridge handoffs/,
	);
	assert.match(evidenceExport.text, /## bridge-db\n- bridge-db:handoff-21/);
	assert.doesNotMatch(evidenceExport.text, /raw/);
	assert.doesNotMatch(evidenceExport.text, /line two/);
});

test("action bundle preview summarizes command eligibility and evidence refs", () => {
	const report = analyzeControlBundle(
		bundle({
			name: "20260620T120000Z-latest",
			archiveSuffix: "latest",
			createdAt: "2026-06-20T12:00:00Z",
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-20T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
			],
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);

	const route = report.actions.find(
		(action) =>
			action.command === "uv run afr-local latest timeline --source evals --limit 20",
	);
	const refresh = report.actions.find(
		(action) => action.command === "uv run afr-local collect all --limit 50",
	);
	const routePreview = buildActionBundlePreview(route!);
	const refreshPreview = buildActionBundlePreview(refresh!);

	assert.equal(routePreview.commandExportEligible, true);
	assert.equal(routePreview.commandSafety, "read_only");
	assert.equal(routePreview.commandReadiness.state, "runnable_now");
	assert.equal(routePreview.evidenceRefCount, 2);
	assert.deepEqual(routePreview.evidenceSources, ["evals", "metadata"]);
	assert.match(routePreview.boundary, /Read-only inspection/);
	assert.equal(refreshPreview.commandExportEligible, false);
	assert.equal(refreshPreview.commandSafety, "local_write");
	assert.equal(refreshPreview.commandReadiness.state, "needs_approval");
});

test("action bundle export includes only runnable read-only command preflight", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const route = report.actions.find(
		(action) =>
			action.command === "uv run afr-local latest timeline --source evals --limit 20",
	);
	const actionBundle = exportActionBundle(route!);

	assert.equal(actionBundle.preview.commandExportEligible, true);
	assert.match(
		actionBundle.text,
		/^# Decision Flight Deck action bundle: Route eval maintenance/,
	);
	assert.match(actionBundle.text, /## Command\nuv run afr-local latest timeline/);
	assert.match(actionBundle.text, /- export: eligible/);
	assert.match(actionBundle.text, /- safety: read_only/);
	assert.match(actionBundle.text, /- readiness: runnable_now/);
	assert.match(actionBundle.text, /## Why this command exists/);
	assert.match(actionBundle.text, /- eval_failure \[warning\]/);
	assert.match(actionBundle.text, /sources=evals/);
	assert.match(actionBundle.text, /outcome=1 failed eval observation/);
	assert.match(actionBundle.text, /refs=1/);
	assert.match(actionBundle.text, /## evals\n- evals:case-1/);
});

test("action bundle export blocks approval-required commands", () => {
	const report = analyzeControlBundle(
		bundle({
			name: "20260620T120000Z-latest",
			archiveSuffix: "latest",
			createdAt: "2026-06-20T12:00:00Z",
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);
	const refresh = report.actions.find(
		(action) => action.command === "uv run afr-local collect all --limit 50",
	);
	const actionBundle = exportActionBundle(refresh!);

	assert.equal(actionBundle.preview.commandExportEligible, false);
	assert.equal(actionBundle.preview.commandSafety, "local_write");
	assert.equal(actionBundle.preview.commandReadiness.state, "needs_approval");
	assert.equal(actionBundle.text, "");
});

test("imported action bundle preview matches current runnable evidence", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const route = report.actions.find(
		(action) =>
			action.command === "uv run afr-local latest timeline --source evals --limit 20",
	);
	const exported = exportActionBundle(route!);
	const replay = previewImportedActionBundle(exported.text, report);

	assert.equal(replay.status, "matched");
	assert.equal(replay.command, route?.command);
	assert.equal(replay.matchedActionTitle, "Route eval maintenance");
	assert.deepEqual(replay.importedEvidenceRefs, ["evals:case-1"]);
	assert.deepEqual(replay.missingEvidenceRefs, []);
	assert.deepEqual(replay.warnings, []);
	assert.match(replay.operatorHint, /still matches this context/);
});

test("imported action bundle preview distinguishes hidden preset commands", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
				{
					record_id: "bridge-db:handoff-1",
					record_type: "handoff",
					source_system: "bridge-db",
					timestamp: "2026-06-28T12:03:00Z",
					evidence_ref: "bridge-db:handoff-1",
					attributes: { handoff_status: "pending" },
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const bridgeAction = report.actions.find((action) =>
		action.command.includes("--source bridge-db"),
	);
	const evals = filterControlReportBySourcePreset(report, "evals");
	const replay = previewImportedActionBundle(
		exportActionBundle(bridgeAction!).text,
		evals,
		report,
	);

	assert.equal(replay.status, "hidden_by_preset");
	assert.equal(replay.commandScope, "hidden_by_preset");
	assert.equal(replay.matchedActionTitle, bridgeAction?.title);
	assert.deepEqual(replay.missingEvidenceRefs, []);
	assert.match(replay.warnings[0] ?? "", /hidden by the active source preset/);
	assert.match(replay.operatorHint, /Switch to the all-source view/);
});

test("imported action bundle preview reports title safety and readiness drift", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const route = report.actions.find((action) =>
		action.command.includes("--source evals"),
	);
	const staleBundle = exportActionBundle(route!)
		.text.replace(
			"# Decision Flight Deck action bundle: Route eval maintenance",
			"# Decision Flight Deck action bundle: Old eval route",
		)
		.replace("- safety: read_only", "- safety: unknown")
		.replace("- readiness: runnable_now", "- readiness: needs_approval");
	const replay = previewImportedActionBundle(staleBundle, report);

	assert.equal(replay.status, "matched");
	assert.equal(replay.commandScope, "current_context");
	assert.deepEqual(replay.commandDrift, [
		"Title changed: Old eval route -> Route eval maintenance",
		"Safety changed: unknown -> read_only",
		"Readiness changed: needs_approval -> runnable_now",
	]);
	assert.match(replay.warnings.join("\n"), /Safety changed/);
	assert.match(replay.operatorHint, /still matches this context/);
});

test("imported action bundle preview reports missing commands", () => {
	const replay = previewImportedActionBundle(
		[
			"# Decision Flight Deck action bundle: Old command",
			"## Command",
			"uv run afr-local latest timeline --source missing --limit 20",
			"## Evidence refs",
			"- missing:case-1",
		].join("\n"),
		analyzeControlBundle(bundle()),
	);

	assert.equal(replay.status, "command_missing");
	assert.equal(replay.matchedActionId, null);
	assert.deepEqual(replay.missingEvidenceRefs, ["missing:case-1"]);
	assert.match(replay.warnings[0] ?? "", /not present/);
	assert.match(replay.operatorHint, /Inspect the loaded archive/);
});

test("imported action bundle preview reports missing metadata refs", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const route = report.actions.find(
		(action) =>
			action.command === "uv run afr-local latest timeline --source evals --limit 20",
	);
	const replay = previewImportedActionBundle(
		[
			"# Decision Flight Deck action bundle: Route eval maintenance",
			"## Command",
			route?.command,
			"## Evidence refs",
			"- evals:case-1",
			"- evals:case-2",
		].join("\n"),
		report,
	);

	assert.equal(replay.status, "matched");
	assert.deepEqual(replay.missingEvidenceRefs, ["evals:case-2"]);
	assert.match(replay.warnings[0] ?? "", /Missing metadata ref/);
});

test("imported action bundle preview blocks commands that are no longer exportable", () => {
	const report = analyzeControlBundle(
		bundle({
			name: "20260620T120000Z-latest",
			archiveSuffix: "latest",
			createdAt: "2026-06-20T12:00:00Z",
		}),
		Date.parse("2026-06-28T12:00:00Z"),
	);
	const replay = previewImportedActionBundle(
		[
			"# Decision Flight Deck action bundle: Refresh all-source archive",
			"## Command",
			"uv run afr-local collect all --limit 50",
			"## Evidence refs",
			"none",
		].join("\n"),
		report,
	);

	assert.equal(replay.status, "blocked");
	assert.equal(replay.matchedActionTitle, "Refresh 0 sources");
	assert.match(replay.warnings.at(-1) ?? "", /approv/i);
	assert.match(replay.operatorHint, /Do not run this/);
});

test("decision note export summarizes findings actions replay and metadata refs", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
				{
					record_id: "evals:raw",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:03:00Z",
					evidence_ref: "{\"raw\":\"value\"}",
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const route = report.actions.find(
		(action) =>
			action.command === "uv run afr-local latest timeline --source evals --limit 20",
	);
	const replay = previewImportedActionBundle(exportActionBundle(route!).text, report);
	const note = exportDecisionNote({
		archiveName: "20260628T120000Z-all",
		report,
		replayPreview: replay,
	});

	assert.equal(note.findingCount, Math.min(report.findings.length, 5));
	assert.equal(note.actionCount, Math.min(report.actions.length, 3));
	assert.ok(note.evidenceRefCount > 0);
	assert.deepEqual(note.scope.evidenceSources, ["evals"]);
	assert.equal(note.scope.excludedEvidenceRefCount, 1);
	assert.ok(note.scope.includedEvidenceRefs.includes("evals:case-1"));
	assert.equal(note.scope.privacyTierCounts.unknown, 2);
	assert.match(note.text, /^# Decision Flight Deck Note/);
	assert.match(note.text, /- archive: 20260628T120000Z-all/);
	assert.match(note.text, /## Decision Pressure Map/);
	assert.match(
		note.text,
		/Route eval maintenance \/ reasons=warning eval failures/,
	);
	assert.match(note.text, /freshness=evals fresh/);
	assert.match(note.text, /## Top Findings/);
	assert.match(note.text, /## Next Actions/);
	assert.match(note.text, /eval_failure \[warning\]/);
	assert.match(note.text, /sources=evals/);
	assert.match(note.text, /outcome=2 failed eval observation\(s\)/);
	assert.match(note.text, /refs=2/);
	assert.match(note.text, /## Replay Preview\n- status: matched/);
	assert.match(note.text, /- scope: current_context/);
	assert.match(note.text, /- drift: none/);
	assert.match(note.text, /- next: Command still matches this context/);
	assert.match(note.text, /## Metadata Evidence Refs/);
	assert.match(note.text, /- evals:case-1/);
	assert.doesNotMatch(note.text, /raw\":\"value/);
});

test("decision note pressure map compresses merged cost validation signals", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "cost-row",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					timestamp: "2026-06-28T12:00:00Z",
					amount_usd: 12.5,
					cost_quality: "estimated",
					evidence_ref: "cost-tracker:session-1",
				},
			],
			validationReport: {
				ok: true,
				warnings: [
					"line 124: cost-tracker-snapshot-20260702T000000Z-session-0016: cost quality is estimated",
					"line 124: cost-tracker-snapshot-20260702T000000Z-session-0016: correlation confidence is heuristic",
				],
			},
		}),
	);

	const note = exportDecisionNote({
		archiveName: "20260628T120000Z-all",
		report,
	});

	assert.match(
		note.text,
		/Review estimated cost signals \/ reasons=estimated cost signal \/ validation warnings/,
	);
	assert.match(note.text, /sources=cost-tracker/);
	assert.match(note.text, /signals=cost=\$12\.50 across 1 cost observation/);
	assert.match(note.text, /validation=correlation_confidence_heuristic 1/);
	assert.match(note.text, /command=uv run afr-local latest costs --limit 5/);
});

test("decision note export includes replay scope and command drift", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
				{
					record_id: "bridge-db:handoff-1",
					record_type: "handoff",
					source_system: "bridge-db",
					timestamp: "2026-06-28T12:03:00Z",
					evidence_ref: "bridge-db:handoff-1",
					attributes: { handoff_status: "pending" },
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const bridgeAction = report.actions.find((action) =>
		action.command.includes("--source bridge-db"),
	);
	const evals = filterControlReportBySourcePreset(report, "evals");
	const exported = exportActionBundle(bridgeAction!).text;
	const staleBundle = exported
		.replace(
			`# Decision Flight Deck action bundle: ${bridgeAction!.title}`,
			"# Decision Flight Deck action bundle: Old bridge route",
		)
		.replace("- safety: read_only", "- safety: unknown");
	const replay = previewImportedActionBundle(staleBundle, evals, report);
	const note = exportDecisionNote({
		archiveName: "20260628T120000Z-all",
		report: evals,
		replayPreview: replay,
	});

	assert.equal(replay.status, "hidden_by_preset");
	assert.match(note.text, /- status: hidden_by_preset/);
	assert.match(note.text, /- scope: hidden_by_preset/);
	assert.match(note.text, /- next: Switch to the all-source view/);
	assert.match(note.text, /- drift: Title changed: Old bridge route ->/);
	assert.match(note.text, /Safety changed: unknown -> read_only/);
	assert.match(note.text, /hidden by the active source preset/);
});

test("decision note export preserves imported ref source prefixes across presets", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
				{
					record_id: "bridge-db:handoff-1",
					record_type: "handoff",
					source_system: "bridge-db",
					timestamp: "2026-06-28T12:03:00Z",
					evidence_ref: "bridge-db:handoff-1",
					attributes: { handoff_status: "pending" },
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const evalAction = report.actions.find((action) =>
		action.command.includes("--source evals"),
	);
	const bridge = filterControlReportBySourcePreset(report, "bridge-db");
	const replay = previewImportedActionBundle(
		exportActionBundle(evalAction!).text,
		bridge,
		report,
	);
	const note = exportDecisionNote({
		archiveName: "20260628T120000Z-all",
		report: bridge,
		replayPreview: replay,
	});

	assert.equal(replay.status, "hidden_by_preset");
	assert.match(note.text, /## bridge-db\n- bridge-db:handoff-1/);
	assert.match(note.text, /## evals\n- evals:case-1/);
	assert.deepEqual(note.scope.evidenceSources, ["bridge-db", "evals"]);
});

test("decision note export works without pasted replay preview", () => {
	const note = exportDecisionNote({
		archiveName: "empty",
		report: analyzeControlBundle(bundle()),
	});

	assert.match(note.text, /## Replay Preview\n- status: no pasted bundle preview/);
	assert.match(note.text, /## Metadata Evidence Refs\n## metadata/);
	assert.match(note.text, /- 2026-06-28T12:00:00Z/);
	assert.deepEqual(note.scope.evidenceSources, ["metadata"]);
	assert.equal(note.scope.excludedEvidenceRefCount, 0);
	assert.deepEqual(note.scope.includedEvidenceRefs, ["2026-06-28T12:00:00Z"]);
});

test("source presets filter findings actions and freshness by decision source", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "bridge-db:handoff-1",
					record_type: "handoff",
					source_system: "bridge-db",
					timestamp: "2026-06-28T12:01:00Z",
					evidence_ref: "bridge-db:handoff-1",
					attributes: { handoff_status: "pending" },
				},
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
				{
					record_id: "cost-tracker:run-1",
					record_type: "cost_observation",
					source_system: "cost-tracker",
					timestamp: "2026-06-28T12:03:00Z",
					amount_usd: 1.23,
					cost_quality: "estimated",
					evidence_ref: "cost-tracker:run-1",
				},
				{
					record_id: "mcp:permission-1",
					record_type: "boundary_event",
					source_system: "mcp",
					summary: "mcp permission boundary",
					timestamp: "2026-06-28T12:04:00Z",
					evidence_ref: "mcp:permission-1",
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);

	const bridge = filterControlReportBySourcePreset(report, "bridge-db");
	const evals = filterControlReportBySourcePreset(report, "evals");
	const cost = filterControlReportBySourcePreset(report, "cost");
	const hooksMcp = filterControlReportBySourcePreset(report, "hooks-mcp");

	assert.equal(filterControlReportBySourcePreset(report, "all"), report);
	assert.deepEqual(bridge.summary.sourceSystems, ["bridge-db"]);
	assert.ok(bridge.findings.every((finding) => finding.sourceSystems.includes("bridge-db")));
	assert.ok(bridge.actions.every((action) => action.sourceSystems.includes("bridge-db")));
	assert.deepEqual(evals.summary.sourceSystems, ["evals"]);
	assert.ok(evals.findings.some((finding) => finding.kind === "eval_failure"));
	assert.deepEqual(cost.summary.sourceSystems, ["cost-tracker"]);
	assert.ok(cost.findings.some((finding) => finding.kind === "cost_attention"));
	assert.deepEqual(hooksMcp.summary.sourceSystems, ["mcp"]);
	assert.ok(hooksMcp.findings.some((finding) => finding.kind === "boundary_event"));
	assert.deepEqual(Object.keys(hooksMcp.summary.sourceFreshness), ["mcp"]);
});

test("empty preset guidance gives read-only inspect command only for empty presets", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "evals:case-1",
					record_type: "eval_observation",
					source_system: "evals",
					status: "failed",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "evals:case-1",
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const evals = filterControlReportBySourcePreset(report, "evals");
	const hooksMcp = filterControlReportBySourcePreset(report, "hooks-mcp");
	const guidance = emptyPresetGuidance("hooks-mcp", hooksMcp);

	assert.equal(emptyPresetGuidance("all", report), null);
	assert.equal(emptyPresetGuidance("evals", evals), null);
	assert.equal(guidance?.title, "hooks/MCP has no active control findings");
	assert.match(guidance?.detail ?? "", /no hooks\/MCP metadata/);
	assert.equal(
		guidance?.command,
		"uv run afr-local latest timeline --source mcp --limit 20",
	);
	assert.doesNotMatch(guidance?.command ?? "", /collect|write|sync/i);
});

test("empty preset guidance distinguishes quiet metadata from absent metadata", () => {
	const report = analyzeControlBundle(
		bundle({
			records: [
				{
					record_id: "mcp:ok-1",
					record_type: "event",
					source_system: "mcp",
					status: "ok",
					timestamp: "2026-06-28T12:02:00Z",
					evidence_ref: "mcp:ok-1",
				},
			],
		}),
		Date.parse("2026-06-28T12:05:00Z"),
	);
	const hooksMcp = filterControlReportBySourcePreset(report, "hooks-mcp");
	const guidance = emptyPresetGuidance("hooks-mcp", hooksMcp);

	assert.deepEqual(hooksMcp.summary.sourceSystems, ["mcp"]);
	assert.equal(guidance?.title, "hooks/MCP has no active control findings");
	assert.match(guidance?.detail ?? "", /has hooks\/MCP metadata/);
	assert.doesNotMatch(guidance?.detail ?? "", /has no hooks\/MCP metadata/);
});

test("malformed records are surfaced as archive integrity risk", () => {
	const report = analyzeControlBundle(bundle({ malformedRecords: 2 }));
	const finding = report.findings.find(
		(item) => item.id === "malformed_records",
	);
	assert.equal(finding?.severity, "warning");
	assert.match(finding?.title ?? "", /2/);
});
