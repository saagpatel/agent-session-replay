import { useState, type CSSProperties } from "react";

import type { AfrBundle } from "../../core/afr/types.ts";
import {
	buildCommandSafetyLedger,
	buildActionBundlePreview,
	compareCommandActions,
	emptyPresetGuidance,
	exportActionBundle,
	exportDecisionNote,
	exportMetadataEvidenceRefs,
	exportRunnableReadOnlyCommands,
	filterControlReportBySourcePreset,
	previewImportedActionBundle,
} from "../../core/control/engine.ts";
import type {
	ControlAction,
	ControlCommandDeltaPreview,
	ControlFinding,
	ControlReport,
	ControlSourcePreset,
} from "../../core/control/types.ts";

const ACTION_SAFETY_LABELS: Record<ControlAction["commandSafety"], string> = {
	read_only: "read-only",
	local_write: "local write",
	external_write: "external write",
	unknown: "unknown",
};

const ACTION_READINESS_LABELS: Record<
	ControlAction["commandReadiness"]["state"],
	string
> = {
	runnable_now: "runnable",
	needs_placeholder: "needs value",
	needs_approval: "needs approval",
};

const EXPORT_EXCLUDED_LABELS: Record<
	ControlAction["commandReadiness"]["state"] | ControlAction["commandSafety"],
	string
> = {
	runnable_now: "runnable",
	needs_placeholder: "needs value",
	needs_approval: "needs approval",
	read_only: "read-only",
	local_write: "local write",
	external_write: "external write",
	unknown: "unknown",
};

const FINDING_COLOR: Record<ControlFinding["severity"], string> = {
	critical: "var(--sev-critical)",
	warning: "var(--sev-warning)",
	info: "var(--sev-info)",
};

const TRACE_SEVERITY_RANK: Record<ControlFinding["severity"], number> = {
	critical: 3,
	warning: 2,
	info: 1,
};

const SOURCE_PRESETS: Array<{ id: ControlSourcePreset; label: string }> = [
	{ id: "all", label: "all" },
	{ id: "bridge-db", label: "bridge-db" },
	{ id: "evals", label: "evals" },
	{ id: "cost", label: "cost" },
	{ id: "hooks-mcp", label: "hooks/MCP" },
];

function status(ok: boolean | null): string {
	if (ok === true) return "ok";
	if (ok === false) return "failed";
	return "missing";
}

function list(values: string[]): string {
	return values.length > 0 ? values.join(", ") : "none";
}

function uniqueList(values: string[]): string {
	return list([...new Set(values)]);
}

function sourceCounts(counts: Record<string, number>): string {
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 5)
		.map(([name, count]) => `${name} ${count}`)
		.join(" / ");
}

function sourceFreshnessRows(
	freshness: ControlReport["summary"]["sourceFreshness"],
) {
	return Object.entries(freshness).sort((a, b) => a[0].localeCompare(b[0]));
}

function actionCategories(action: ControlAction): string {
	return action.categories.length > 0
		? action.categories.join(" + ")
		: action.category;
}

function actionReasons(action: ControlAction): string {
	return action.decisionReasons.length > 0
		? action.decisionReasons.join(" / ")
		: action.decisionReason;
}

function actionBoundaries(action: ControlAction): string {
	return action.boundaryEvents.length > 0
		? action.boundaryEvents.join(" / ")
		: "";
}

function actionTraceSignal(trace: ControlAction["trace"][number]): string {
	return (
		trace.boundaryEvent ??
		trace.costSignal ??
		trace.outcomeSignal ??
		"no extra signal"
	);
}

function sortedActionTrace(action: ControlAction): ControlAction["trace"] {
	return [...action.trace].sort(
		(a, b) =>
			TRACE_SEVERITY_RANK[b.severity] - TRACE_SEVERITY_RANK[a.severity] ||
			b.evidenceRefCount - a.evidenceRefCount ||
			a.kind.localeCompare(b.kind) ||
			a.findingId.localeCompare(b.findingId),
	);
}

