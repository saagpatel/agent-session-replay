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
export type ControlActionSafety =
	| "read_only"
	| "local_write"
	| "external_write"
	| "unknown";
export type ControlActionReadinessState =
	| "runnable_now"
	| "needs_placeholder"
	| "needs_approval";

export interface ControlActionSourceExplanation {
	source: string;
	freshness: SourceFreshnessState;
	freshnessReason: string;
}

export interface ControlActionPreview {
	why: string[];
	boundary: string;
	evidenceRefs: string[];
}

export interface ControlActionReadiness {
	state: ControlActionReadinessState;
	reason: string;
}

export interface ControlAction {
	id: string;
	category: ControlActionCategory;
	categories: ControlActionCategory[];
	priority: number;
	title: string;
	command: string;
	commandSafety: ControlActionSafety;
	commandReadiness: ControlActionReadiness;
	sourceSystems: string[];
	findingIds: string[];
	evidenceRefs: string[];
	severity: Severity;
	privacyTier: PrivacyTier;
	rationale: string;
	decisionReason: string;
	decisionReasons: string[];
	boundaryEvents: string[];
	safetyNote: string;
	sourceExplanations: ControlActionSourceExplanation[];
	preview: ControlActionPreview;
}

export interface ControlCommandExport {
	commands: string[];
	text: string;
	includedCount: number;
	excludedCount: number;
	excludedReasons: Array<{
		reason: ControlActionReadinessState | ControlActionSafety;
		count: number;
	}>;
}

export interface ControlEvidenceRefExport {
	groups: Array<{
		source: string;
		refs: string[];
	}>;
	text: string;
	includedCount: number;
	excludedCount: number;
}

export interface ControlActionBundlePreview {
	commandExportEligible: boolean;
	commandSafety: ControlActionSafety;
	commandReadiness: ControlActionReadiness;
	command: string;
	boundary: string;
	evidenceRefCount: number;
	excludedEvidenceRefCount: number;
	evidenceSources: string[];
}

export interface ControlActionBundleExport {
	preview: ControlActionBundlePreview;
	text: string;
}

export type ControlActionBundleReplayStatus =
	| "empty"
	| "invalid"
	| "matched"
	| "command_missing"
	| "blocked";

export interface ControlActionBundleReplayPreview {
	status: ControlActionBundleReplayStatus;
	command: string | null;
	title: string | null;
	matchedActionId: string | null;
	matchedActionTitle: string | null;
	importedEvidenceRefs: string[];
	missingEvidenceRefs: string[];
	sourceFreshness: ControlActionSourceExplanation[];
	warnings: string[];
}

export interface ControlDecisionNoteExport {
	text: string;
	findingCount: number;
	actionCount: number;
	evidenceRefCount: number;
	scope: {
		includedEvidenceRefs: string[];
		excludedEvidenceRefCount: number;
		evidenceSources: string[];
		privacyTierCounts: Record<string, number>;
	};
}

export type ControlSourcePreset =
	| "all"
	| "bridge-db"
	| "evals"
	| "cost"
	| "hooks-mcp";

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
		{
			newestTimestamp: string | null;
			freshness: SourceFreshnessState;
			reason: string;
		}
	>;
}

export interface ControlReport {
	summary: ControlSummary;
	findings: ControlFinding[];
	actions: ControlAction[];
}

export type SourceFreshnessState = "fresh" | "stale" | "historical" | "unknown";
