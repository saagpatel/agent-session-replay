import { parseJsonlWithStats } from "../jsonl.ts";
import type {
	AfrBundle,
	AfrDiagnostic,
	AfrManifest,
	AfrPrivacyReport,
	AfrReconciliationReport,
	AfrReconciliationSource,
	AfrReportName,
	AfrReportStatus,
	AfrValidationReport,
} from "./types.ts";

export interface AfrInput {
	name: string;
	traceText: string;
	privacyReportText?: string;
	validationReportText?: string;
	reconciliationReportText?: string;
	manifestText?: string;
}

type ParsedReport<T> = {
	value: T | null;
	status: AfrReportStatus;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
	return JSON.parse(text) as unknown;
}

function parseReport<T>(
	name: AfrReportName,
	text: string | undefined,
	diagnostics: AfrDiagnostic[],
	validate: (value: unknown, reportName: AfrReportName, diagnostics: AfrDiagnostic[]) => T | null,
): ParsedReport<T> {
	if (text === undefined) return { value: null, status: "absent" };
	let raw: unknown;
	try {
		raw = parseJson(text);
	} catch {
		diagnostics.push({
			report: name,
			status: "invalid",
			message: `${name}: invalid JSON`,
		});
		return { value: null, status: "invalid" };
	}
	const before = diagnostics.length;
	const value = validate(raw, name, diagnostics);
	if (value === null && diagnostics.length === before) {
		diagnostics.push({
			report: name,
			status: "invalid",
			message: `${name}: expected an object`,
		});
	}
	return {
		value,
		status: value === null || diagnostics.length > before ? "invalid" : "valid",
	};
}

function checkOptional(
	value: Record<string, unknown>,
	key: string,
	predicate: (candidate: unknown) => boolean,
	path: string,
	report: AfrReportName,
	diagnostics: AfrDiagnostic[],
): void {
	if (key in value && !predicate(value[key])) {
		diagnostics.push({
			report,
			status: "invalid",
			message: `${path}.${key}: expected a valid value`,
		});
	}
}

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every(isString);

function validatePrivacy(
	value: unknown,
	name: AfrReportName,
	diagnostics: AfrDiagnostic[],
): AfrPrivacyReport | null {
	if (!isObject(value)) return null;
	checkOptional(value, "ok", isBoolean, name, name, diagnostics);
	checkOptional(value, "violations", isArray, name, name, diagnostics);
	checkOptional(value, "checks", isStringArray, name, name, diagnostics);
	checkOptional(value, "schema_version", isString, name, name, diagnostics);
	const report: AfrPrivacyReport = {};
	if (isBoolean(value.ok)) report.ok = value.ok;
	if (isArray(value.violations)) report.violations = value.violations;
	if (isStringArray(value.checks)) report.checks = value.checks;
	if (isString(value.schema_version)) report.schema_version = value.schema_version;
	return report;
}

function validateValidation(
	value: unknown,
	name: AfrReportName,
	diagnostics: AfrDiagnostic[],
): AfrValidationReport | null {
	if (!isObject(value)) return null;
	checkOptional(value, "ok", isBoolean, name, name, diagnostics);
	checkOptional(value, "errors", isArray, name, name, diagnostics);
	checkOptional(value, "warnings", isArray, name, name, diagnostics);
	checkOptional(value, "schema_version", isString, name, name, diagnostics);
	const report: AfrValidationReport = {};
	if (isBoolean(value.ok)) report.ok = value.ok;
	if (isArray(value.errors)) report.errors = value.errors;
	if (isArray(value.warnings)) report.warnings = value.warnings;
	if (isString(value.schema_version)) report.schema_version = value.schema_version;
	return report;
}

function validateSource(
	value: unknown,
	path: string,
	name: AfrReportName,
	diagnostics: AfrDiagnostic[],
): AfrReconciliationSource | null {
	if (!isObject(value)) {
		diagnostics.push({
			report: name,
			status: "invalid",
			message: `${path}: expected an object; row skipped`,
		});
		return null;
	}
	const source: AfrReconciliationSource = {};
	for (const key of ["source", "status", "severity", "action", "next_command"] as const) {
		checkOptional(value, key, isString, path, name, diagnostics);
		if (isString(value[key])) source[key] = value[key];
	}
	checkOptional(value, "warnings", isArray, path, name, diagnostics);
	if (isArray(value.warnings)) source.warnings = value.warnings;
	checkOptional(value, "source_counts", isObject, path, name, diagnostics);
	if (isObject(value.source_counts)) source.source_counts = value.source_counts;
	for (const key of ["detected_records", "sampled_records", "emitted_records", "skipped_records"] as const) {
		checkOptional(value, key, (candidate) => candidate === null || (typeof candidate === "number" && Number.isFinite(candidate)), path, name, diagnostics);
		const candidate = value[key];
		if (candidate === null || (typeof candidate === "number" && Number.isFinite(candidate))) {
			source[key] = candidate;
		}
	}
	return Object.keys(source).length > 0 ? source : null;
}

