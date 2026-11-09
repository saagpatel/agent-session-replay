import { BUCKETS, type Bucket, type WaitAnalysis } from "./analysis.ts";

const labels: Record<Bucket, string> = {
	useful_execution: "Useful execution", waiting_tool: "Waiting for tool", waiting_queue: "Waiting in queue",
	waiting_nested: "Waiting for nested work", unattributed: "Unattributed",
};
const ms = (ns: number) => (ns / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 3 });
export function waitAnatomyView(analysis: WaitAnalysis) {
	const wall = analysis.wall_clock_ns;
	const position = (ns: number) => wall ? (ns - analysis.window_ns[0]) / wall : 0;
	return {
		buckets: BUCKETS.map((bucket) => ({ bucket, label: labels[bucket], ns: analysis.totals_ns[bucket], percent: wall ? analysis.totals_ns[bucket] / wall * 100 : 0, formattedMs: `${ms(analysis.totals_ns[bucket])} ms` })),
		segments: analysis.critical_path.map((segment) => ({ ...segment, label: labels[segment.bucket], start: position(segment.start_ns), end: position(segment.end_ns) })),
		spans: analysis.spans.map((span) => ({ ...span, onPath: span.on_critical_path })),
		unattributed: analysis.unattributed.map((gap) => ({ ...gap, formattedMs: `${ms(gap.end_ns - gap.start_ns)} ms` })),
		sentence: `Naive span sum ${ms(analysis.naive_span_sum_ns)} ms vs wall clock ${ms(wall)} ms: overlapping work is not double counted.`,
		limits: analysis.limits,
	};
}
