import type { PrivacyTier } from "../afr/types.ts";
import type { Severity } from "../detect/types.ts";

export type ControlFindingKind =
	| "stale_source"
	| "missing_all_source_archive"
	| "privacy_violation"
	| "validation_failure"
	| "validation_warning"
	| "reconciliation_warning"
	| "failure_marker"
	| "eval_failure"
	| "cost_attention"
	| "bridge_pending_handoff"
	| "boundary_event"
	| "malformed_records";

export interface ControlFinding {
	id: string;
	kind: ControlFindingKind;
	severity: Severity;
	title: string;
	detail: string;
	sourceSystems: string[];
	privacyTier: PrivacyTier;
	freshness: SourceFreshnessState;
	boundaryEvent?: string;
	costSignal?: string;
	outcomeSignal?: string;
	evidenceRefs: string[];
	nextCommand?: string;
	score: number;
}

export type ControlActionCategory = "repair" | "refresh" | "inspect" | "route";

export interface ControlAction {
	id: string;
	category: ControlActionCategory;
	categories: ControlActionCategory[];
	priority: number;
	title: string;
	command: string;
	sourceSystems: string[];
	findingIds: string[];
	severity: Severity;
	privacyTier: PrivacyTier;
	rationale: string;
	decisionReason: string;
	decisionReasons: string[];
}

export interface ControlSummary {
	recordCount: number;
	sourceSystems: string[];
	recordTypeCounts: Record<string, number>;
	privacyTierCounts: Record<string, number>;
	statusCounts: Record<string, number>;
	costRecordCount: number;
	failureRecordCount: number;
	decisionRecordCount: number;
	validationOk: boolean | null;
	privacyOk: boolean | null;
	reconciliationOk: boolean | null;
	archiveCreatedAt: string | null;
	archiveSuffix: string | null;
	sourceFreshness: Record<
		string,
		{ newestTimestamp: string | null; freshness: SourceFreshnessState }
	>;
}

export interface ControlReport {
	summary: ControlSummary;
	findings: ControlFinding[];
	actions: ControlAction[];
}

export type SourceFreshnessState = "fresh" | "stale" | "historical" | "unknown";
