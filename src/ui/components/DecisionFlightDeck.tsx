import type { CSSProperties } from "react";

import type { AfrBundle } from "../../core/afr/types.ts";
import type {
	ControlAction,
	ControlFinding,
	ControlReport,
} from "../../core/control/types.ts";

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

function ActionRow({ action }: { action: ControlAction }) {
	return (
		<div className="control-action">
			<div className="control-action__meta">
				<span className={`action-kind action-kind--${action.category}`}>
					{actionCategories(action)}
				</span>
				<span>{action.severity}</span>
				<span>{actionReasons(action)}</span>
				<span>{list(action.sourceSystems)}</span>
				<span>
					{action.findingIds.length} finding
					{action.findingIds.length === 1 ? "" : "s"}
				</span>
			</div>
			<div className="control-action__main">
				<div>
					<strong>{action.title}</strong>
					<span>{action.rationale}</span>
				</div>
				<code>{action.command}</code>
			</div>
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
						<div className="control-actions">
							<div className="findings__head">
								<span className="label">Next Safe Commands</span>
								<span className="chip">{report.actions.length} action(s)</span>
							</div>
							<div className="control-actions__list">
								{report.actions.map((action) => (
									<ActionRow key={action.id} action={action} />
								))}
							</div>
						</div>
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
