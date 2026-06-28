import { memo, useRef, useState } from "react";

import type { Severity } from "../../core/detect/types.ts";
import type { StepKind } from "../../core/types.ts";
import type {
	AxisKnot,
	TimelineLane,
	TimelineView,
} from "../../core/view/timeline.ts";
import { fmtClock, fmtDuration, kindColorVar } from "../format.ts";

/** Kept in sync with --label-w in styles.css (the time-axis gutter). */
const LABEL_W = 88;
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const SEV_VAR: Record<Severity, string> = {
	critical: "--sev-critical",
	warning: "--sev-warning",
	info: "--sev-info",
};
/** Decode the bar color channels: each step kind maps to a signal hue. */
const KIND_LEGEND: { label: string; kind: StepKind }[] = [
	{ label: "llm", kind: "llm" },
	{ label: "tool", kind: "tool_call" },
	{ label: "agent", kind: "agent" },
	{ label: "hook", kind: "hook" },
	{ label: "compaction", kind: "compaction" },
];

function shortLane(id: string): string {
	return id.length > 10 ? `${id.slice(0, 9)}…` : id;
}

/** Map a warped fraction back to wall-clock via the (piecewise-linear) axis knots,
 * so the ruler + scrub read true time even where idle spans were compressed. */
function clockMsAt(axis: readonly AxisKnot[], frac: number): number {
	const first = axis[0];
	const last = axis[axis.length - 1];
	if (!first || !last) return 0;
	if (frac <= 0) return first.t;
	if (frac >= 1) return last.t;
	for (let i = 1; i < axis.length; i++) {
		const a = axis[i - 1];
		const b = axis[i];
		if (a && b && frac <= b.at) {
			const span = b.at - a.at;
			return a.t + (span > 0 ? (frac - a.at) / span : 0) * (b.t - a.t);
		}
	}
	return last.t;
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

	const clockAt = (frac: number) => fmtClock(clockMsAt(timeline.axis, frac));

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
				<div className="wf__head-left">
					<span className="label">Waterfall</span>
					<div className="wf__legend">
						{KIND_LEGEND.map(({ label, kind }) => (
							<span className="wf__legend-item" key={kind}>
								<span
									className="wf__legend-sw"
									style={{ ["--bar" as string]: `var(${kindColorVar(kind)})` }}
								/>
								{label}
							</span>
						))}
					</div>
				</div>
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
				<div className="wf__plot">
					<div className="wf__band">
						{timeline.gaps.length > 0 ? (
							<div className="wf__gaps" aria-hidden="true">
								{timeline.gaps.map((g) => (
									<div
										key={`gap-${g.offset}`}
										className="wf__gap"
										style={{
											left: `${g.offset * 100}%`,
											width: `${g.width * 100}%`,
										}}
										title={`${fmtDuration(g.durationMs)} idle (axis compressed)`}
									>
										<span className="wf__gap-label">
											{fmtDuration(g.durationMs)}
										</span>
									</div>
								))}
							</div>
						) : null}
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
						<div className="wf__ruler">
							{TICKS.map((t) => (
								<div
									className="wf__tick"
									key={t}
									style={{ left: `${t * 100}%` }}
								>
									{clockAt(t)}
								</div>
							))}
						</div>
						<Lanes
							lanes={timeline.lanes}
							selectedStepId={selectedStepId}
							onSelect={onSelect}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
