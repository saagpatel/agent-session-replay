import { parseJsonlWithStats } from "../jsonl.ts";
import type {
	AfrBundle,
	AfrManifest,
	AfrPrivacyReport,
	AfrReconciliationReport,
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

function objectOrNull<T extends object>(text: string | undefined): T | null {
	if (!text) return null;
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as T) : null;
	} catch {
		return null;
	}
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
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.keys(value)
		: [];
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
		typeof expectedCounts === "object" && expectedCounts !== null
			? (expectedCounts as Record<string, unknown>).sources
			: null,
	);
	const reconciliationSources = sourceNames(reconciliationReport);
	const allSourceNames = new Set([...manifestSources, ...reconciliationSources]);
	return allSourceNames.size >= 7 ? "all" : null;
}

export function parseAfrBundle(input: AfrInput): AfrBundle {
	const parsed = parseJsonlWithStats(input.traceText);
	const records = parsed.records.filter(
		(record): record is AfrBundle["records"][number] =>
			typeof record === "object" && record !== null,
	);
	const parsedName = parseArchiveName(input.name);
	const privacyReport = objectOrNull<AfrPrivacyReport>(input.privacyReportText);
	const validationReport = objectOrNull<AfrValidationReport>(
		input.validationReportText,
	);
	const reconciliationReport = objectOrNull<AfrReconciliationReport>(
		input.reconciliationReportText,
	);
	const manifest = objectOrNull<AfrManifest>(input.manifestText);
	const archiveSuffix =
		parsedName.archiveSuffix ?? inferArchiveSuffix(manifest, reconciliationReport);
	return {
		name: input.name,
		records,
		malformedRecords: parsed.malformed,
		archiveSuffix,
		createdAt: parsedName.createdAt,
		privacyReport,
		validationReport,
		reconciliationReport,
		manifest,
	};
}