function excludedReasonText(
	reasons: ReturnType<typeof exportRunnableReadOnlyCommands>["excludedReasons"],
): string {
	return reasons
		.map((row) => `${row.count} ${EXPORT_EXCLUDED_LABELS[row.reason]}`)
		.join(" / ");
}

function commandDeltaSummary(delta: ControlCommandDeltaPreview): string {
	return [
		`${delta.appeared.length} appeared`,
		`${delta.disappeared.length} hidden`,
		`${delta.changed.length} changed`,
		`${delta.unchangedCount} unchanged`,
	].join(" / ");
}

function CommandDeltaPreview({
	delta,
}: {
	delta: ControlCommandDeltaPreview;
}) {
	const rows = [
		...delta.appeared.map((action) => ({
			key: `appeared:${action.command}`,
			status: "appeared",
			title: action.title,
			command: action.command,
			detail: `${ACTION_SAFETY_LABELS[action.safety]} / ${ACTION_READINESS_LABELS[action.readiness.state]}`,
		})),
		...delta.disappeared.map((action) => ({
			key: `disappeared:${action.command}`,
			status: "hidden",
			title: action.title,
			command: action.command,
			detail: `${ACTION_SAFETY_LABELS[action.safety]} / ${ACTION_READINESS_LABELS[action.readiness.state]}`,
		})),
		...delta.changed.map((action) => ({
			key: `changed:${action.command}`,
			status: "changed",
			title:
				action.beforeTitle === action.afterTitle
					? action.afterTitle
					: `${action.beforeTitle} -> ${action.afterTitle}`,
			command: action.command,
			detail: `${ACTION_SAFETY_LABELS[action.beforeSafety]} -> ${ACTION_SAFETY_LABELS[action.afterSafety]} / ${ACTION_READINESS_LABELS[action.beforeReadiness.state]} -> ${ACTION_READINESS_LABELS[action.afterReadiness.state]}`,
		})),
	];
	return (
		<details className="command-delta">
			<summary>
				<span>Command delta</span>
				<b>{commandDeltaSummary(delta)}</b>
			</summary>
			{rows.length > 0 ? (
				<div className="command-delta__rows">
					{rows.slice(0, 8).map((row) => (
						<div className="command-delta__row" key={row.key}>
							<span className={`command-delta__status command-delta__status--${row.status}`}>
								{row.status}
							</span>
							<strong>{row.title}</strong>
							<code>{row.command}</code>
							<em>{row.detail}</em>
						</div>
					))}
					{rows.length > 8 ? (
						<span className="command-delta__more">
							{rows.length - 8} more command change(s)
						</span>
					) : null}
				</div>
			) : (
				<span className="command-delta__empty">
					No command safety, readiness, or visibility changes.
				</span>
			)}
		</details>
	);
}

