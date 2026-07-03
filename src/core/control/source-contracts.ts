import type { AfrReconciliationSource } from "../afr/types.ts";
import type { ControlActionCategory, SourceFreshnessState } from "./types.ts";

export interface SourceContract {
	source: string;
	routeTitle?: string;
	actionTitles?: Partial<Record<ControlActionCategory, string>>;
	actionReason?: string;
	staleDecisionReason?: string;
	freshnessReason?: string;
	freshnessOverride?: (
		row: AfrReconciliationSource | null,
	) => SourceFreshnessState | null;
}

export interface SourceContractFixture {
	source: string;
	reconciliationRow: AfrReconciliationSource;
	expectedFreshness: SourceFreshnessState | null;
	expectedReason: string | null;
}

export interface SourceActionFixture {
	source: string;
	category: ControlActionCategory;
	expectedTitle: string | null;
	expectedReason: string | null;
}

function healthyReconciliation(row: AfrReconciliationSource | null): boolean {
	if (!row || row.status !== "ok" || row.severity === "error") return false;
	return (row.warnings?.length ?? 0) === 0;
}

export const SOURCE_CONTRACTS: SourceContract[] = [
	{
		source: "artifact-store",
		freshnessReason:
			"healthy reconciliation marks sampled artifact history as historical, not stale",
		freshnessOverride: (row) =>
			healthyReconciliation(row) &&
			row?.source_counts?.artifact_records_sampled !== undefined
				? "historical"
				: null,
	},
	{
		source: "cost-tracker",
		routeTitle: "Review cost routing",
		actionReason: "cost routing signal",
		freshnessReason:
			"healthy reconciliation confirms live ccusage billing-period evidence",
		freshnessOverride: (row) =>
			healthyReconciliation(row) && row?.source_counts?.ccusage_live_used === true
				? "fresh"
				: null,
	},
	{
		source: "evals",
		routeTitle: "Route eval maintenance",
		staleDecisionReason: "stale evals source",
	},
	{
		source: "bridge-db",
		actionTitles: {
			inspect: "Review bridge handoffs",
		},
		actionReason: "bridge handoff pressure",
		staleDecisionReason: "stale bridge-db source",
	},
	{
		source: "notification-hub",
		actionTitles: {
			inspect: "Inspect notification routing",
		},
		actionReason: "notification delivery boundary",
		staleDecisionReason: "stale notification-hub source",
	},
	{
		source: "codex-hooks",
		actionTitles: {
			inspect: "Inspect hook boundary",
		},
		actionReason: "hook boundary event",
		staleDecisionReason: "stale hook evidence",
	},
	{
		source: "mcp-config",
		actionTitles: {
			inspect: "Inspect MCP boundary",
		},
		actionReason: "MCP boundary event",
		staleDecisionReason: "stale MCP config evidence",
	},
];

export const SOURCE_CONTRACT_FIXTURES: SourceContractFixture[] = [
	{
		source: "artifact-store",
		reconciliationRow: {
			source: "artifact-store",
			status: "ok",
			warnings: [],
			detected_records: 50,
			sampled_records: 50,
			emitted_records: 52,
			skipped_records: 0,
			source_counts: {
				artifact_records_sampled: 50,
				digest_skipped: 0,
				redacted_classes: [
					"absolute_paths",
					"artifact_contents",
					"directory_names",
					"file_names",
					"relative_paths",
				],
			},
		},
		expectedFreshness: "historical",
		expectedReason:
			"healthy reconciliation marks sampled artifact history as historical, not stale",
	},
	{
		source: "cost-tracker",
		reconciliationRow: {
			source: "cost-tracker",
			status: "ok",
			warnings: [],
			detected_records: 62,
			sampled_records: 62,
			emitted_records: 65,
			skipped_records: 0,
			source_counts: {
				ccusage_error_count: 0,
				ccusage_live_used: true,
				daily_records_sampled: 9,
				monthly_records_sampled: 3,
				session_records_sampled: 50,
				window_days: 14,
			},
		},
		expectedFreshness: "fresh",
		expectedReason:
			"healthy reconciliation confirms live ccusage billing-period evidence",
	},
];

export const SOURCE_ACTION_FIXTURES: SourceActionFixture[] = [
	{
		source: "bridge-db",
		category: "inspect",
		expectedTitle: "Review bridge handoffs",
		expectedReason: "bridge handoff pressure",
	},
	{
		source: "notification-hub",
		category: "inspect",
		expectedTitle: "Inspect notification routing",
		expectedReason: "notification delivery boundary",
	},
	{
		source: "codex-hooks",
		category: "inspect",
		expectedTitle: "Inspect hook boundary",
		expectedReason: "hook boundary event",
	},
	{
		source: "mcp-config",
		category: "inspect",
		expectedTitle: "Inspect MCP boundary",
		expectedReason: "MCP boundary event",
	},
	{
		source: "cost-tracker",
		category: "route",
		expectedTitle: "Review cost routing",
		expectedReason: "cost routing signal",
	},
	{
		source: "evals",
		category: "route",
		expectedTitle: "Route eval maintenance",
		expectedReason: null,
	},
];

function contractForSource(source: string): SourceContract | null {
	return SOURCE_CONTRACTS.find((contract) => contract.source === source) ?? null;
}

export function sourceFreshnessOverride(
	source: string,
	row: AfrReconciliationSource | null,
): SourceFreshnessState | null {
	return contractForSource(source)?.freshnessOverride?.(row) ?? null;
}

export function sourceFreshnessReason(
	source: string,
	row: AfrReconciliationSource | null,
): string | null {
	const contract = contractForSource(source);
	if (!contract?.freshnessReason) return null;
	return contract.freshnessOverride?.(row) ? contract.freshnessReason : null;
}

export function routeTitleForSource(source: string): string | null {
	return contractForSource(source)?.routeTitle ?? null;
}

export function actionTitleForSource(
	source: string,
	category: ControlActionCategory,
): string | null {
	const contract = contractForSource(source);
	return (
		contract?.actionTitles?.[category] ??
		(category === "route" ? (contract?.routeTitle ?? null) : null)
	);
}

export function actionReasonForSource(source: string): string | null {
	return contractForSource(source)?.actionReason ?? null;
}

export function staleSourceDecisionReason(source: string): string {
	return contractForSource(source)?.staleDecisionReason ?? `stale ${source} source`;
}
