import { useRef, useState } from "react";

import type { AfrInput } from "../../core/afr/parse.ts";

const JSONL = /\.jsonl?$/i;
const AFR_TRACE = "trace.afr.jsonl";
const AFR_PRIVACY = "privacy-report.afr.json";
const AFR_VALIDATION = "validation-report.afr.json";
const AFR_RECONCILIATION = "reconciliation-report.afr.json";
const AFR_MANIFEST = "manifest.afr.json";

export type DropPayload =
	| { kind: "transcript"; name: string; text: string }
	| { kind: "afr"; input: AfrInput };

/** Recursively collect files from a dropped entry (so a session folder picks up
 * its subagents/ sidechains). Entries must be read synchronously from the drop. */
function readEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
	return new Promise((resolve) => {
		if (entry.isFile) {
			(entry as FileSystemFileEntry).file(
				(f) => {
					out.push(f);
					resolve();
				},
				() => resolve(),
			);
		} else if (entry.isDirectory) {
			const reader = (entry as FileSystemDirectoryEntry).createReader();
			const collected: FileSystemEntry[] = [];
			const pump = () =>
				reader.readEntries(
					(batch) => {
						if (batch.length === 0) {
							Promise.all(collected.map((e) => readEntry(e, out))).then(() =>
								resolve(),
							);
						} else {
							collected.push(...batch);
							pump();
						}
					},
					() => resolve(),
				);
			pump();
		} else {
			resolve();
		}
	});
}

async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
	const items = dt.items;
	const roots: FileSystemEntry[] = [];
	if (items?.length && typeof items[0]?.webkitGetAsEntry === "function") {
		for (const it of Array.from(items)) {
			const e = it.webkitGetAsEntry?.();
			if (e) roots.push(e);
		}
	}
	if (roots.length === 0) return Array.from(dt.files);
	const out: File[] = [];
	await Promise.all(roots.map((e) => readEntry(e, out)));
	return out.length > 0 ? out : Array.from(dt.files);
}

/** Merge the .jsonl files of a session into one event stream (main first). */
async function combine(
	files: File[],
): Promise<{ name: string; text: string } | null> {
	const jsonl = files.filter((f) => JSONL.test(f.name));
	if (jsonl.length === 0) return null;
	jsonl.sort((a, b) => b.size - a.size); // largest = the main transcript
	const texts = await Promise.all(jsonl.map((f) => f.text()));
	const main = jsonl[0]?.name ?? "session";
	const name = jsonl.length === 1 ? main : `${main} +${jsonl.length - 1}`;
	return { name, text: texts.join("\n") };
}

function fileKey(file: File): string {
	return file.webkitRelativePath || file.name;
}

function archiveNameFor(trace: File): string {
	const key = fileKey(trace);
	const parts = key.split("/").filter(Boolean);
	if (parts.length > 1) return parts[parts.length - 2] ?? trace.name;
	return trace.name;
}

async function afrInput(files: File[]): Promise<AfrInput | null> {
	const byName = new Map(files.map((file) => [file.name, file]));
	const trace = byName.get(AFR_TRACE);
	if (!trace) return null;
	const read = async (name: string): Promise<string | undefined> => {
		const file = byName.get(name);
		return file ? file.text() : undefined;
	};
	return {
		name: archiveNameFor(trace),
		traceText: await trace.text(),
		privacyReportText: await read(AFR_PRIVACY),
		validationReportText: await read(AFR_VALIDATION),
		reconciliationReportText: await read(AFR_RECONCILIATION),
		manifestText: await read(AFR_MANIFEST),
	};
}

export function DropZone({
	onLoad,
	onError,
}: {
	onLoad: (payload: DropPayload) => void;
	onError: (message: string) => void;
}) {
	const [over, setOver] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	async function take(files: File[]): Promise<void> {
		try {
			const afr = await afrInput(files);
			if (afr) {
				onLoad({ kind: "afr", input: afr });
				return;
			}
			const merged = await combine(files);
			if (!merged) {
				onError(
					"No transcript or AFR trace found. Drop a session folder, .jsonl files, or an AFR archive.",
				);
				return;
			}
			onLoad({ kind: "transcript", name: merged.name, text: merged.text });
		} catch (e) {
			onError(e instanceof Error ? e.message : String(e));
		}
	}

	return (
		<div className="drop">
			<div
				className={`drop__box${over ? " drop__box--over" : ""}`}
				role="button"
				tabIndex={0}
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
				<svg
					className="drop__wave"
					width="64"
					height="30"
					viewBox="0 0 64 30"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M1 15 H10 L15 4 L22 26 L29 9 L35 21 L40 15 H63" />
				</svg>
				<h1 className="drop__title">Replay an agent session</h1>
				<p className="drop__desc">
					Drop a Claude Code session folder (or its .jsonl files), or a Codex
					rollout, to see exactly where the run went wrong. Drop an AFR archive
					to rank local control-plane findings across sources.
				</p>
				<span className="chip">
					Drop a session folder / AFR archive / .jsonl files
				</span>
				<input
					ref={inputRef}
					type="file"
					accept=".jsonl,.json,application/json"
					multiple
					hidden
					onChange={(e) => {
						const files = Array.from(e.target.files ?? []);
						e.target.value = ""; // allow re-picking the same file after an error
						void take(files);
					}}
				/>
				<p className="drop__priv">
					Parsed entirely in your browser. <b>Nothing is uploaded.</b>
				</p>
			</div>
		</div>
	);
}
