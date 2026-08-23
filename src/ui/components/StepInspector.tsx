import { Fragment, useEffect, useRef } from "react";

import type { Step } from "../../core/types.ts";
import { fmtClock, fmtDuration, kindColorVar } from "../format.ts";

function friendlyKey(k: string): string {
	return k
		.replace(/^(gen_ai|harness|agent|tool)\./, "")
		.replace(/_/g, " ")
		.replace(/\./g, " · ");
}

function renderValue(v: unknown): string {
	if (v === null || v === undefined) return "—";
	if (typeof v === "object") {
		const s = JSON.stringify(v);
		return s.length > 600 ? `${s.slice(0, 600)}…` : s;
	}
	const s = String(v);
	return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

export function StepInspector({
	step,
	onClose,
}: {
	step: Step;
	onClose: () => void;
}) {
	const inspectorRef = useRef<HTMLElement>(null);
	const start = Date.parse(step.started_at);
	const end = step.ended_at ? Date.parse(step.ended_at) : start;
	const dur = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
	const entries = Object.entries(step.attributes);

	useEffect(() => {
		inspectorRef.current?.focus();
	}, [step.step_id]);

	return (
		<aside
			className="inspector"
			ref={inspectorRef}
			role="region"
			aria-labelledby="step-inspector-title"
			tabIndex={-1}
		>
			<div className="inspector__head">
				<span
					className="kind-dot"
					style={{ ["--bar" as string]: `var(${kindColorVar(step.kind)})` }}
				/>
				<h2 className="inspector__title" id="step-inspector-title">
					{step.kind} step details
				</h2>
				{step.status ? <span className="chip">{step.status}</span> : null}
				<button
					type="button"
					className="linklike inspector__close"
					onClick={onClose}
				>
					close ✕
				</button>
			</div>
			<div className="kv">
				<span className="kv__k">step id</span>
				<span className="kv__v">{step.step_id}</span>
				<span className="kv__k">started</span>
				<span className="kv__v">{fmtClock(start)}</span>
				<span className="kv__k">duration</span>
				<span className="kv__v">{dur > 0 ? fmtDuration(dur) : "instant"}</span>
				{step.subagent_id ? (
					<>
						<span className="kv__k">subagent</span>
						<span className="kv__v">{step.subagent_id}</span>
					</>
				) : null}
				{entries.map(([k, v]) => {
					const isErr = k.includes("error") || k.includes("guard");
					return (
						<Fragment key={k}>
							<span className="kv__k">{friendlyKey(k)}</span>
							<span className={`kv__v${isErr ? " kv__v--err" : ""}`}>
								{renderValue(v)}
							</span>
						</Fragment>
					);
				})}
			</div>
		</aside>
	);
}
