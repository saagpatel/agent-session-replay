export const BUCKETS = ["useful_execution", "waiting_tool", "waiting_queue", "waiting_nested", "unattributed"] as const;
export type Bucket = typeof BUCKETS[number];
export interface Segment { span_id: string | null; bucket: Bucket; start_ns: number; end_ns: number }
export interface AnalysisSpan { id: string; parent_id: string | null; name: string; category: string; start_ns: number; end_ns: number; depth: number; on_critical_path: boolean; critical_ns: number }
export interface Unattributed { start_ns: number; end_ns: number; reason: string }
export interface WaitAnalysis {
	format: "traceglass-wait-analysis/0.1";
	trace_id: string; origin: string; window_ns: [number, number]; wall_clock_ns: number; naive_span_sum_ns: number;
	critical_path: Segment[]; path_span_ids: string[]; totals_ns: Record<Bucket, number>; attributed_ns: number;
	unattributed: Unattributed[]; declared_gap_overlaps: unknown[]; spans: AnalysisSpan[]; limits: string[];
	declared_gaps?: unknown[]; notes?: string[];
}
export function parseWaitAnalysis(json: unknown): WaitAnalysis {
	const fail = (reason: string): never => { throw new Error(reason); };
	const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail("Expected object");
	const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : fail("Expected array");
	const str = (v: unknown): string => typeof v === "string" ? v : fail("Expected string");
	const integer = (v: unknown): number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail("Expected nonnegative integer");
	const nullableString = (v: unknown) => v === null ? null : str(v);
	const root = obj(json);
	if (root.format !== "traceglass-wait-analysis/0.1") fail("Invalid format");
	str(root.trace_id); str(root.origin);
	const window = arr(root.window_ns);
	if (window.length !== 2) fail("Invalid window");
	const start = integer(window[0]), end = integer(window[1]);
	const wall = integer(root.wall_clock_ns);
	if (end < start || end - start !== wall) fail("Invalid wall clock");
	integer(root.naive_span_sum_ns); integer(root.attributed_ns);
	let cursor = start;
	for (const value of arr(root.critical_path)) {
		const segment = obj(value);
		nullableString(segment.span_id);
		if (!BUCKETS.includes(segment.bucket as Bucket)) fail("Invalid bucket");
		const a = integer(segment.start_ns), b = integer(segment.end_ns);
		if (a !== cursor || b <= a || b > end) fail("Critical path does not tile window");
		cursor = b;
	}
	if (cursor !== end) fail("Critical path does not tile window");
	const totals = obj(root.totals_ns);
	if (Object.keys(totals).length !== BUCKETS.length || BUCKETS.some((key) => !(key in totals))) fail("Invalid buckets");
	if (BUCKETS.reduce((sum, key) => sum + integer(totals[key]), 0) !== wall) fail("Totals do not sum to wall clock");
	arr(root.path_span_ids).forEach(str);
	for (const value of arr(root.spans)) {
		const span = obj(value); str(span.id); nullableString(span.parent_id); str(span.name); str(span.category);
		const a = integer(span.start_ns), b = integer(span.end_ns); if (b < a) fail("Invalid span");
		integer(span.depth); integer(span.critical_ns); if (typeof span.on_critical_path !== "boolean") fail("Invalid path flag");
	}
	for (const value of arr(root.unattributed)) {
		const gap = obj(value); const a = integer(gap.start_ns), b = integer(gap.end_ns); if (b < a) fail("Invalid gap"); str(gap.reason);
	}
	arr(root.declared_gap_overlaps); arr(root.limits).forEach(str);
	if (root.declared_gaps !== undefined) arr(root.declared_gaps);
	if (root.notes !== undefined) arr(root.notes).forEach(str);
	return json as WaitAnalysis;
}
