import { useCallback, useMemo, useState } from "react";

import { parseAfrBundle } from "../core/afr/parse.ts";
import type { AfrBundle } from "../core/afr/types.ts";
import { analyzeControlBundle } from "../core/control/engine.ts";
import type { ControlReport } from "../core/control/types.ts";
import { detect } from "../core/detect/engine.ts";
import type { Finding } from "../core/detect/types.ts";
import { type Harness, parseTranscript } from "../core/parse.ts";
import type { Step, Trace } from "../core/types.ts";
import { buildTimeline, type TimelineView } from "../core/view/timeline.ts";
import { DecisionFlightDeck } from "./components/DecisionFlightDeck.tsx";
import { DropZone, type DropPayload } from "./components/DropZone.tsx";
import { FindingsPanel } from "./components/FindingsPanel.tsx";
import { RunHeader } from "./components/RunHeader.tsx";
import { StepInspector } from "./components/StepInspector.tsx";
import { Waterfall } from "./components/Waterfall.tsx";

interface LoadedSession {
	mode: "session";
	fileName: string;
	harness: Harness;
	trace: Trace;
	findings: Finding[];
	timeline: TimelineView;
}

interface LoadedControl {
	mode: "control";
	fileName: string;
	bundle: AfrBundle;
	report: ControlReport;
}

type Loaded = LoadedSession | LoadedControl;

export function App() {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
	const [focusedFindingId, setFocusedFindingId] = useState<string | null>(null);

	const load = useCallback((payload: DropPayload) => {
		try {
			if (payload.kind === "afr") {
				const bundle = parseAfrBundle(payload.input);
				const report = analyzeControlBundle(bundle);
				setLoaded({
					mode: "control",
					fileName: payload.input.name,
					bundle,
					report,
				});
				setSelectedStepId(null);
				setFocusedFindingId(null);
				setError(null);
				return;
			}
			const { harness, trace } = parseTranscript(payload.text);
			if (trace.steps.length === 0) {
				setError("No steps parsed. Is this a Claude Code or Codex transcript?");
				return;
			}
			const findings = detect(trace);
			const timeline = buildTimeline(trace, findings);
			setLoaded({
				mode: "session",
				fileName: payload.name,
				harness,
				trace,
				findings,
				timeline,
			});
			setSelectedStepId(null);
			setFocusedFindingId(null);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const selectedStep = useMemo<Step | null>(() => {
		if (!loaded || loaded.mode !== "session" || !selectedStepId) return null;
		return loaded.trace.steps.find((s) => s.step_id === selectedStepId) ?? null;
	}, [loaded, selectedStepId]);

	const focusFinding = useCallback((f: Finding) => {
		setFocusedFindingId(f.id);
		setSelectedStepId(f.step_ids[0] ?? null);
	}, []);

	return (
		<div className="app">
			<header className="topbar">
				<div className="topbar__brand">
					<span className="rec" aria-hidden="true" />
					Agent Session Replay
				</div>
				{loaded ? (
					<div className="topbar__meta">
						<span className="chip chip--harness">
							{loaded.mode === "session" ? loaded.harness : "AFR"}
						</span>
						{loaded.mode === "session" ? (
							<span>{loaded.trace.run.model ?? "—"}</span>
						) : (
							<span>{loaded.report.summary.sourceSystems.length} source(s)</span>
						)}
						<span title={loaded.fileName}>
							{loaded.mode === "session"
								? loaded.trace.run.run_id.slice(0, 12)
								: loaded.bundle.name}
						</span>
						{loaded.mode === "session" && loaded.trace.malformed_lines ? (
							<span
								className="chip chip--warn"
								title={`${loaded.trace.malformed_lines} transcript line(s) could not be parsed and were skipped — this view may under-report`}
							>
								⚠ {loaded.trace.malformed_lines} unparsed
							</span>
						) : null}
						<button
							type="button"
							className="linklike"
							onClick={() => {
								setLoaded(null);
								setError(null);
							}}
						>
							load another
						</button>
					</div>
				) : null}
			</header>

			{loaded?.mode === "session" ? (
				<>
					<RunHeader
						trace={loaded.trace}
						findings={loaded.findings}
						timeline={loaded.timeline}
					/>
					<div className="main">
						<div className="waterfall-wrap">
							<Waterfall
								timeline={loaded.timeline}
								selectedStepId={selectedStepId}
								onSelect={setSelectedStepId}
								focusedFindingId={focusedFindingId}
							/>
						</div>
						<FindingsPanel
							findings={loaded.findings}
							activeId={focusedFindingId}
							onSelect={focusFinding}
						/>
					</div>
					{selectedStep ? (
						<StepInspector
							step={selectedStep}
							onClose={() => setSelectedStepId(null)}
						/>
					) : null}
				</>
			) : loaded?.mode === "control" ? (
				<DecisionFlightDeck bundle={loaded.bundle} report={loaded.report} />
			) : (
				<DropZone onLoad={load} onError={setError} />
			)}

			{error ? <div className="toast">{error}</div> : null}
		</div>
	);
}
