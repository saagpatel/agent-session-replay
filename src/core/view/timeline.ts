/**
 * Timeline view-model: a pure Trace -> proportional waterfall the UI renders
 * verbatim. Each step becomes a bar positioned on a shared [0,1] time axis
 * (Grotto-style proportional bars); the main context and each subagent get their
 * own lane; findings overlay as severity-colored markers at their first evidence.
 *
 * Dependency-free and deterministic so it unit-tests headless and renders the
 * same in the browser.
 */

import { type Finding, SEVERITY_RANK, type Severity } from "../detect/types.ts";
import {
	ATTR,
	type Step,
	type StepKind,
	type StepStatus,
	type Trace,
} from "../types.ts";

/** Instantaneous steps still render as a thin sliver instead of vanishing. */
const MIN_WIDTH = 0.004;
/** Idle spans longer than this collapse into a compressed gap, so a marathon
 * session's activity bursts keep real width instead of crushing to slivers. */
const GAP_THRESHOLD_MS = 5 * 60_000;
/** Axis fraction each compressed gap occupies (relative to the active span total). */
const GAP_AXIS_FRACTION = 0.03;

export interface TimelineBar {
	step_id: string;
	kind: StepKind;
	status?: StepStatus;
	label: string;
	/** Fraction of total run duration where the bar starts (0..1). */
	offset: number;
	/** Fraction of total run duration the bar spans (>= MIN_WIDTH, clamped to edge). */
	width: number;
	t_start: number;
	t_end: number;
	/** Highest severity among findings citing this step, if any. */
	severity?: Severity;
}

export interface TimelineLane {
	index: number;
	/** null = main context; otherwise a subagent_id. */
	id: string | null;
	label: string;
	bars: TimelineBar[];
}

export interface FindingMarker {
	finding_id: string;
	severity: Severity;
	title: string;
	offset: number;
}

/** A collapsed idle span, positioned on the (compressed) warped axis. */
export interface TimelineGap {
	/** Warped fraction where the gap break starts (0..1). */
	offset: number;
	/** Warped fraction the gap break spans. */
	width: number;
	/** Real wall-clock duration the gap collapses. */
	durationMs: number;
}

/** A knot in the piecewise-linear warped-fraction → wall-clock map (for the ruler
 * + scrub readout). Monotonic in both `at` and `t`. */
export interface AxisKnot {
	/** Warped fraction (0..1). */
	at: number;
	/** Wall-clock epoch ms at that fraction. */
	t: number;
}

export interface TimelineView {
	t0: number;
	t1: number;
	durationMs: number;
	lanes: TimelineLane[];
	markers: FindingMarker[];
	/** Idle spans collapsed on the axis; empty when nothing exceeded the threshold. */
	gaps: TimelineGap[];
	/** Warped-fraction → wall-clock knots; identity endpoints when uncompressed. */
	axis: AxisKnot[];
}

interface TimeWarp {
	project: (t: number) => number;
	gaps: TimelineGap[];
	axis: AxisKnot[];
}

/** Build a piecewise-linear time → [0,1] map that compresses long idle spans.
 * Active spans map proportionally; each idle gap over the threshold collapses to a
 * small fixed slice. With no such gaps the map is the identity (purely linear). */
