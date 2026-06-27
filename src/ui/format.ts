/** Display formatters for the instrument readouts. Pure, no locale surprises. */

import type { StepKind } from "../core/types.ts";

/** Compact token/number readout: 14.9M, 161k, 4,210. */
export function fmtCompact(n: number): string {
	if (!Number.isFinite(n)) return "0";
	const abs = Math.abs(n);
	if (abs >= 1_000_000)
		return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
	if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

export function fmtInt(n: number): string {
	return n.toLocaleString("en-US");
}

/** Human run duration: 1h 06m, 2m 14s, 12.2s, 480ms. */
export function fmtDuration(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const s = ms / 1_000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Wall-clock from epoch ms: 11:16:51.216 (UTC, matching transcript timestamps). */
export function fmtClock(ms: number): string {
	if (!Number.isFinite(ms)) return "--:--:--";
	return new Date(ms).toISOString().slice(11, 23);
}

/** CSS custom-property name carrying each step kind's signal color. */
export function kindColorVar(kind: StepKind): string {
	switch (kind) {
		case "llm":
			return "--kind-llm";
		case "tool_call":
			return "--kind-tool";
		case "agent":
			return "--kind-agent";
		case "hook":
			return "--kind-hook";
		case "compaction":
			return "--kind-compaction";
		default:
			return "--kind-mode";
	}
}