function ActionBundleReplayPreview({
	archiveName,
	report,
	fullReport,
}: {
	archiveName: string;
	report: ControlReport;
	fullReport: ControlReport;
}) {
	const [bundleText, setBundleText] = useState("");
	const preview = previewImportedActionBundle(bundleText, report, fullReport);
	const decisionNote = exportDecisionNote({
		archiveName,
		report,
		replayPreview: preview,
	});
	const [noteStatus, setNoteStatus] = useState<
		"idle" | "copied" | "failed"
	>("idle");
	const copyDecisionNote = async () => {
		try {
			await navigator.clipboard.writeText(decisionNote.text);
			setNoteStatus("copied");
		} catch {
			setNoteStatus("failed");
		}
	};
	return (
		<section className="action-replay">
			<div className="findings__head">
				<span className="label">Action Bundle Replay Preview</span>
				<span className={`chip action-replay__status--${preview.status}`}>
					{preview.status.replace("_", " ")}
				</span>
			</div>
			<textarea
				aria-label="Paste action bundle"
				value={bundleText}
				onChange={(event) => setBundleText(event.target.value)}
				placeholder="Paste a copied action bundle to check it against this AFR evidence."
			/>
			<div className="action-replay__grid">
				<span>command</span>
				<b>{preview.command ?? "none"}</b>
				<span>match</span>
				<b>{preview.matchedActionTitle ?? "none"}</b>
				<span>scope</span>
				<b>{preview.commandScope.replaceAll("_", " ")}</b>
				<span>refs</span>
				<b>
					{preview.importedEvidenceRefs.length} imported
					{preview.missingEvidenceRefs.length > 0
						? ` / ${preview.missingEvidenceRefs.length} missing`
						: ""}
				</b>
				<span>freshness</span>
				<b>
					{preview.sourceFreshness.length > 0
						? preview.sourceFreshness
								.map((row) => `${row.source} ${row.freshness}`)
								.join(" / ")
						: "unknown"}
				</b>
				<span>drift</span>
				<b>{preview.commandDrift.length > 0 ? preview.commandDrift.join(" / ") : "none"}</b>
			</div>
			{preview.warnings.length > 0 ? (
				<div className="action-replay__warnings">
					{preview.warnings.slice(0, 4).map((warning) => (
						<span key={warning}>{warning}</span>
					))}
				</div>
			) : (
				<div className="action-replay__ready">Still runnable against this archive.</div>
			)}
			<details className="decision-note-scope">
				<summary>Decision note scope</summary>
				<div className="action-replay__grid">
					<span>privacy</span>
					<b>{sourceCounts(decisionNote.scope.privacyTierCounts) || "unknown"}</b>
					<span>included</span>
					<b>{decisionNote.scope.includedEvidenceRefs.length} metadata refs</b>
					<span>excluded</span>
					<b>{decisionNote.scope.excludedEvidenceRefCount} raw-looking refs</b>
					<span>sources</span>
					<b>{list(decisionNote.scope.evidenceSources)}</b>
					<span>refs</span>
					<b>{list(decisionNote.scope.includedEvidenceRefs.slice(0, 8))}</b>
				</div>
			</details>
			<div className="decision-note-copy">
				<button type="button" onClick={copyDecisionNote}>
					Copy decision note
				</button>
				<span aria-live="polite">
					{noteStatus === "copied"
						? "Copied note"
						: noteStatus === "failed"
							? "Copy failed"
							: `${decisionNote.findingCount} findings / ${decisionNote.actionCount} actions / ${decisionNote.evidenceRefCount} refs`}
				</span>
			</div>
		</section>
	);
}

function EvidenceRefCopy({
	evidenceRefs,
	sourceSystems,
	title,
}: {
	evidenceRefs: string[];
	sourceSystems: string[];
	title: string;
}) {
	const evidenceExport = exportMetadataEvidenceRefs({
		evidenceRefs,
		sourceSystems,
		title,
	});
	const [copyStatus, setCopyStatus] = useState<
		"idle" | "copied" | "failed" | "empty"
	>("idle");
	const copyRefs = async () => {
		if (evidenceExport.includedCount === 0) {
			setCopyStatus("empty");
			return;
		}
		try {
			await navigator.clipboard.writeText(evidenceExport.text);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("failed");
		}
	};
	return (
		<div className="evidence-copy">
			<button
				type="button"
				onClick={copyRefs}
				disabled={evidenceExport.includedCount === 0}
			>
				Copy refs
			</button>
			<span aria-live="polite">
				{copyStatus === "copied"
					? `Copied ${evidenceExport.includedCount}`
					: copyStatus === "failed"
						? "Copy failed"
						: copyStatus === "empty"
							? "No refs"
							: `${evidenceExport.includedCount} refs`}
			</span>
			{evidenceExport.excludedCount > 0 ? (
				<span>{evidenceExport.excludedCount} raw-looking excluded</span>
			) : null}
		</div>
	);
}

