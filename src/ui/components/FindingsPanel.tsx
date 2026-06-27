import type { Finding, Severity } from "../../core/detect/types.ts";

const SEV_VAR: Record<Severity, string> = {
	critical: "--sev-critical",
	warning: "--sev-warning",
	info: "--sev-info",
};

export function FindingsPanel({
	findings,
	activeId,
	onSelect,
}: {
	findings: readonly Finding[];
	activeId: string | null;
	onSelect: (f: Finding) => void;
}) {
	return (
		<div className="panel-findings">
			<div className="findings__head">
				<span className="label">Findings</span>
				<span className="label">{findings.length}</span>
			</div>
			{findings.length === 0 ? (
				<div className="findings__empty">
					No findings — this run looks clean.
				</div>
			) : (
				<div className="findings__list">
					{findings.map((f) => (
						<button
							type="button"
							key={f.id}
							className={`finding${activeId === f.id ? " finding--active" : ""}`}
							style={{ ["--fc" as string]: `var(${SEV_VAR[f.severity]})` }}
							onClick={() => onSelect(f)}
						>
							<span className="finding__top">
								<span className="sev-tag">{f.severity}</span>
								<span className="finding__title">{f.title}</span>
							</span>
							<span className="finding__detail">{f.detail}</span>
							<span className="finding__meta">
								{f.step_ids.length} step{f.step_ids.length === 1 ? "" : "s"}{" "}
								cited
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
