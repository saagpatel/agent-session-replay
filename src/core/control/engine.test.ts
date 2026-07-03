import assert from "node:assert/strict";
import { test } from "node:test";

import type { AfrBundle } from "../afr/types.ts";
import {
	analyzeControlBundle,
	exportRunnableReadOnlyCommands,
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

test("stale archives do not fan out per-source stale findings", () => {
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
		"uv run afr-local latest costs --limit 5",
	]);
	assert.match(
		commandExport.text,
		/^# Decision Flight Deck runnable read-only commands\n/,
	);
	assert.equal(commandExport.includedCount, 2);
	assert.equal(commandExport.excludedCount, 2);
	assert.deepEqual(commandExport.excludedReasons, [
		{ reason: "needs_placeholder", count: 1 },
		{ reason: "needs_approval", count: 1 },
	]);
	assert.doesNotMatch(commandExport.text, /<archive>/);
	assert.doesNotMatch(commandExport.text, /collect all/);
});

test("malformed records are surfaced as archive integrity risk", () => {
	const report = analyzeControlBundle(bundle({ malformedRecords: 2 }));
	const finding = report.findings.find(
		(item) => item.id === "malformed_records",
	);
	assert.equal(finding?.severity, "warning");
	assert.match(finding?.title ?? "", /2/);
});
