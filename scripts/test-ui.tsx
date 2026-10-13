import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { parseAfrBundle } from "../src/core/afr/parse.ts";
import {
	analyzeControlBundle,
	exportActionBundle,
	filterControlReportBySourcePreset,
} from "../src/core/control/engine.ts";
import {
	ActionBundleReplayPreview,
	DecisionFlightDeck,
} from "../src/ui/components/DecisionFlightDeck.tsx";
import { afrInput, readEntry, type DroppedFile } from "../src/ui/components/DropZone.tsx";

function dropped(path: string, name: string, text: string): DroppedFile {
	const file = new File([text], name);
	return { file, name, path, size: file.size, text: async () => text };
}

await assert.rejects(
	afrInput([
		dropped("archive-a/trace.afr.jsonl", "trace.afr.jsonl", "{}"),
		dropped("archive-b/trace.afr.jsonl", "trace.afr.jsonl", "{}"),
	]),
	/Multiple AFR archives/,
);
await assert.rejects(
	afrInput([
		dropped("trace.afr.jsonl", "trace.afr.jsonl", "{}"),
		dropped("trace.afr.jsonl", "trace.afr.jsonl", "{}"),
	]),
	/Multiple AFR archives/,
);
const isolatedArchive = await afrInput([
	dropped("archive-a/trace.afr.jsonl", "trace.afr.jsonl", "{}"),
	dropped("archive-b/privacy-report.afr.json", "privacy-report.afr.json", "{\"ok\":false}"),
]);
assert.equal(isolatedArchive?.privacyReportText, undefined);
const unreadable = {
	isFile: true,
	isDirectory: false,
	fullPath: "/fixture/unreadable.jsonl",
	file: (_success: (file: File) => void, failure: (error: DOMException) => void) =>
		failure(new DOMException("permission denied", "NotReadableError")),
} as unknown as FileSystemEntry;
await assert.rejects(readEntry(unreadable, []), /Could not read dropped file/);

const archive = parseAfrBundle({
	name: "fixture",
	traceText: "",
	reconciliationReportText: JSON.stringify({
		ok: false,
		sources: [{ source: "evals", status: "warning", warnings: ["stale"] }],
	}),
});
const report = analyzeControlBundle(archive, Date.parse("2026-07-01T00:00:00Z"));
const evalsAction = report.actions.find((action) => action.sourceSystems.includes("evals"));
assert.ok(evalsAction, "fixture should produce an evals action");
const filtered = filterControlReportBySourcePreset(report, "hooks-mcp");
const replay = renderToStaticMarkup(
	<ActionBundleReplayPreview
		archiveName={archive.name}
		report={filtered}
		fullReport={report}
		initialBundleText={exportActionBundle(evalsAction).text}
	/>,
);
assert.match(replay, /value="[^"]*"|<textarea[^>]*>[\s\S]*## Command/);
assert.match(replay, /hidden by preset/);

const emptyReport = analyzeControlBundle(parseAfrBundle({ name: "empty", traceText: "" }));
const emptyDeck = renderToStaticMarkup(
	<DecisionFlightDeck bundle={archive} report={{ ...emptyReport, actions: [] }} />,
);
assert.match(emptyDeck, /aria-label="Paste action bundle"/);
assert.match(emptyDeck, />missing</);
const invalidArchive = parseAfrBundle({ name: "invalid", traceText: "", privacyReportText: '{"ok":"broken"}' });
const invalidReport = renderToStaticMarkup(
	<DecisionFlightDeck bundle={invalidArchive} report={analyzeControlBundle(invalidArchive)} />,
);
assert.match(invalidReport, />invalid</);
assert.match(invalidReport, /privacyReport\.ok: expected a valid value/);
console.log("UI SSR replay checks passed");
