import type {
	AfrBundle,
	AfrReconciliationSource,
	AfrRecord,
	PrivacyTier,
} from "../afr/types.ts";
import { SEVERITY_RANK, type Severity } from "../detect/types.ts";
import type {
	ControlAction,
	ControlActionCategory,
	ControlActionReadiness,
	ControlActionSafety,
	ControlActionSourceExplanation,
	ControlFinding,
	ControlReport,
	ControlSummary,
	SourceFreshnessState,
} from "./types.ts";
import {
	actionReasonForSource,
	actionTitleForSource,
	sourceFreshnessOverride,
	sourceFreshnessReason,
	staleSourceDecisionReason,
} from "./source-contracts.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_ARCHIVE_MS = DAY_MS;

function privacyTier(value: string | undefined): PrivacyTier {
	return value === "P0" || value === "P1" || value === "P2"
		? value
		: "unknown";
}

function strongestPrivacyTier(records: AfrRecord[]): PrivacyTier {
	const rank: Record<PrivacyTier, number> = {
		unknown: 0,
		P2: 1,
		P1: 2,
		P0: 3,
	};
	let strongest: PrivacyTier = "unknown";
	for (const record of records) {
		const tier = privacyTier(record.privacy_tier);
		if (rank[tier] > rank[strongest]) strongest = tier;
	}
	return strongest;
}

function countBy(values: string[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const value of values) out[value] = (out[value] ?? 0) + 1;
	return out;
}

function uniq(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))]
		.sort();
}

function uniqInOrder(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

function evidence(record: AfrRecord): string {
	return record.evidence_ref ?? record.record_id ?? "-";
}

function sourceSystems(records: AfrRecord[]): string[] {
	return uniq(records.map((record) => record.source_system));
}

function newestTimestamp(records: AfrRecord[]): number | null {
	let newest: number | null = null;
	for (const record of records) {
		if (!record.timestamp) continue;
		const ms = Date.parse(record.timestamp);
		if (!Number.isFinite(ms)) continue;
		newest = newest === null ? ms : Math.max(newest, ms);
	}
	return newest;
}

function freshnessForTimestamp(
	timestampMs: number | null,
	nowMs: number,
): SourceFreshnessState {
	if (timestampMs === null || !Number.isFinite(timestampMs)) return "unknown";
	return nowMs - timestampMs > STALE_ARCHIVE_MS ? "stale" : "fresh";
}

function reportFreshness(bundle: AfrBundle, nowMs: number): SourceFreshnessState {
	const createdAtMs = bundle.createdAt ? Date.parse(bundle.createdAt) : NaN;
	const newestRecordMs = newestTimestamp(bundle.records);
	const observedMs = Number.isFinite(createdAtMs)
		? createdAtMs
		: newestRecordMs;
	return freshnessForTimestamp(observedMs, nowMs);
}

function add(
	findings: ControlFinding[],
	finding: Omit<ControlFinding, "id"> & { id: string },
): void {
	findings.push({
		...finding,
		evidenceRefs: uniqInOrder(finding.evidenceRefs),
	});
}

function sourceFreshness(
	bundle: AfrBundle,
	nowMs: number,
): ControlSummary["sourceFreshness"] {
	const out: ControlSummary["sourceFreshness"] = {};
	for (const source of sourceSystems(bundle.records)) {
		const sourceRecords = bundle.records.filter(
			(record) => record.source_system === source,
		);
		const newestMs = newestTimestamp(sourceRecords);
		const reconciliationRow = reconciliationRowForSource(bundle, source);
		const freshness =
			sourceFreshnessOverride(source, reconciliationRow) ??
			freshnessForTimestamp(newestMs, nowMs);
		out[source] = {
			newestTimestamp:
				newestMs === null || !Number.isFinite(newestMs)
					? null
					: new Date(newestMs).toISOString(),
			freshness,
			reason:
				sourceFreshnessReason(source, reconciliationRow) ??
				(newestMs === null || !Number.isFinite(newestMs)
					? "no timestamped source records"
					: "derived from newest source record timestamp"),
		};
	}
	return out;
}

function numberTotal(records: AfrRecord[], field: "amount_usd"): number {
	return records.reduce((total, record) => {
		const value = record[field];
		return typeof value === "number" && Number.isFinite(value)
			? total + value
			: total;
	}, 0);
}

function money(value: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	}).format(value);
}