function validateReconciliation(
	value: unknown,
	name: AfrReportName,
	diagnostics: AfrDiagnostic[],
): AfrReconciliationReport | null {
	if (!isObject(value)) return null;
	const report: AfrReconciliationReport = {};
	checkOptional(value, "ok", (candidate) => candidate === null || isBoolean(candidate), name, name, diagnostics);
	if (value.ok === null || isBoolean(value.ok)) report.ok = value.ok;
	if ("sources" in value) {
		if (Array.isArray(value.sources)) {
			const sources = value.sources
				.map((row, index) => validateSource(row, `${name}.sources[${index}]`, name, diagnostics))
				.filter((row): row is AfrReconciliationSource => row !== null);
			report.sources = sources;
		} else if (isObject(value.sources)) {
			const sources: Record<string, AfrReconciliationSource> = {};
			for (const [sourceName, row] of Object.entries(value.sources)) {
				const parsed = validateSource(row, `${name}.sources.${sourceName}`, name, diagnostics);
				if (parsed) sources[sourceName] = parsed;
			}
			report.sources = sources;
		} else {
			diagnostics.push({ report: name, status: "invalid", message: `${name}.sources: expected an object or array` });
		}
	}
	checkOptional(value, "warning_sources", isStringArray, name, name, diagnostics);
	if (isStringArray(value.warning_sources)) report.warning_sources = value.warning_sources;
	checkOptional(value, "warning_source_count", (candidate) => typeof candidate === "number" && Number.isFinite(candidate), name, name, diagnostics);
	if (typeof value.warning_source_count === "number" && Number.isFinite(value.warning_source_count)) {
		report.warning_source_count = value.warning_source_count;
	}
	return report;
}

function validateManifest(
	value: unknown,
	_name: AfrReportName,
	_diagnostics: AfrDiagnostic[],
): AfrManifest | null {
	return isObject(value) ? value : null;
}

function parseArchiveName(name: string): {
	archiveSuffix: string | null;
	createdAt: string | null;
} {
	const match = /(\d{8})T(\d{6})Z-([A-Za-z0-9_-]+)(?:\/.*)?$/.exec(name);
	if (!match) return { archiveSuffix: null, createdAt: null };
	const [, date, time, archiveSuffix] = match;
	if (!date || !time || !archiveSuffix)
		return { archiveSuffix: archiveSuffix ?? null, createdAt: null };
	const createdAt = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(
		6,
		8,
	)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
	return { archiveSuffix, createdAt };
}

function objectKeys(value: unknown): string[] {
	return isObject(value) ? Object.keys(value) : [];
}

function sourceNames(report: AfrReconciliationReport | null): string[] {
	const sources = report?.sources;
	if (!sources) return [];
	if (Array.isArray(sources)) {
		return sources
			.map((source) => source.source)
			.filter((source): source is string => Boolean(source));
	}
	return Object.keys(sources);
}

function inferArchiveSuffix(
	manifest: AfrManifest | null,
	reconciliationReport: AfrReconciliationReport | null,
): string | null {
	const expectedCounts = manifest?.expected_counts;
	const manifestSources = objectKeys(
		isObject(expectedCounts) ? expectedCounts.sources : null,
	);
	const reconciliationSources = sourceNames(reconciliationReport);
	const allSourceNames = new Set([...manifestSources, ...reconciliationSources]);
	return allSourceNames.size >= 7 ? "all" : null;
}

export function parseAfrBundle(input: AfrInput): AfrBundle {
	const parsed = parseJsonlWithStats(input.traceText);
	const records = parsed.records.filter(
		(record): record is AfrBundle["records"][number] => isObject(record),
	);
	const parsedName = parseArchiveName(input.name);
	const diagnostics: AfrDiagnostic[] = [];
	const privacy = parseReport("privacyReport", input.privacyReportText, diagnostics, validatePrivacy);
	const validation = parseReport("validationReport", input.validationReportText, diagnostics, validateValidation);
	const reconciliation = parseReport("reconciliationReport", input.reconciliationReportText, diagnostics, validateReconciliation);
	const manifestResult = parseReport("manifest", input.manifestText, diagnostics, validateManifest);
	const manifest = manifestResult.value;
	const reconciliationReport = reconciliation.value;
	const archiveSuffix = parsedName.archiveSuffix ?? inferArchiveSuffix(manifest, reconciliationReport);
	return {
		name: input.name,
		records,
		malformedRecords: parsed.malformed,
		archiveSuffix,
		createdAt: parsedName.createdAt,
		privacyReport: privacy.value,
		validationReport: validation.value,
		reconciliationReport,
		manifest,
		reportStatuses: {
			privacyReport: privacy.status,
			validationReport: validation.status,
			reconciliationReport: reconciliation.status,
			manifest: manifestResult.status,
		},
		diagnostics,
	};
}
