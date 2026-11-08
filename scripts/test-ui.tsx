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

// ---- Run Diff -------------------------------------------------------------

{
	const { takeRunFiles } = await import("../src/ui/components/RunDiffLoader.tsx");
	const { RunDiffView } = await import("../src/ui/components/RunDiffView.tsx");
	const { diffRuns } = await import("../src/core/diff/run-diff.ts");
	const { ccEvents, codexEvents, toJsonl } = await import("../src/core/diff/fixtures.ts");
	const { parseTranscript } = await import("../src/core/parse.ts");

	// A clean load clears a banner an earlier bad file left behind.
	const log: string[] = [];
	const handlers = {
		onRun: () => log.push("run"),
		onError: (m: string) => log.push(`error:${m.slice(0, 10)}`),
		onClearError: () => log.push("clear"),
	};
	await takeRunFiles([dropped("notes.txt", "notes.txt", "hello")], handlers);
	const cc = toJsonl(ccEvents("fix it", [{ name: "Edit", file: "src/a.ts" }, { name: "Bash", command: "npm test" }]));
	await takeRunFiles([dropped("cc.jsonl", "cc.jsonl", cc)], handlers);
	assert.deepEqual(log, ["error:No .jsonl ", "run", "clear"]);

	// The view renders both lanes, the flagged fork and its explanation.
	const left = parseTranscript(cc).trace;
	const right = parseTranscript(
		toJsonl(codexEvents("fix it", [{ kind: "patch", file: "src/b.ts" }, { kind: "exec-cell", command: "npm test", exit: 1 }])),
	).trace;
	const diff = diffRuns(left, right);
	const html = renderToStaticMarkup(<RunDiffView diff={diff} leftFile="cc.jsonl" rightFile="codex.jsonl" />);
	assert.match(html, /Divergence that mattered/);
	assert.match(html, /rd-row--pivot/);
	assert.match(html, /Claude Code/);
	assert.match(html, /tests failed/);
	assert.ok(html.includes("<code>src/a.ts</code>"), "explanation renders code spans");
}

console.log("UI SSR replay checks passed");
