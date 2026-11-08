import { useRef, useState } from "react";

import { type Harness, parseTranscript } from "../../core/parse.ts";
import type { Trace } from "../../core/types.ts";
import {
	combine,
	type DroppedFile,
	droppedFiles,
	filesFromDrop,
} from "./DropZone.tsx";

export interface LoadedRun {
	fileName: string;
	harness: Harness;
	trace: Trace;
}

interface SlotHandlers {
	onRun: (run: LoadedRun) => void;
	onError: (message: string) => void;
	onClearError: () => void;
}

/**
 * Parse the files dropped on one lane. A clean load clears any banner an
 * earlier bad file left behind; a bad one reports why.
 */
export async function takeRunFiles(
	files: DroppedFile[],
	{ onRun, onError, onClearError }: SlotHandlers,
): Promise<void> {
	try {
		const merged = await combine(files);
		if (!merged) {
			onError("No .jsonl transcript found. Drop a session folder or .jsonl files.");
			return;
		}
		const { harness, trace } = parseTranscript(merged.text);
		if (trace.steps.length === 0) {
			onError(`No steps parsed from ${merged.name}. Is it a Claude Code or Codex transcript?`);
			return;
		}
		onRun({ fileName: merged.name, harness, trace });
		onClearError();
	} catch (e) {
		onError(e instanceof Error ? e.message : String(e));
	}
}

function RunSlot({
	title,
	run,
	onRun,
	onError,
	onClearError,
}: {
	title: string;
	run: LoadedRun | null;
	onRun: (run: LoadedRun) => void;
	onError: (message: string) => void;
	onClearError: () => void;
}) {
	const [over, setOver] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const take = (files: DroppedFile[]) =>
		takeRunFiles(files, { onRun, onError, onClearError });

	return (
		<div
			className={`rd-slot${over ? " rd-slot--over" : ""}${run ? " rd-slot--loaded" : ""}`}
			role="button"
			tabIndex={0}
			aria-label={`${title}: ${run ? `loaded ${run.fileName}, choose to replace` : "choose a transcript"}`}
			onClick={() => inputRef.current?.click()}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					inputRef.current?.click();
				}
			}}
			onDragOver={(e) => {
				e.preventDefault();
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				e.preventDefault();
				setOver(false);
				void filesFromDrop(e.dataTransfer)
					.then(take)
					.catch((err: unknown) => onError(String(err)));
			}}
		>
			<span className="label">{title}</span>
			{run ? (
				<>
					<span className="chip chip--harness">{run.harness}</span>
					<strong className="rd-slot__name" title={run.fileName}>
						{run.fileName}
					</strong>
					<span className="rd-slot__meta">
						{run.trace.run.model ?? "model unknown"} · {run.trace.steps.length} steps
					</span>
					<span className="rd-slot__hint">drop or click to replace</span>
				</>
			) : (
				<>
					<strong className="rd-slot__name">Drop a transcript</strong>
					<span className="rd-slot__hint">
						Claude Code session folder / .jsonl, or a Codex rollout
					</span>
				</>
			)}
			<input
				ref={inputRef}
				type="file"
				accept=".jsonl,.json,application/json"
				multiple
				hidden
				onChange={(e) => {
					const files = droppedFiles(Array.from(e.target.files ?? []));
					e.target.value = "";
					void take(files);
				}}
			/>
		</div>
	);
}

export function RunDiffLoader({
	onCompare,
	onBack,
	onError,
	onClearError,
}: {
	onCompare: (left: LoadedRun, right: LoadedRun) => void;
	onBack: () => void;
	onError: (message: string) => void;
	/** A slot loaded cleanly: drop any banner left by an earlier bad file. */
	onClearError: () => void;
}) {
	const [left, setLeft] = useState<LoadedRun | null>(null);
	const [right, setRight] = useState<LoadedRun | null>(null);

	return (
		<main className="drop rd-loader">
			<div className="rd-loader__box">
				<h2 className="drop__title">Run Diff</h2>
				<p className="drop__desc">
					Load two runs of the same task, say one by Claude Code and one by
					Codex. They line up step by step like a code diff, and the fork that
					changed the outcome gets flagged and explained.
				</p>
				<div className="rd-loader__slots">
					<RunSlot
						title="Left run"
						run={left}
						onRun={setLeft}
						onError={onError}
						onClearError={onClearError}
					/>
					<button
						type="button"
						className="rd-loader__swap"
						aria-label="Swap left and right runs"
						title="Swap left and right"
						disabled={!left && !right}
						onClick={() => {
							setLeft(right);
							setRight(left);
						}}
					>
						⇆
					</button>
					<RunSlot
						title="Right run"
						run={right}
						onRun={setRight}
						onError={onError}
						onClearError={onClearError}
					/>
				</div>
				<div className="rd-loader__actions">
					<button type="button" className="linklike" onClick={onBack}>
						back
					</button>
					<button
						type="button"
						className="rd-btn"
						disabled={!left || !right}
						onClick={() => {
							if (left && right) onCompare(left, right);
						}}
					>
						Compare runs
					</button>
				</div>
				<p className="drop__priv">
					Parsed entirely in your browser. <b>Nothing is uploaded.</b>
				</p>
			</div>
		</main>
	);
}
