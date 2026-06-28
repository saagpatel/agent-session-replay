export type PrivacyTier = "P0" | "P1" | "P2" | "unknown";

export interface AfrRecord {
	record_id?: string;
	record_type?: string;
	source_system?: string;
	span_kind?: string;
	event_kind?: string;
	status?: string;
	summary?: string;
	timestamp?: string;
	privacy_tier?: string;
	validation_status?: string;
	confidence?: string;
	evidence_ref?: string;
	amount_usd?: number;
	cost_quality?: string;
	currency?: string;
	cost?: unknown;
	eval?: unknown;
	failure?: unknown;
	attributes?: Record<string, unknown>;
	provenance?: Record<string, unknown>;
}

export interface AfrPrivacyReport {
	ok?: boolean;
	violations?: unknown[];
	checks?: string[];
	schema_version?: string;
}

export interface AfrValidationReport {
	ok?: boolean;
	errors?: unknown[];
	warnings?: unknown[];
	schema_version?: string;
}

export interface AfrReconciliationSource {
	source?: string;
	status?: string;
	severity?: string;
	action?: string;
	next_command?: string;
	warnings?: unknown[];
	detected_records?: number | null;
	sampled_records?: number | null;
	emitted_records?: number | null;
	skipped_records?: number | null;
}

export interface AfrReconciliationReport {
	ok?: boolean | null;
	sources?: Record<string, AfrReconciliationSource> | AfrReconciliationSource[];
	warning_sources?: string[];
	warning_source_count?: number;
}

export interface AfrManifest {
	[key: string]: unknown;
}

export interface AfrBundle {
	name: string;
	records: AfrRecord[];
	malformedRecords: number;
	archiveSuffix: string | null;
	createdAt: string | null;
	privacyReport: AfrPrivacyReport | null;
	validationReport: AfrValidationReport | null;
	reconciliationReport: AfrReconciliationReport | null;
	manifest: AfrManifest | null;
}