function ActionRow({ action }: { action: ControlAction }) {
	const boundaries = actionBoundaries(action);
	const bundlePreview = buildActionBundlePreview(action);
	const actionBundle = exportActionBundle(action);
	const traceRows = sortedActionTrace(action);
	const visibleTraceRows = traceRows.slice(0, 3);
	const hiddenTraceRows = traceRows.slice(3);
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
		"idle",
	);
	const [bundleStatus, setBundleStatus] = useState<
		"idle" | "copied" | "failed" | "blocked"
	>("idle");
	const copyCommand = async () => {
		try {
			await navigator.clipboard.writeText(action.command);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("failed");
		}
	};
	const copyActionBundle = async () => {
		if (!actionBundle.preview.commandExportEligible || !actionBundle.text) {
			setBundleStatus("blocked");
			return;
		}
		try {
			await navigator.clipboard.writeText(actionBundle.text);
			setBundleStatus("copied");
		} catch {
			setBundleStatus("failed");
		}
	};
	return (
		<div className="control-action">
			<div className="control-action__meta">
				<span className={`action-kind action-kind--${action.category}`}>
					{actionCategories(action)}
				</span>
				<span>{action.severity}</span>
				<span>{actionReasons(action)}</span>
				<span>{list(action.sourceSystems)}</span>
				{boundaries ? (
					<span className="control-action__boundary">boundary: {boundaries}</span>
				) : null}
				<span>
					{action.findingIds.length} finding
					{action.findingIds.length === 1 ? "" : "s"}
				</span>
			</div>
			<div className="control-action__main">
				<div>
					<strong>{action.title}</strong>
					<span>{action.rationale}</span>
					<span>{action.safetyNote}</span>
					{action.sourceExplanations.length > 0 ? (
						<div className="control-action__sources">
							{action.sourceExplanations.map((row) => (
								<span key={row.source}>
									<b>{row.source}</b> {row.freshness}: {row.freshnessReason}
								</span>
							))}
						</div>
					) : null}
				</div>
				<div className="control-action__command">
					<code>{action.command}</code>
					<div className="control-action__copy">
						<span
							className={`control-action__safety control-action__safety--${action.commandSafety}`}
						>
							{ACTION_SAFETY_LABELS[action.commandSafety]}
						</span>
						<span
							className={`control-action__readiness control-action__readiness--${action.commandReadiness.state}`}
						>
							{ACTION_READINESS_LABELS[action.commandReadiness.state]}
						</span>
						<button type="button" onClick={copyCommand}>
							Copy command
						</button>
						{copyStatus !== "idle" ? (
							<span aria-live="polite">
								{copyStatus === "copied" ? "Copied" : "Copy failed"}
							</span>
						) : null}
					</div>
					<details className="control-action__preview">
						<summary>Why this command</summary>
						<div className="control-action__preview-grid">
							<span>boundary</span>
							<b>{action.preview.boundary}</b>
							<span>readiness</span>
							<b>{action.commandReadiness.reason}</b>
							<span>why</span>
							<b>{list(action.preview.why)}</b>
							<span>evidence</span>
							<b>{list(action.preview.evidenceRefs)}</b>
							<span>freshness</span>
							<b>
								{action.sourceExplanations.length > 0
									? action.sourceExplanations
											.map((row) => `${row.source} ${row.freshness}`)
											.join(" / ")
									: "none"}
							</b>
						</div>
						<div className="control-action__trace">
							{visibleTraceRows.map((trace) => (
								<div className="control-action__trace-row" key={trace.findingId}>
									<span className={`sev-tag control-action__trace-sev`}>
										{trace.severity}
									</span>
									<strong>{trace.kind}</strong>
									<em>{list(trace.sourceSystems)}</em>
									<b>{actionTraceSignal(trace)}</b>
									<small>{trace.evidenceRefCount} ref(s)</small>
								</div>
							))}
							{hiddenTraceRows.length > 0 ? (
								<details className="control-action__trace-more">
									<summary>
										Show {hiddenTraceRows.length} lower-signal trace row(s)
									</summary>
									{hiddenTraceRows.map((trace) => (
										<div
											className="control-action__trace-row"
											key={trace.findingId}
										>
											<span className={`sev-tag control-action__trace-sev`}>
												{trace.severity}
											</span>
											<strong>{trace.kind}</strong>
											<em>{list(trace.sourceSystems)}</em>
											<b>{actionTraceSignal(trace)}</b>
											<small>{trace.evidenceRefCount} ref(s)</small>
										</div>
									))}
								</details>
							) : null}
						</div>
						<details className="control-action__bundle">
							<summary>Action bundle preview</summary>
							<div className="control-action__preview-grid">
								<span>command</span>
								<b>
									{bundlePreview.commandExportEligible
										? "exportable"
										: "not exportable"}
								</b>
								<span>safety</span>
								<b>{ACTION_SAFETY_LABELS[bundlePreview.commandSafety]}</b>
								<span>readiness</span>
								<b>
									{ACTION_READINESS_LABELS[bundlePreview.commandReadiness.state]}
								</b>
								<span>refs</span>
								<b>
									{bundlePreview.evidenceRefCount} metadata
									{bundlePreview.excludedEvidenceRefCount > 0
										? ` / ${bundlePreview.excludedEvidenceRefCount} excluded`
										: ""}
								</b>
								<span>sources</span>
								<b>{list(bundlePreview.evidenceSources)}</b>
								<span>boundary</span>
								<b>{bundlePreview.boundary}</b>
							</div>
							<div className="control-action__bundle-copy">
								<button
									type="button"
									onClick={copyActionBundle}
									disabled={!bundlePreview.commandExportEligible}
								>
									Copy action bundle
								</button>
								<span aria-live="polite">
									{bundleStatus === "copied"
										? "Copied bundle"
										: bundleStatus === "failed"
											? "Copy failed"
											: bundleStatus === "blocked"
												? "Not exportable"
												: bundlePreview.commandExportEligible
													? "Ready to export"
													: `Blocked: ${bundlePreview.commandReadiness.reason}`}
								</span>
							</div>
						</details>
						<EvidenceRefCopy
							evidenceRefs={action.evidenceRefs}
							sourceSystems={action.sourceSystems}
							title={action.title}
						/>
					</details>
				</div>
			</div>
		</div>
	);
}

