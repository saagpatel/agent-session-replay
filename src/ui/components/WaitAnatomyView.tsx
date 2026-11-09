import type { WaitAnalysis, Bucket } from "../../core/wait-anatomy/analysis.ts";
import { waitAnatomyView } from "../../core/wait-anatomy/view-model.ts";

const colors: Record<Bucket, string> = {
	useful_execution: "#397c5c", waiting_tool: "#4979a8", waiting_queue: "#9263a3",
	waiting_nested: "#be8138", unattributed: "#777",
};
export function WaitAnatomyView({ analysis }: { analysis: WaitAnalysis }) {
	const view = waitAnatomyView(analysis);
	return <section aria-label="Wait anatomy">
		<h2>Wait anatomy</h2>
		<p>{view.sentence}</p>
		<div aria-label="Wall clock buckets" style={{ display: "flex", height: "1.5rem" }}>
			{view.buckets.filter((row) => row.ns > 0).map((row) => <div key={row.bucket} title={`${row.label}: ${row.formattedMs}`} style={{ width: `${row.percent}%`, background: colors[row.bucket], backgroundImage: row.bucket === "unattributed" ? "repeating-linear-gradient(45deg, transparent, transparent 4px, #fff6 4px, #fff6 8px)" : undefined }} />)}
		</div>
		<ul>{view.buckets.map((row) => <li key={row.bucket}><span style={{ color: colors[row.bucket] }}>●</span> {row.label}: {row.formattedMs} ({row.percent.toFixed(1)}%)</li>)}</ul>
		<h3>Critical path</h3>
		<div aria-label="Critical path lane" style={{ display: "flex", minHeight: "2rem" }}>
			{view.segments.map((segment, i) => <div key={i} title={segment.label} style={{ width: `${(segment.end - segment.start) * 100}%`, background: colors[segment.bucket], overflow: "hidden" }}>{segment.label}</div>)}
		</div>
		<h3>Spans</h3>
		<ul>{view.spans.map((span) => <li key={span.id} style={{ paddingLeft: `${span.depth}em` }}>{span.name} — {span.category}{span.onPath ? " (critical path)" : ""}</li>)}</ul>
		<h3>Unattributed</h3>
		{view.unattributed.length ? <ul>{view.unattributed.map((gap, i) => <li key={i}>{gap.formattedMs}: {gap.reason}</li>)}</ul> : <p>None recorded.</p>}
		<h3>Limits</h3>
		<ul>{view.limits.map((limit, i) => <li key={i}>{limit}</li>)}</ul>
	</section>;
}
