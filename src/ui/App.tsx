import { useCallback, useMemo, useState } from "react";

import { detect } from "../core/detect/engine.ts";
import type { Finding } from "../core/detect/types.ts";
import { type Harness, parseTranscript } from "../core/parse.ts";
import type { Step, Trace } from "../core/types.ts";
import { buildTimeline, type TimelineView } from "../core/view/timeline.ts";
import { DropZone } from "./components/DropZone.tsx";
import { FindingsPanel } from "./components/FindingsPanel.tsx";
import { RunHeader } from "./components/RunHeader.tsx";
import { StepInspector } from "./components/StepInspector.tsx";
import { Waterfall } from "./components/Waterfall.tsx";

interface Loaded {
	fileName: string;
	harness: Harness;
	trace: Trace;
	findings: Finding[];
	timeline: TimelineView;
}

export function App() {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
	const [focusedFindingId, setFocusedFindingId] = useState<string | null>(null);

	const load = useCallback((fileName: string, text: string) => {
		try {
			const { harness, trace } = parseTranscript(text);
			if (trace.steps.length === 0) {
				setError("No steps parsed. Is this a Claude Code or Codex transcript?");
				return;
			}
			const findings = detect(trace);
			const timeline = buildTimeline(trace, findings);
			setLoaded({ fileName, harness, trace, findings, timeline });
			setSelectedStepId(null);
			setFocusedFindingId(null);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const selectedStep = useMemo<Step | null>(() => {
		if (!loaded || !selectedStepId) return null;
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
						<span className="chip chip--harness">{loaded.harness}</span>
						<span>{loaded.trace.run.model ?? "—"}</span>
						<span title={loaded.fileName}>
							{loaded.trace.run.run_id.slice(0, 12)}
						</span>
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

			{loaded ? (
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
			) : (
				<DropZone onLoad={load} onError={setError} />
			)}

			{error ? <div className="toast">{error}</div> : null}
		</div>
	);
}