function ActionRail({ actions }: { actions: ControlAction[] }) {
	const primaryActions = actions.slice(0, 3);
	const secondaryActions = actions.slice(3);
	const commandExport = exportRunnableReadOnlyCommands(actions);
	const commandLedger = buildCommandSafetyLedger(actions);
	const [exportStatus, setExportStatus] = useState<
		"idle" | "copied" | "failed" | "empty"
	>("idle");
	const copyRunnableCommands = async () => {
		if (commandExport.commands.length === 0) {
			setExportStatus("empty");
			return;
		}
		try {
			await navigator.clipboard.writeText(commandExport.text);
			setExportStatus("copied");
		} catch {
			setExportStatus("failed");
		}
	};
	return (
		<div className="control-actions">
			<div className="findings__head">
				<span className="label">Next Safe Commands</span>
				<div className="control-actions__export">
					<span className="chip">{actions.length} action(s)</span>
					<button
						type="button"
						onClick={copyRunnableCommands}
						disabled={commandExport.commands.length === 0}
					>
						Copy runnable block
					</button>
					<span aria-live="polite">
						{exportStatus === "copied"
							? `Copied ${commandExport.includedCount}`
							: exportStatus === "failed"
								? "Copy failed"
								: exportStatus === "empty"
									? "Nothing runnable"
									: `${commandExport.includedCount} runnable`}
					</span>
					{commandExport.excludedCount > 0 ? (
						<details className="control-actions__excluded">
							<summary>{commandExport.excludedCount} excluded</summary>
							<span>{excludedReasonText(commandExport.excludedReasons)}</span>
						</details>
					) : null}
				</div>
			</div>
			<details className="command-ledger">
				<summary>
					<span>Command safety ledger</span>
					<b>
						{commandLedger.exportEligibleCount}/{commandLedger.totalCount} exportable
					</b>
				</summary>
				<div className="command-ledger__groups">
					{commandLedger.groups.map((group) => (
						<div className="command-ledger__group" key={group.safety}>
							<div className="command-ledger__head">
								<span
									className={`control-action__safety control-action__safety--${group.safety}`}
								>
									{ACTION_SAFETY_LABELS[group.safety]}
								</span>
								<b>{group.actions.length}</b>
							</div>
							{group.actions.length > 0 ? (
								group.actions.map((action) => (
									<div className="command-ledger__row" key={action.id}>
										<strong>{action.title}</strong>
										<code>{action.command}</code>
										<span>
											{ACTION_READINESS_LABELS[action.readiness.state]}
											{action.exportEligible ? " / exportable" : ""}
										</span>
									</div>
								))
							) : (
								<span className="command-ledger__empty">none</span>
							)}
						</div>
					))}
				</div>
			</details>
			<div className="control-actions__list">
				{primaryActions.map((action) => (
					<ActionRow key={action.id} action={action} />
				))}
			</div>
			{secondaryActions.length > 0 ? (
				<details className="control-actions__more">
					<summary>
						<span>Show {secondaryActions.length} lower-priority action(s)</span>
						<b>
							{uniqueList(secondaryActions.flatMap((action) => action.sourceSystems))}
						</b>
					</summary>
					<div className="control-actions__list control-actions__list--secondary">
						{secondaryActions.map((action) => (
							<ActionRow key={action.id} action={action} />
						))}
					</div>
				</details>
			) : null}
		</div>
	);
}

