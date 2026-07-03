import { useState, type CSSProperties } from "react";

import type { AfrBundle } from "../../core/afr/types.ts";
import { exportRunnableReadOnlyCommands } from "../../core/control/engine.ts";
import type {
	ControlAction,
	ControlFinding,
	ControlReport,
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

const FINDING_COLOR: Record<ControlFinding["severity"], string> = {
	critical: "var(--sev-critical)",
	warning: "var(--sev-warning)",
	info: "var(--sev-info)",
};

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

function ActionRow({ action }: { action: ControlAction }) {
	const boundaries = actionBoundaries(action);
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
		"idle",
	);
	const copyCommand = async () => {
		try {
			await navigator.clipboard.writeText(action.command);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("failed");
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
				</div>
			</div>
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
	const freshnessRows = sourceFreshnessRows(summary.sourceFreshness);
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
						<span className="label">Sources</span>
						<p>{list(summary.sourceSystems)}</p>
					</div>
					<div>
						<span className="label">Source freshness</span>
						<div className="source-freshness">
							{freshnessRows.length > 0 ? (
								freshnessRows.map(([source, row]) => (
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
						<p>{sourceCounts(summary.recordTypeCounts) || "none"}</p>
					</div>
					<div>
						<span className="label">Created</span>
						<p>{summary.archiveCreatedAt ?? "unknown"}</p>
					</div>
				</div>
				<div className="control-deck__findings">
					{report.actions.length > 0 ? (
						<ActionRail actions={report.actions} />
					) : null}
					<div className="findings__head">
						<span className="label">Ranked Control Findings</span>
						<span className="chip">{bundle.malformedRecords} malformed</span>
					</div>
					{report.findings.length > 0 ? (
						<div className="control-deck__list">
							{report.findings.map((finding) => (
								<FindingCard key={finding.id} finding={finding} />
							))}
						</div>
					) : (
						<div className="findings__empty">
							No control findings in this AFR bundle.
						</div>
					)}
				</div>
			</section>
		</main>
	);
}
