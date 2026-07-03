import type { AfrBundle } from "../afr/types.ts";
import type { ControlReport, SourceFreshnessState } from "./types.ts";

export interface ControlArchiveCandidate {
	name: string;
	path: string;
	archiveSuffix: string | null;
	createdAt: string | null;
	recordCount: number;
	sourceCount: number;
	findingCount: number;
	actionCount: number;
	score: number;
	rankLabel: "best" | "strong" | "usable" | "weak";
	reasons: string[];
	warnings: string[];
	freshnessCounts: Record<SourceFreshnessState, number>;
	dropPath: string;
}

function freshnessCounts(
	report: ControlReport,
): Record<SourceFreshnessState, number> {
	const counts: Record<SourceFreshnessState, number> = {
		fresh: 0,
		stale: 0,
		historical: 0,
		unknown: 0,
	};
	for (const row of Object.values(report.summary.sourceFreshness)) {
		counts[row.freshness] += 1;
	}
	return counts;
}

function reportHealthScore(report: ControlReport): number {
	let score = 0;
	for (const ok of [
		report.summary.privacyOk,
		report.summary.validationOk,
		report.summary.reconciliationOk,
	]) {
		if (ok === true) score += 15;
		else if (ok === false) score -= 60;
		else score -= 5;
	}
	return score;
}

function rankLabel(score: number): ControlArchiveCandidate["rankLabel"] {
	if (score >= 170) return "best";
	if (score >= 125) return "strong";
	if (score >= 70) return "usable";
	return "weak";
}

function archiveDisplayName(bundle: AfrBundle): string {
	return bundle.name.split("/").filter(Boolean).at(-1) ?? bundle.name;
}

export function buildArchiveCandidate(
	bundle: AfrBundle,
	report: ControlReport,
): ControlArchiveCandidate {
	const counts = freshnessCounts(report);
	const isAllSource = bundle.archiveSuffix === "all";
	const sourceCount = report.summary.sourceSystems.length;
	const reasons: string[] = [];
	const warnings: string[] = [];
	let score = 0;

	if (isAllSource) {
		score += 100;
		reasons.push("all-source archive");
	} else {
		score += 20;
		warnings.push("not all-source");
	}

	score += Math.min(bundle.records.length, 100) / 2;
	score += sourceCount * 5;
	score += Math.min(report.actions.length, 5) * 6;
	score += Math.min(report.findings.length, 8) * 3;
	score += counts.fresh * 10 + counts.historical * 4 - counts.stale * 20 - counts.unknown * 3;
	score += reportHealthScore(report);
	score -= bundle.malformedRecords * 10;

	if (counts.fresh > 0) reasons.push(`${counts.fresh} fresh source(s)`);
	if (counts.historical > 0) reasons.push(`${counts.historical} historical source(s)`);
	if (report.actions.length > 0) reasons.push(`${report.actions.length} action(s)`);
	if (bundle.malformedRecords > 0) warnings.push(`${bundle.malformedRecords} malformed line(s)`);
	if (counts.stale > 0) warnings.push(`${counts.stale} stale source(s)`);
	if (report.summary.privacyOk === false) warnings.push("privacy failed");
	if (report.summary.validationOk === false) warnings.push("validation failed");
	if (report.summary.reconciliationOk === false) warnings.push("reconciliation failed");

	const roundedScore = Math.round(score);
	return {
		name: archiveDisplayName(bundle),
		path: bundle.name,
		archiveSuffix: bundle.archiveSuffix,
		createdAt: bundle.createdAt,
		recordCount: bundle.records.length,
		sourceCount,
		findingCount: report.findings.length,
		actionCount: report.actions.length,
		score: roundedScore,
		rankLabel: rankLabel(roundedScore),
		reasons,
		warnings,
		freshnessCounts: counts,
		dropPath: bundle.name,
	};
}

export function rankArchiveCandidates(
	candidates: ControlArchiveCandidate[],
): ControlArchiveCandidate[] {
	return [...candidates].sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
		const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
		if (bTime !== aTime) return bTime - aTime;
		return a.name.localeCompare(b.name);
	});
}