function attributeString(record: AfrRecord, key: string): string | null {
	const value = record.attributes?.[key];
	return typeof value === "string" ? value : null;
}

function attributeNumber(record: AfrRecord, key: string): number {
	const value = record.attributes?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timeRange(records: AfrRecord[]): { oldest: string | null; newest: string | null } {
	const timestamps = records
		.map((record) => record.timestamp)
		.filter((timestamp): timestamp is string => Boolean(timestamp))
		.sort();
	return {
		oldest: timestamps[0] ?? null,
		newest: timestamps.at(-1) ?? null,
	};
}

function reconciliationRows(
	sources: NonNullable<AfrBundle["reconciliationReport"]>["sources"],
): Array<[string, AfrReconciliationSource]> {
	if (!sources) return [];
	if (Array.isArray(sources)) {
		return sources.map((row, index) => [
			typeof row.source === "string" && row.source ? row.source : `source-${index + 1}`,
			row,
		]);
	}
	return Object.entries(sources);
}

function reconciliationRowForSource(
	bundle: AfrBundle,
	source: string,
): AfrReconciliationSource | null {
	return (
		reconciliationRows(bundle.reconciliationReport?.sources).find(
			([rowSource]) => rowSource === source,
		)?.[1] ?? null
	);
}

function summary(bundle: AfrBundle, nowMs: number): ControlSummary {
	const recordTypes = bundle.records.map((record) => record.record_type ?? "unknown");
	const privacyTiers = bundle.records.map(
		(record) => record.privacy_tier ?? "unknown",
	);
	const statuses = bundle.records.map((record) => record.status ?? "unknown");
	return {
		recordCount: bundle.records.length,
		sourceSystems: sourceSystems(bundle.records),
		recordTypeCounts: countBy(recordTypes),
		privacyTierCounts: countBy(privacyTiers),
		statusCounts: countBy(statuses),
		costRecordCount: bundle.records.filter(
			(record) => record.record_type === "cost_observation",
		).length,
		failureRecordCount: bundle.records.filter(
			(record) => record.record_type === "failure_marker",
		).length,
		decisionRecordCount: bundle.records.filter(
			(record) => record.record_type === "decision",
		).length,
		validationOk: bundle.validationReport?.ok ?? null,
		privacyOk: bundle.privacyReport?.ok ?? null,
		reconciliationOk: bundle.reconciliationReport?.ok ?? null,
		archiveCreatedAt: bundle.createdAt,
		archiveSuffix: bundle.archiveSuffix,
		sourceFreshness: sourceFreshness(bundle, nowMs),
	};
}

function tierForCount(count: number, warnAt: number, criticalAt: number): Severity {
	if (count >= criticalAt) return "critical";
	if (count >= warnAt) return "warning";
	return "info";
}

function actionCategory(finding: ControlFinding): ControlActionCategory {
	if (
		finding.kind === "privacy_violation" ||
		finding.kind === "validation_failure"
	) {
		return "repair";
	}
	if (finding.id.startsWith("stale_source:")) {
		return "inspect";
	}
	if (
		finding.kind === "stale_source" ||
		finding.kind === "missing_all_source_archive"
	) {
		return "refresh";
	}
	if (
		finding.kind === "cost_attention" ||
		finding.kind === "eval_failure" ||
		finding.kind === "failure_marker"
	) {
		return "route";
	}
	return "inspect";
}

function mergeSeverity(a: Severity, b: Severity): Severity {
	return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

function actionTitle(category: ControlActionCategory, sources: string[]): string {
	const source =
		sources.length === 1 ? (sources[0] ?? "source") : `${sources.length} sources`;
	switch (category) {
		case "repair":
			return `Repair ${source}`;
		case "refresh":
			return `Refresh ${source}`;
		case "route":
			return actionTitleForSource(source, category) ?? `Route ${source}`;
		case "inspect":
			return actionTitleForSource(source, category) ?? `Inspect ${source}`;
	}
}

function actionReason(finding: ControlFinding): string {
	if (finding.kind === "eval_failure") return `${finding.severity} eval failures`;
	if (finding.kind === "cost_attention") {
		return finding.severity === "warning" ? "estimated cost signal" : "cost signal";
	}
	if (
		finding.kind === "bridge_pending_handoff" ||
		finding.kind === "boundary_event"
	) {
		const sourceReason = actionReasonForSource(finding.sourceSystems[0] ?? "");
		if (sourceReason) return sourceReason;
	}
	if (finding.id.startsWith("stale_source:")) {
		return staleSourceDecisionReason(finding.sourceSystems[0] ?? "source");
	}
	if (finding.kind === "stale_source") return "stale archive";
	if (finding.kind === "missing_all_source_archive") return "not all-source";
	if (finding.kind === "privacy_violation") return "privacy failed";
	if (finding.kind === "validation_failure") return "validation failed";
	if (finding.kind === "validation_warning") return "validation warnings";
	if (finding.kind === "bridge_pending_handoff") return "pending handoffs";
	if (finding.kind === "reconciliation_warning") return "reconciliation warning";
	if (finding.kind === "failure_marker") return "failure markers";
	if (finding.kind === "boundary_event") return "boundary event";
	if (finding.kind === "malformed_records") return "malformed records";
	return finding.title;
}

function safetyNoteForCommand(command: string): string {
	if (command.startsWith("uv run afr-local collect ")) {
		return "Creates a fresh local AFR metadata archive; no upload, daemon, or external mutation implied by the command text.";
	}
	if (
		command.startsWith("uv run afr-local latest ") ||
		command.startsWith("afr-local latest ")
	) {
		return "Reads the latest local AFR metadata archive only; no raw transcript export or external write.";
	}
	if (command.startsWith("uv run afr validate ")) {
		return "Validates a local AFR archive contract without uploading archive contents.";
	}
	if (command.startsWith("bridge-db:get_")) {
		return "Uses a bridge-db read tool for inspection; do not pair with repair calls unless separately approved.";
	}
	return "Inspect before running; command is suggested from metadata evidence only.";
}

function commandSafety(command: string): ControlActionSafety {
	if (command.startsWith("uv run afr-local collect ")) return "local_write";
	if (
		command.startsWith("uv run afr-local latest ") ||
		command.startsWith("afr-local latest ") ||
		command.startsWith("uv run afr validate ")
	) {
		return "read_only";
	}
	if (command.startsWith("bridge-db:get_")) return "read_only";
	if (command.startsWith("bridge-db:")) return "external_write";
	return "unknown";
}

function commandBoundary(
	commandSafetyValue: ControlActionSafety,
	safetyNote: string,
): string {
	switch (commandSafetyValue) {
		case "read_only":
			return `Read-only inspection. ${safetyNote}`;
		case "local_write":
			return `Local write. ${safetyNote}`;
		case "external_write":
			return `External write risk. ${safetyNote}`;
		case "unknown":
			return `Unknown command boundary. ${safetyNote}`;
	}
}

function commandReadiness(
	command: string,
	commandSafetyValue: ControlActionSafety,
): ControlActionReadiness {
	if (/<[^>]+>/.test(command)) {
		return {
			state: "needs_placeholder",
			reason: "Fill the placeholder value before running this command.",
		};
	}
	if (commandSafetyValue === "local_write") {
		return {
			state: "needs_approval",
			reason:
				"Creates local artifacts; run only after explicitly approving local collection.",
		};
	}
	if (commandSafetyValue === "external_write") {
		return {
			state: "needs_approval",
			reason:
				"May mutate an external or shared system; confirm the exact boundary first.",
		};
	}
	if (commandSafetyValue === "unknown") {
		return {
			state: "needs_approval",
			reason:
				"Command boundary is unknown; inspect and approve before running.",
		};
	}
	return {
		state: "runnable_now",
		reason: "Runnable as a read-only local inspection command.",
	};
}

function sourceExplanation(
	source: string,
	sourceFreshness: ControlSummary["sourceFreshness"],
): ControlActionSourceExplanation {
	const row = sourceFreshness[source];
	return {
		source,
		freshness: row?.freshness ?? "unknown",
		freshnessReason: row?.reason ?? "no source freshness row in this archive",
	};
}

function sourceExplanations(
	sources: string[],
	sourceFreshness: ControlSummary["sourceFreshness"],
): ControlActionSourceExplanation[] {
	return sources.map((source) => sourceExplanation(source, sourceFreshness));
}

function buildActions(
	findings: ControlFinding[],
	sourceFreshness: ControlSummary["sourceFreshness"],
): ControlAction[] {
	const actions = new Map<string, ControlAction>();
	for (const finding of findings) {
		if (!finding.nextCommand) continue;
		const category = actionCategory(finding);
		const key = finding.nextCommand;
		const reason = actionReason(finding);
		const existing = actions.get(key);
		if (existing) {
			const replaceReason =
				SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity] ||
				finding.score > existing.priority;
			existing.findingIds.push(finding.id);
			existing.evidenceRefs = uniqInOrder([
				...existing.evidenceRefs,
				...finding.evidenceRefs,
			]);
			existing.sourceSystems = uniq([
				...existing.sourceSystems,
				...finding.sourceSystems,
			]);
			existing.severity = mergeSeverity(existing.severity, finding.severity);
			existing.privacyTier = strongestPrivacyTier([
				{ privacy_tier: existing.privacyTier },
				{ privacy_tier: finding.privacyTier },
			]);
			existing.priority = Math.max(existing.priority, finding.score);
			existing.categories = uniq([
				...existing.categories,
				category,
			]) as ControlActionCategory[];
			existing.decisionReasons = uniqInOrder([
				...existing.decisionReasons,
				reason,
			]);
			existing.boundaryEvents = uniqInOrder([
				...existing.boundaryEvents,
				finding.boundaryEvent,
			]);
			existing.sourceExplanations = sourceExplanations(
				existing.sourceSystems,
				sourceFreshness,
			);
			existing.preview = {
				why: existing.decisionReasons,
				boundary: commandBoundary(existing.commandSafety, existing.safetyNote),
				evidenceRefs: existing.evidenceRefs,
			};
			if (replaceReason) {
				existing.category = category;
				existing.rationale = finding.title;
				existing.decisionReason = reason;
			}
			existing.title = actionTitle(existing.category, existing.sourceSystems);
			continue;
		}
		const safetyNote = safetyNoteForCommand(finding.nextCommand);
		const safety = commandSafety(finding.nextCommand);
		const readiness = commandReadiness(finding.nextCommand, safety);
		actions.set(key, {
			id: key,
			category,
			categories: [category],
			priority: finding.score,
			title: actionTitle(category, finding.sourceSystems),
			command: finding.nextCommand,
			commandSafety: safety,
			commandReadiness: readiness,
			sourceSystems: finding.sourceSystems,
			findingIds: [finding.id],
			evidenceRefs: finding.evidenceRefs,
			severity: finding.severity,
			privacyTier: finding.privacyTier,
			rationale: finding.title,
			decisionReason: reason,
			decisionReasons: [reason],
			boundaryEvents: uniqInOrder([finding.boundaryEvent]),
			safetyNote,
			sourceExplanations: sourceExplanations(finding.sourceSystems, sourceFreshness),
			preview: {
				why: [reason],
				boundary: commandBoundary(safety, safetyNote),
				evidenceRefs: finding.evidenceRefs,
			},
		});
	}
	return [...actions.values()].sort(
		(a, b) =>
			SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
			b.priority - a.priority ||
			a.category.localeCompare(b.category) ||
			a.command.localeCompare(b.command),
	);
}

export function analyzeControlBundle(
	bundle: AfrBundle,
	nowMs = Date.now(),
): ControlReport {
	const findings: ControlFinding[] = [];
	const sources = sourceSystems(bundle.records);
	const freshness = reportFreshness(bundle, nowMs);

	if (bundle.archiveSuffix !== "all") {
		add(findings, {
			id: "missing_all_source_archive",
			kind: "missing_all_source_archive",
			severity: "warning",
			title: "Archive is not all-source",
			detail:
				"This bundle does not look like an AFR all-source archive, so the flight deck cannot compare Codex, bridge-db, notification-hub, cost, eval, artifact, and personal-ops evidence together.",
			sourceSystems: sources,
			privacyTier: strongestPrivacyTier(bundle.records),
			freshness,
			evidenceRefs: [bundle.name],
			nextCommand: "uv run afr-local collect all --limit 50",
			score: 80,
		});
	}

	if (freshness === "stale") {
		add(findings, {
			id: "stale_source",
			kind: "stale_source",
			severity: "warning",
			title: "Archive is stale",
			detail:
				"The newest archive timestamp is more than 24 hours old. Treat its findings as historical until a fresh metadata-only archive is collected intentionally.",
			sourceSystems: sources,
			privacyTier: strongestPrivacyTier(bundle.records),
			freshness,
			evidenceRefs: [bundle.createdAt ?? bundle.name],
			nextCommand: "uv run afr-local collect all --limit 50",
			score: 70,
		});
	}

	if (freshness !== "stale") {
		for (const [source, sourceState] of Object.entries(
			summary(bundle, nowMs).sourceFreshness,
		)) {
			if (sourceState.freshness !== "stale") continue;
			add(findings, {
				id: `stale_source:${source}`,
				kind: "stale_source",
				severity: "warning",
				title: `Stale source evidence: ${source}`,
				detail:
					"This source's newest AFR record is more than 24 hours old. Treat source-specific routing and outcome conclusions as stale until a fresh metadata-only archive is collected intentionally.",
				sourceSystems: [source],
				privacyTier: strongestPrivacyTier(
					bundle.records.filter((record) => record.source_system === source),
				),
				freshness: "stale",
				evidenceRefs: [sourceState.newestTimestamp ?? source],
				nextCommand: `uv run afr-local latest timeline --source ${source} --limit 20`,
				score: 120,
			});
		}
	}

	if (bundle.malformedRecords > 0) {
		add(findings, {
			id: "malformed_records",
			kind: "malformed_records",
			severity: "warning",
			title: `${bundle.malformedRecords} AFR line(s) could not parse`,
			detail:
				"Malformed metadata lines were skipped. The flight deck may be under-reporting the archive.",
			sourceSystems: sources,
			privacyTier: strongestPrivacyTier(bundle.records),
			freshness,
			evidenceRefs: [bundle.name],
			score: 60 + bundle.malformedRecords,
		});
	}

	if (bundle.privacyReport?.ok === false) {
		const violations = bundle.privacyReport.violations?.length ?? 1;
		add(findings, {
			id: "privacy_violation",
			kind: "privacy_violation",
			severity: "critical",
			title: "Privacy report failed",
			detail: `${violations} privacy violation${violations === 1 ? "" : "s"} found. Do not export or share this bundle until it is repaired.`,
			sourceSystems: sources,
			privacyTier: strongestPrivacyTier(bundle.records),
			freshness,
			evidenceRefs: ["privacy-report.afr.json"],
			nextCommand: "uv run afr-local latest summary",
			score: 300 + violations,
		});
	}

	if (bundle.validationReport?.ok === false) {
		const errors = bundle.validationReport.errors?.length ?? 1;
		add(findings, {
			id: "validation_failure",
			kind: "validation_failure",
			severity: "critical",
			title: "Validation report failed",
			detail: `${errors} validation error${errors === 1 ? "" : "s"} found. The archive contract is not safe to trust as a complete control-plane input.`,
			sourceSystems: sources,
			privacyTier: strongestPrivacyTier(bundle.records),
			freshness,
			evidenceRefs: ["validation-report.afr.json"],
			nextCommand: "uv run afr validate <archive>",
			score: 290 + errors,
		});
	}

	if (bundle.validationReport?.ok !== false) {
		const warnings = bundle.validationReport?.warnings?.length ?? 0;
		if (warnings > 0) {
			add(findings, {
				id: "validation_warning",
				kind: "validation_warning",
				severity: "warning",
				title: `${warnings} validation warning${warnings === 1 ? "" : "s"}`,
				detail:
					"The archive schema passed, but validation warnings reduce confidence in source completeness or field quality.",
				sourceSystems: sources,
				privacyTier: strongestPrivacyTier(bundle.records),
				freshness,
				evidenceRefs: ["validation-report.afr.json"],
				nextCommand: "uv run afr validate <archive>",
				score: 130 + warnings,
			});
		}
	}

	for (const [source, row] of reconciliationRows(
		bundle.reconciliationReport?.sources,
	)) {
		const warnings = row.warnings?.length ?? 0;
		const rowSeverity =
			row.severity === "error" || row.status === "error"
				? "critical"
				: "warning";
		if (
			rowSeverity === "warning" &&
			warnings === 0 &&
			row.status !== "skipped" &&
			row.status !== "warning"
		)
			continue;
		add(findings, {
			id: `reconciliation_warning:${source}`,
			kind: "reconciliation_warning",
			severity: rowSeverity,
			title: `Reconciliation needs attention: ${source}`,
			detail: `Source status is '${row.status ?? "unknown"}'${
				warnings > 0 ? ` with ${warnings} warning code(s)` : ""
			}.`,
			sourceSystems: [source],
			privacyTier: strongestPrivacyTier(bundle.records),
			freshness,
			evidenceRefs: ["reconciliation-report.afr.json"],
			nextCommand:
				row.next_command ?? `uv run afr-local latest reconciliation --source ${source}`,
			score: rowSeverity === "critical" ? 250 + warnings : 140 + warnings,
		});
	}

	const failureRecords = bundle.records.filter(
		(record) => record.record_type === "failure_marker",
	);
	if (failureRecords.length > 0) {
		add(findings, {
			id: "failure_marker",
			kind: "failure_marker",
			severity: tierForCount(failureRecords.length, 1, 5),
			title: `${failureRecords.length} failure marker${failureRecords.length === 1 ? "" : "s"}`,
			detail:
				"AFR recorded explicit failure markers. Review these before trusting the run as complete.",
			sourceSystems: sourceSystems(failureRecords),
			privacyTier: strongestPrivacyTier(failureRecords),
			freshness,
			outcomeSignal: `${failureRecords.length} failure marker(s)`,
			evidenceRefs: failureRecords.slice(0, 5).map(evidence),
			nextCommand: "uv run afr-local latest failures --limit 5",
			score: 200 + failureRecords.length,
		});
	}

	const failedEvalRecords = bundle.records.filter(
		(record) =>
			record.record_type === "eval_observation" &&
			(record.validation_status === "failed" || record.status === "failed"),
	);
	if (failedEvalRecords.length > 0) {
		const failedTests = failedEvalRecords.reduce(
			(total, record) => total + attributeNumber(record, "tests_failed_count"),
			0,
		);
		const passedInsideFailures = failedEvalRecords.reduce(
			(total, record) => total + attributeNumber(record, "tests_passed_count"),
			0,
		);
		const commandResults = failedEvalRecords.reduce(
			(total, record) => total + attributeNumber(record, "command_results_count"),
			0,
		);
		const failedRange = timeRange(failedEvalRecords);
		const failedTestSignal =
			failedTests > 0
				? `${failedTests} failed test assertion${failedTests === 1 ? "" : "s"}`
				: "failed status without exposed assertion count";
		const passedSignal =
			passedInsideFailures > 0
				? `; ${passedInsideFailures} passed assertion${passedInsideFailures === 1 ? "" : "s"} inside failed observations`
				: "";
		const commandSignal =
			commandResults > 0
				? `; ${commandResults} command result${commandResults === 1 ? "" : "s"}`
				: "";
		const rangeSignal =
			failedRange.oldest && failedRange.newest
				? `; failed window ${failedRange.oldest} to ${failedRange.newest}`
				: "";
		add(findings, {
			id: "eval_failure",
			kind: "eval_failure",
			severity: tierForCount(failedEvalRecords.length, 1, 3),
			title: `${failedEvalRecords.length} eval failure${failedEvalRecords.length === 1 ? "" : "s"}`,
			detail:
				"Evaluation records show failed expectations. Case labels, prompts, outputs, paths, and commands may be intentionally redacted by AFR privacy policy, so route from the aggregate outcome signal before trusting similar work to the same agent path.",
			sourceSystems: sourceSystems(failedEvalRecords),
			privacyTier: strongestPrivacyTier(failedEvalRecords),
			freshness,
			outcomeSignal: `${failedEvalRecords.length} failed eval observation(s); ${failedTestSignal}${passedSignal}${commandSignal}${rangeSignal}`,
			evidenceRefs: failedEvalRecords.slice(0, 5).map(evidence),
			nextCommand: "uv run afr-local latest timeline --source evals --limit 20",
			score: 180 + failedEvalRecords.length + failedTests,
		});
	}

	const pendingHandoffRecords = bundle.records.filter(
		(record) =>
			record.source_system === "bridge-db" &&
			attributeString(record, "handoff_status") === "pending",
	);
	if (pendingHandoffRecords.length > 0) {
		add(findings, {
			id: "bridge_pending_handoff",
			kind: "bridge_pending_handoff",
			severity: tierForCount(pendingHandoffRecords.length, 1, 5),
			title: `${pendingHandoffRecords.length} pending bridge-db handoff${pendingHandoffRecords.length === 1 ? "" : "s"}`,
			detail:
				"Bridge-db handoff records indicate pending work that may need pickup, clearing, or provenance review before the operating layer is quiet.",
			sourceSystems: ["bridge-db"],
			privacyTier: strongestPrivacyTier(pendingHandoffRecords),
			freshness,
			boundaryEvent:
				actionReasonForSource("bridge-db") ?? "bridge handoff pressure",
			outcomeSignal: `${pendingHandoffRecords.length} pending handoff record(s)`,
			evidenceRefs: pendingHandoffRecords.slice(0, 5).map(evidence),
			nextCommand: "bridge-db:get_pending_handoffs",
			score: 170 + pendingHandoffRecords.length,
		});
	}

	const costRecords = bundle.records.filter(
		(record) =>
			record.record_type === "cost_observation" ||
			record.cost_quality === "estimated" ||
			record.status === "estimated" ||
			record.validation_status === "estimated",
	);
	if (costRecords.length > 0) {
		const estimated = costRecords.filter(
			(record) =>
				record.cost_quality === "estimated" ||
				record.status === "estimated" ||
				record.validation_status === "estimated",
		).length;
		const total = numberTotal(costRecords, "amount_usd");
		add(findings, {
			id: "cost_attention",
			kind: "cost_attention",
			severity: estimated > 0 ? "warning" : "info",
			title: `${costRecords.length} cost signal${costRecords.length === 1 ? "" : "s"}`,
			detail:
				estimated > 0
					? "Cost observations include estimated values. Treat them as routing evidence, not invoices, and compare them against outcome/failure markers."
					: "Authoritative cost observations are present. Treat them as routing evidence, not invoices, and compare them against outcome/failure markers.",
			sourceSystems: sourceSystems(costRecords),
			privacyTier: strongestPrivacyTier(costRecords),
			freshness,
			costSignal: `${total > 0 ? `${money(total)} across ` : ""}${costRecords.length} cost observation(s)${
				estimated > 0 ? `; ${estimated} estimated` : ""
			}`,
			evidenceRefs: costRecords.slice(0, 5).map(evidence),
			nextCommand: "uv run afr-local latest costs --limit 5",
			score: (estimated > 0 ? 145 : 50) + costRecords.length,
		});
	}

	const boundaryRecords = bundle.records.filter((record) => {
		const marker = `${record.record_type ?? ""} ${record.span_kind ?? ""} ${
			record.event_kind ?? ""
		} ${record.summary ?? ""}`.toLowerCase();
		return (
			marker.includes("hook") ||
			marker.includes("permission") ||
			marker.includes("guard") ||
			marker.includes("handoff") ||
			marker.includes("mcp")
		);
	});
	for (const source of sourceSystems(boundaryRecords)) {
		const sourceBoundaryRecords = boundaryRecords.filter(
			(record) => record.source_system === source,
		);
		add(findings, {
			id: `boundary_event:${source}`,
			kind: "boundary_event",
			severity: "info",
			title: `${sourceBoundaryRecords.length} boundary/control event${sourceBoundaryRecords.length === 1 ? "" : "s"}: ${source}`,
			detail:
				"The archive includes governance-shaped events such as hooks, permissions, MCP, guardrails, or handoffs.",
			sourceSystems: [source],
			privacyTier: strongestPrivacyTier(sourceBoundaryRecords),
			freshness,
			boundaryEvent:
				actionReasonForSource(source) ?? "hook/permission/MCP/handoff signal",
			evidenceRefs: sourceBoundaryRecords.slice(0, 5).map(evidence),
			nextCommand: `uv run afr-local latest timeline --source ${source} --limit 20`,
			score: 40 + sourceBoundaryRecords.length,
		});
	}

	findings.sort(
		(a, b) =>
			SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
			b.score - a.score ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);

	const reportSummary = summary(bundle, nowMs);
	return {
		summary: reportSummary,
		findings,
		actions: buildActions(findings, reportSummary.sourceFreshness),
	};
}
