import { memo, useRef, useState } from "react";

import type { Severity } from "../../core/detect/types.ts";
import type { TimelineLane, TimelineView } from "../../core/view/timeline.ts";
import { fmtClock, kindColorVar } from "../format.ts";

/** Kept in sync with --label-w in styles.css (the time-axis gutter). */
const LABEL_W = 88;
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const SEV_VAR: Record<Severity, string> = {
	critical: "--sev-critical",
	warning: "--sev-warning",
	info: "--sev-info",
};

function shortLane(id: string): string {
	return id.length > 10 ? `${id.slice(0, 9)}…` : id;
}

/**
 * Memoized so the scrub cursor's per-mousemove re-renders never reconcile the
 * (up to several thousand) bar buttons — bars depend only on lanes + selection,
 * not on the hover position. Re-render on hover drops from O(bars) to O(1).
 */
const Lanes = memo(function Lanes({
	lanes,
	selectedStepId,
	onSelect,
}: {
	lanes: readonly TimelineLane[];
	selectedStepId: string | null;
	onSelect: (stepId: string) => void;
}) {
	return (
		<>
			{lanes.map((lane) => (
				<div className="lane" key={lane.index}>
					<div className="lane__label" title={lane.id ?? "main"}>
						{lane.id ? shortLane(lane.label) : "main"}
					</div>
					<div className="lane__track">
						{lane.bars.map((bar) => {
							const cls = ["bar"];
							if (bar.status === "error") cls.push("bar--err");
							if (bar.severity) cls.push(`bar--sev-${bar.severity}`);
							if (bar.step_id === selectedStepId) cls.push("bar--sel");
							const label = `${bar.label} · ${fmtClock(bar.t_start)}`;
							return (
								<button
									type="button"
									key={bar.step_id}
									className={cls.join(" ")}
									title={label}
									aria-label={label}
									style={{
										left: `${bar.offset * 100}%`,
										width: `${bar.width * 100}%`,
										["--bar" as string]: `var(${kindColorVar(bar.kind)})`,
									}}
									onClick={() => onSelect(bar.step_id)}
								/>
							);
						})}
					</div>
				</div>
			))}
		</>
	);
});

export function Waterfall({
	timeline,
	selectedStepId,
	onSelect,
	focusedFindingId,
}: {
	timeline: TimelineView;
	selectedStepId: string | null;
	onSelect: (stepId: string) => void;
	focusedFindingId: string | null;
}) {
	const bodyRef = useRef<HTMLDivElement>(null);
	const [scrub, setScrub] = useState<number | null>(null);

	const clockAt = (frac: number) =>
		fmtClock(timeline.t0 + frac * timeline.durationMs);

	function onMove(e: { clientX: number }): void {
		const el = bodyRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const trackWidth = rect.width - LABEL_W;
		if (trackWidth <= 0) return;
		const f = (e.clientX - (rect.left + LABEL_W)) / trackWidth;
		setScrub(f < 0 || f > 1 ? null : f);
	}

	return (
		<div className="wf">
			<div className="wf__head">
				<span className="label">Waterfall</span>
				<span className="label">
					{timeline.lanes.length} lanes · {clockAt(0)} → {clockAt(1)}
				</span>
			</div>
			<div
				className="wf__body"
				ref={bodyRef}
				onMouseMove={onMove}
				onMouseLeave={() => setScrub(null)}
			>
				<div className="wf__ruler">
					{TICKS.map((t) => (
						<div className="wf__tick" key={t} style={{ left: `${t * 100}%` }}>
							{clockAt(t)}
						</div>
					))}
				</div>
				<div className="wf__plot">
					<div className="wf__markers">
						{timeline.markers.map((m) => (
							<div
								key={m.finding_id}
								className={`tracer${focusedFindingId === m.finding_id ? " tracer--focus" : ""}`}
								title={m.title}
								style={{
									left: `${m.offset * 100}%`,
									["--tc" as string]: `var(${SEV_VAR[m.severity]})`,
								}}
							/>
						))}
						{scrub !== null ? (
							<div className="wf__scrub" style={{ left: `${scrub * 100}%` }}>
								<div className="wf__scrub-read">{clockAt(scrub)}</div>
							</div>
						) : null}
					</div>
					<Lanes
						lanes={timeline.lanes}
						selectedStepId={selectedStepId}
						onSelect={onSelect}
					/>
				</div>
			</div>
		</div>
	);
}