function FindingCard({ finding }: { finding: ControlFinding }) {
	return (
		<article
			className="control-finding"
			style={{ "--fc": FINDING_COLOR[finding.severity] } as CSSProperties}
		>
			<div className="finding__top">
				<span className="sev-tag">{finding.severity}</span>
				<span className="control-finding__score">score {finding.score}</span>
			</div>
			<h2 className="control-finding__title">{finding.title}</h2>
			<p className="control-finding__detail">{finding.detail}</p>
			<div className="control-finding__grid">
				<span>privacy</span>
				<b>{finding.privacyTier}</b>
				<span>freshness</span>
				<b>{finding.freshness}</b>
				<span>sources</span>
				<b>{list(finding.sourceSystems)}</b>
				<span>evidence</span>
				<b>{list(finding.evidenceRefs)}</b>
				{finding.boundaryEvent ? (
					<>
						<span>boundary</span>
						<b>{finding.boundaryEvent}</b>
					</>
				) : null}
				{finding.costSignal ? (
					<>
						<span>cost</span>
						<b>{finding.costSignal}</b>
					</>
				) : null}
				{finding.outcomeSignal ? (
					<>
						<span>outcome</span>
						<b>{finding.outcomeSignal}</b>
					</>
				) : null}
			</div>
			{finding.nextCommand ? (
				<div className="control-finding__command">
					<span>safe next command</span>
					<code>{finding.nextCommand}</code>
				</div>
			) : null}
			<EvidenceRefCopy
				evidenceRefs={finding.evidenceRefs}
				sourceSystems={finding.sourceSystems}
				title={finding.title}
			/>
		</article>
	);
}

