import type { AfrReconciliationSource } from "../afr/types.ts";
import type { SourceFreshnessState } from "./types.ts";

export interface SourceContract {
	source: string;
	routeTitle?: string;
	staleDecisionReason?: string;
	freshnessReason?: string;
	freshnessOverride?: (
		row: AfrReconciliationSource | null,
	) => SourceFreshnessState | null;
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

export function staleSourceDecisionReason(source: string): string {
	return contractForSource(source)?.staleDecisionReason ?? `stale ${source} source`;
}