function buildWarp(
	t0: number,
	t1: number,
	intervals: readonly (readonly [number, number])[],
): TimeWarp {
	const clip = (n: number) => (n < t0 ? t0 : n > t1 ? t1 : n);
	const merged: Array<[number, number]> = [];
	for (const [a, b] of intervals
		.map(([s, e]) => [clip(s), clip(Math.max(s, e))] as [number, number])
		.sort((x, y) => x[0] - y[0])) {
		const last = merged[merged.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else merged.push([a, b]);
	}

	// Contiguous pieces over [t0, t1], alternating idle gaps and active spans.
	interface Piece {
		start: number;
		end: number;
		gap: boolean;
	}
	const pieces: Piece[] = [];
	let cursor = t0;
	for (const [a, b] of merged) {
		if (a > cursor) pieces.push({ start: cursor, end: a, gap: true });
		const end = Math.max(b, cursor);
		pieces.push({ start: Math.max(a, cursor), end, gap: false });
		cursor = end;
	}
	if (cursor < t1) pieces.push({ start: cursor, end: t1, gap: true });
	if (pieces.length === 0) pieces.push({ start: t0, end: t1, gap: true });

	const activeTotal = pieces.reduce(
		(sum, p) => sum + (p.gap ? 0 : p.end - p.start),
		0,
	);
	const isGap = (p: Piece) =>
		p.gap && activeTotal > 0 && p.end - p.start > GAP_THRESHOLD_MS;
	const gapBudget = activeTotal * GAP_AXIS_FRACTION;
	const virtualOf = (p: Piece) => (isGap(p) ? gapBudget : p.end - p.start);
	const totalVirtual =
		pieces.reduce((sum, p) => sum + virtualOf(p), 0) || Math.max(1, t1 - t0);

	const axis: AxisKnot[] = [];
	const gaps: TimelineGap[] = [];
	let cum = 0;
	for (const p of pieces) {
		axis.push({ at: cum / totalVirtual, t: p.start });
		if (isGap(p))
			gaps.push({
				offset: cum / totalVirtual,
				width: virtualOf(p) / totalVirtual,
				durationMs: p.end - p.start,
			});
		cum += virtualOf(p);
	}
	axis.push({ at: 1, t: t1 });

	const project = (t: number): number => {
		if (t <= t0) return 0;
		if (t >= t1) return 1;
		let acc = 0;
		for (const p of pieces) {
			const v = virtualOf(p);
			if (t <= p.end) {
				const span = p.end - p.start;
				return (acc + (span > 0 ? (t - p.start) / span : 0) * v) / totalVirtual;
			}
			acc += v;
		}
		return 1;
	};

	return { project, gaps, axis };
}

function ms(iso: string | null | undefined): number | undefined {
	if (!iso) return undefined;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? undefined : t;
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function labelOf(step: Step): string {
	const a = step.attributes;
	switch (step.kind) {
		case "tool_call":
			return str(a[ATTR.TOOL_NAME]) ?? "tool";
		case "agent":
			return str(a[ATTR.AGENT_TYPE]) ?? "agent";
		case "llm":
			return str(a[ATTR.MODEL]) ?? "llm";
		case "hook":
			return str(a[ATTR.HOOK_EVENT]) ?? "hook";
		case "mode_change":
			return str(a[ATTR.MODE_TO]) ?? "mode";
		case "compaction":
			return "compaction";
		default:
			return step.kind;
	}
}

/** Build the renderable timeline from a Trace and (optionally) its findings. */
export function buildTimeline(
	trace: Trace,
	findings: readonly Finding[] = [],
): TimelineView {
	// Highest severity cited per step.
	const sevByStep = new Map<string, Severity>();
	for (const f of findings) {
		for (const sid of f.step_ids) {
			const cur = sevByStep.get(sid);
			if (!cur || SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur])
				sevByStep.set(sid, f.severity);
		}
	}

	// Time window: the run's span, falling back to the step extents.
	const starts: number[] = [];
	const ends: number[] = [];
	for (const s of trace.steps) {
		const a = ms(s.started_at);
		if (a !== undefined) starts.push(a);
		const b = ms(s.ended_at) ?? a;
		if (b !== undefined) ends.push(b);
	}
	const t0 =
		ms(trace.run.started_at) ?? (starts.length ? Math.min(...starts) : 0);
	const t1raw =
		ms(trace.run.ended_at) ?? (ends.length ? Math.max(...ends) : t0);
	const t1 = Math.max(t1raw, t0);
	const durationMs = Math.max(1, t1 - t0);
	const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

	// Warp the axis to compress long idle spans (identity when none exceed the
	// threshold). Bars and finding markers then ride the warped axis.
	const intervals: Array<[number, number]> = trace.steps.map((s) => {
		const a = ms(s.started_at) ?? t0;
		return [a, Math.max(ms(s.ended_at) ?? a, a)];
	});
	const warp = buildWarp(t0, t1, intervals);

	// Lane 0 is the main context; each subagent gets a lane in first-seen order.
	const mainLane: TimelineLane = {
		index: 0,
		id: null,
		label: "main",
		bars: [],
	};
	const lanes: TimelineLane[] = [mainLane];
	const subLanes = new Map<string, TimelineLane>();

	for (const s of trace.steps) {
		const sub = s.subagent_id ?? null;
		let lane: TimelineLane;
		if (sub === null) {
			lane = mainLane;
		} else {
			let existing = subLanes.get(sub);
			if (!existing) {
				existing = { index: lanes.length, id: sub, label: sub, bars: [] };
				subLanes.set(sub, existing);
				lanes.push(existing);
			}
			lane = existing;
		}

		const tStart = ms(s.started_at) ?? t0;
		const tEnd = Math.max(ms(s.ended_at) ?? tStart, tStart);
		const offset = clamp01(warp.project(tStart));
		const rawWidth = warp.project(tEnd) - offset;
		const width = Math.max(
			0,
			Math.min(Math.max(rawWidth, MIN_WIDTH), 1 - offset),
		);
		lane.bars.push({
			step_id: s.step_id,
			kind: s.kind,
			status: s.status,
			label: labelOf(s),
			offset,
			width,
			t_start: tStart,
			t_end: tEnd,
			severity: sevByStep.get(s.step_id),
		});
	}

	for (const lane of lanes)
		lane.bars.sort((a, b) => a.offset - b.offset || a.t_start - b.t_start);

	// Markers: each finding at its first cited step's offset (0 if none on-chart).
	const stepOffset = new Map<string, number>();
	for (const lane of lanes)
		for (const b of lane.bars)
			if (!stepOffset.has(b.step_id)) stepOffset.set(b.step_id, b.offset);
	const markers: FindingMarker[] = findings.map((f) => {
		const firstOnChart = f.step_ids.find((sid) => stepOffset.has(sid));
		return {
			finding_id: f.id,
			severity: f.severity,
			title: f.title,
			offset:
				firstOnChart !== undefined ? (stepOffset.get(firstOnChart) ?? 0) : 0,
		};
	});

	return {
		t0,
		t1,
		durationMs,
		lanes,
		markers,
		gaps: warp.gaps,
		axis: warp.axis,
	};
}