export function DecisionFlightDeck({
	bundle,
	report,
}: {
	bundle: AfrBundle;
	report: ControlReport;
}) {
	const { summary } = report;
	const [sourcePreset, setSourcePreset] = useState<ControlSourcePreset>("all");
	const filteredReport = filterControlReportBySourcePreset(report, sourcePreset);
	const filteredSummary = filteredReport.summary;
	const filteredFreshnessRows = sourceFreshnessRows(filteredSummary.sourceFreshness);
	const presetEmptyGuidance = emptyPresetGuidance(sourcePreset, filteredReport);
	const commandDelta = compareCommandActions(report.actions, filteredReport.actions);
	return (
		<main className="control-deck">
			<section className="stats">
				<div className="stat">
					<span className="label">AFR records</span>
					<span className="stat__value">{summary.recordCount}</span>
					<span className="stat__sub">{bundle.name}</span>
				</div>
				<div className="stat">
					<span className="label">Findings</span>
					<span className="stat__value">{report.findings.length}</span>
					<span className="stat__sub">{summary.archiveSuffix ?? "unknown"} archive</span>
				</div>
				<div className="stat">
					<span className="label">Privacy</span>
					<span className="stat__value">{status(summary.privacyOk)}</span>
					<span className="stat__sub">{sourceCounts(summary.privacyTierCounts)}</span>
				</div>
				<div className="stat">
					<span className="label">Validation</span>
					<span className="stat__value">{status(summary.validationOk)}</span>
					<span className="stat__sub">reconcile {status(summary.reconciliationOk)}</span>
				</div>
				<div className="stat">
					<span className="label">Signals</span>
					<span className="stat__value">
						{summary.failureRecordCount}/{summary.costRecordCount}
					</span>
					<span className="stat__sub">failure / cost</span>
				</div>
			</section>
			<section className="control-deck__body">
				<div className="control-deck__summary">
					<div>
						<span className="label">Source preset</span>
						<div className="source-presets" role="group" aria-label="Source filter">
							{SOURCE_PRESETS.map((preset) => (
								<button
									key={preset.id}
									type="button"
									className={sourcePreset === preset.id ? "is-active" : ""}
									onClick={() => setSourcePreset(preset.id)}
								>
									{preset.label}
								</button>
							))}
						</div>
						<p>
							{filteredReport.findings.length} finding(s) /{" "}
							{filteredReport.actions.length} action(s)
						</p>
						<CommandDeltaPreview delta={commandDelta} />
					</div>
					<div>
						<span className="label">Sources</span>
						<p>{list(filteredSummary.sourceSystems)}</p>
					</div>
					<div>
						<span className="label">Source freshness</span>
						<div className="source-freshness">
							{filteredFreshnessRows.length > 0 ? (
								filteredFreshnessRows.map(([source, row]) => (
									<div className="source-freshness__row" key={source}>
										<div className="source-freshness__top">
											<strong>{source}</strong>
											<span
												className={`source-freshness__state source-freshness__state--${row.freshness}`}
											>
												{row.freshness}
											</span>
										</div>
										<span className="source-freshness__reason">
											{row.reason}
										</span>
										<span className="source-freshness__time">
											{row.newestTimestamp ?? "no timestamp"}
										</span>
									</div>
								))
							) : (
								<p>unknown</p>
							)}
						</div>
					</div>
					<div>
						<span className="label">Record types</span>
						<p>{sourceCounts(filteredSummary.recordTypeCounts) || "none"}</p>
					</div>
					<div>
						<span className="label">Created</span>
						<p>{summary.archiveCreatedAt ?? "unknown"}</p>
					</div>
				</div>
				<div className="control-deck__findings">
					{filteredReport.actions.length > 0 ? (
						<>
							<ActionRail actions={filteredReport.actions} />
							<ActionBundleReplayPreview
								archiveName={bundle.name}
								report={filteredReport}
								fullReport={report}
							/>
						</>
					) : null}
					<div className="findings__head">
						<span className="label">Ranked Control Findings</span>
						<span className="chip">{bundle.malformedRecords} malformed</span>
					</div>
					{filteredReport.findings.length > 0 ? (
						<div className="control-deck__list">
							{filteredReport.findings.map((finding) => (
								<FindingCard key={finding.id} finding={finding} />
							))}
						</div>
					) : (
						<div className="findings__empty">
							{presetEmptyGuidance ? (
								<>
									<strong>{presetEmptyGuidance.title}</strong>
									<span>{presetEmptyGuidance.detail}</span>
									<code>{presetEmptyGuidance.command}</code>
								</>
							) : (
								"No control findings in this AFR bundle."
							)}
						</div>
					)}
				</div>
			</section>
		</main>
	);
}
