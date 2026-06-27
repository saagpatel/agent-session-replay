import type { Finding } from "../../core/detect/types.ts";
import { ATTR, type Trace } from "../../core/types.ts";
import type { TimelineView } from "../../core/view/timeline.ts";
import { fmtCompact, fmtDuration, fmtInt } from "../format.ts";

function Stat({
	label,
	value,
	sub,
	tone,
}: {
	label: string;
	value: string;
	sub?: string;
	tone?: "alert" | "ok";
}) {
	return (
		<div className={`stat${tone ? ` stat--${tone}` : ""}`}>
			<span className="label">{label}</span>
			<span className="stat__value">{value}</span>
			{sub ? <span className="stat__sub">{sub}</span> : null}
		</div>
	);
}

export function RunHeader({
	trace,
	findings,
	timeline,
}: {
	trace: Trace;
	findings: readonly Finding[];
	timeline: TimelineView;
}) {
	let tools = 0;
	let inTok = 0;
	let outTok = 0;
	let guards = 0;
	const subagents = new Set<string>();
	for (const s of trace.steps) {
		if (s.kind === "tool_call") tools += 1;
		if (s.subagent_id) subagents.add(s.subagent_id);
		if (s.attributes[ATTR.GUARD_TRIPPED]) guards += 1;
		if (s.kind === "llm") {
			const i = s.attributes[ATTR.INPUT_TOKENS];
			const o = s.attributes[ATTR.OUTPUT_TOKENS];
			if (typeof i === "number") inTok += i;
			if (typeof o === "number") outTok += o;
		}
	}
	const criticals = findings.filter((f) => f.severity === "critical").length;
	const outcome = trace.run.outcome?.status ?? "unknown";
	const completed = outcome === "completed";

	return (
		<div className="stats">
			<Stat label="Duration" value={fmtDuration(timeline.durationMs)} />
			<Stat
				label="Steps"
				value={fmtInt(trace.steps.length)}
				sub={`${fmtInt(tools)} tool calls`}
			/>
			<Stat label="Subagents" value={fmtInt(subagents.size)} />
			<Stat
				label="Tokens in / out"
				value={`${fmtCompact(inTok)} / ${fmtCompact(outTok)}`}
			/>
			<Stat
				label="Guard trips"
				value={fmtInt(guards)}
				tone={guards > 0 ? "alert" : undefined}
			/>
			<Stat
				label="Findings"
				value={fmtInt(findings.length)}
				sub={criticals > 0 ? `${criticals} critical` : "ranked by severity"}
				tone={criticals > 0 ? "alert" : undefined}
			/>
			<Stat
				label="Outcome"
				value={completed ? "completed" : outcome}
				tone={completed ? "ok" : "alert"}
			/>
		</div>
	);
}
