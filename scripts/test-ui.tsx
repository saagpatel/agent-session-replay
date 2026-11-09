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

	// "load another" reopens the loader with the last pair still loaded.
	const { RunDiffLoader } = await import("../src/ui/components/RunDiffLoader.tsx");
	const noop = () => {};
	const loader = renderToStaticMarkup(
		<RunDiffLoader
			initial={{
				left: { fileName: "cc.jsonl", harness: "claude-code", trace: left },
				right: { fileName: "codex.jsonl", harness: "codex", trace: right },
			}}
			onCompare={noop}
			onBack={noop}
			onError={noop}
			onClearError={noop}
		/>,
	);
	assert.match(loader, /cc\.jsonl/);
	// Run Diff is labelled experimental, with its known limits, on both screens.
	assert.match(loader, /rd-experimental/);
	assert.match(html, /rd-experimental/);
	assert.match(html, /known limits/);

	// Steps without a recorded result say so, reads included.
	const unknownRead = diffRuns(
		parseTranscript(toJsonl(ccEvents("look", [{ name: "Read", file: "src/a.ts" }]).filter((e) => e["uuid"] !== "r0"))).trace,
		right,
	);
	const unknownHtml = renderToStaticMarkup(<RunDiffView diff={unknownRead} leftFile="a" rightFile="b" />);
	assert.match(unknownHtml, /rd-cell__unknown/);
	assert.match(loader, /codex\.jsonl/);

	// Without raw traces the new modes stay unavailable.
	assert.match(html, /Work Equivalence/);
	assert.match(html, /Branch Preservation/);
	assert.match(html, /Load both transcripts to use this mode/);

	// Work Equivalence shows a merged search, its rule, and the original steps.
	const bulkSearch = parseTranscript(
		toJsonl(
			ccEvents("look", [
				{ name: "Grep", pattern: "token" },
				{ name: "Read", file: "src/b.ts" },
				{ name: "Grep", pattern: "token" },
			]),
		),
	).trace;
	const oneSearch = parseTranscript(
		toJsonl(
			ccEvents("look", [
				{ name: "Grep", pattern: "token" },
				{ name: "Read", file: "src/b.ts" },
			]),
		),
	).trace;
	const equivHtml = renderToStaticMarkup(
		<RunDiffView
			diff={diffRuns(bulkSearch, oneSearch)}
			leftFile="bulk.jsonl"
			rightFile="one.jsonl"
			leftTrace={bulkSearch}
			rightTrace={oneSearch}
			mode="equivalence"
		/>,
	);
	assert.match(equivHtml, /rd-verdict-banner--equivalent/);
	assert.match(equivHtml, />Equivalent</);
	assert.match(equivHtml, /class="rd-rule">search-dedupe/);
	assert.match(equivHtml, /rd-rule__count">2/);
	assert.match(equivHtml, /rd-eq-original__label">search \(grep\)/);
	assert.match(equivHtml, /rd-eq-original__id">toolu_0/);
	assert.match(equivHtml, /rd-eq-original__id">toolu_2/);
	assert.match(equivHtml, /rd-eq-original__status">ok/);
	assert.match(equivHtml, /read-coalesce/);
	assert.match(equivHtml, /edit-batch/);

	// Unsupported patches retain their identifying labels and source details on both sides.
	const patchA = parseTranscript(toJsonl(codexEvents("fix it", [{ kind: "patch", file: "src/a.ts" }]))).trace;
	const patchB = parseTranscript(toJsonl(codexEvents("fix it", [{ kind: "patch", file: "src/b.ts" }]))).trace;
	const patchHtml = renderToStaticMarkup(
		<RunDiffView diff={diffRuns(patchA, patchB)} leftFile="a" rightFile="b" leftTrace={patchA} rightTrace={patchB} mode="equivalence" />,
	);
	const patchRow = patchHtml.match(/<div class="rd-row rd-row--changed">[\s\S]*?(?=<\/div><\/div><\/section>)/)?.[0];
	assert.ok(patchRow, "patches should appear in a changed row");
	assert.match(patchRow, /src\/a\.ts/);
	assert.match(patchRow, /src\/b\.ts/);
	assert.equal((patchRow.match(/<details class="rd-eq-originals">/g) ?? []).length, 2);
	assert.equal((patchRow.match(/>unsupported<\/span>/g) ?? []).length, 2);
	assert.equal((patchRow.match(/rd-eq-original__id/g) ?? []).length, 2);
	assert.equal((patchRow.match(/rd-eq-original__status/g) ?? []).length, 2);

	// Distinct canonical evidence is visible and marked on both sides.
	const { ATTR } = await import("../src/core/types.ts");
	const evidenceTrace = (name: "Grep" | "Read" | "Write", args: Record<string, unknown>) => {
		const tool = name === "Grep" ? { name, pattern: "placeholder" } as const : { name, file: "src/a.ts" } as const;
		const trace = parseTranscript(toJsonl(ccEvents("look", [tool]))).trace;
		const source = trace.steps.find((step) => step.attributes[ATTR.TOOL_NAME] === name);
		assert.ok(source);
		source.attributes[ATTR.TOOL_ARGS] = args;
		return trace;
	};
	const renderEvidence = (a: typeof left, b: typeof left) => renderToStaticMarkup(
		<RunDiffView diff={diffRuns(a, b)} leftFile="a" rightFile="b" leftTrace={a} rightTrace={b} mode="equivalence" />,
	);
	const searchEvidence = renderEvidence(
		evidenceTrace("Grep", { pattern: "alpha", path: "/work/a/fixture-repo/src" }),
		evidenceTrace("Grep", { pattern: "beta", path: "/work/a/fixture-repo/src" }),
	);
	assert.match(searchEvidence, /pattern &quot;alpha&quot;/);
	assert.match(searchEvidence, /pattern &quot;beta&quot;/);
	assert.equal((searchEvidence.match(/rd-eq-evidence--changed/g) ?? []).length, 2);
	const readEvidence = renderEvidence(
		evidenceTrace("Read", { file_path: "/work/a/fixture-repo/src/a.ts", offset: 1, limit: 10 }),
		evidenceTrace("Read", { file_path: "/work/a/fixture-repo/src/a.ts", offset: 20, limit: 10 }),
	);
	assert.match(readEvidence, /lines 1–10/);
	assert.match(readEvidence, /lines 20–29/);
	assert.equal((readEvidence.match(/rd-eq-evidence--changed/g) ?? []).length, 2);
	const writeEvidence = renderEvidence(
		evidenceTrace("Write", { file_path: "/work/a/fixture-repo/src/a.ts", content: "alpha\nsecond\nthird\nfourth" }),
		evidenceTrace("Write", { file_path: "/work/a/fixture-repo/src/a.ts", content: "beta\nsecond\nthird\nfourth" }),
	);
	assert.match(writeEvidence, /rd-verdict-banner--divergent/);
	const fingerprints = [...writeEvidence.matchAll(/content fingerprint ([0-9a-f]{8})/g)].map((match) => match[1]);
	assert.equal(fingerprints.length, 2);
	assert.notEqual(fingerprints[0], fingerprints[1]);
	assert.match(writeEvidence, /<pre>alpha\nsecond\nthird\n…<\/pre>/);
	assert.match(writeEvidence, /<pre>beta\nsecond\nthird\n…<\/pre>/);
	assert.equal((writeEvidence.match(/rd-eq-evidence rd-eq-evidence--changed/g) ?? []).length, 2);

	// Incomplete evidence is named in plain words, and divergent rows use the linear highlight.
	const incompleteHtml = renderToStaticMarkup(
		<RunDiffView
			diff={diff}
			leftFile="cc.jsonl"
			rightFile="codex.jsonl"
			leftTrace={left}
			rightTrace={right}
			mode="equivalence"
		/>,
	);
	assert.match(incompleteHtml, /rd-verdict-banner--incomplete/);
	assert.match(incompleteHtml, />Incomplete</);
	assert.match(incompleteHtml, /A Codex exec cell may hide steps, so coverage is not proven/);
	assert.match(incompleteHtml, /rd-row--(?:changed|left-only|right-only)/);

	// Branch Preservation lists the retained path and the dropped retry.
	const retry = parseTranscript(
		toJsonl(
			ccEvents("retry the tests", [
				{ name: "Bash", command: "npm test", error: "fixture failure" },
				{ name: "Bash", command: "npm test" },
			]),
		),
	).trace;
	const branchHtml = renderToStaticMarkup(
		<RunDiffView
			diff={diffRuns(retry, oneSearch)}
			leftFile="retry.jsonl"
			rightFile="one.jsonl"
			leftTrace={retry}
			rightTrace={oneSearch}
			mode="preservation"
		/>,
	);
	assert.match(branchHtml, /Commit link not checked: no repository snapshot loaded/);
	assert.match(branchHtml, />Retained</);
	assert.match(branchHtml, />Attempted and dropped</);
	assert.match(branchHtml, /rd-branch-drop__kind">retry/);
	assert.match(branchHtml, /rd-branch-drop__file">npm test/);
	assert.match(branchHtml, /rd-branch-drop__count">1 step/);
	assert.match(branchHtml, /Repeated signature after failed or unknown attempt/);
	assert.match(branchHtml, /<details class="rd-branch-drop" open="">/);
	const controls = {
		...retry,
		steps: [
			{ ...retry.steps[0]!, step_id: "control-llm", kind: "llm" as const },
			{ ...retry.steps[0]!, step_id: "control-decision", kind: "decision" as const },
			...retry.steps.filter((step) => step.kind === "tool_call"),
		],
	};
	const controlHtml = renderToStaticMarkup(
		<RunDiffView diff={diffRuns(controls, controls)} leftFile="a" rightFile="b" leftTrace={controls} rightTrace={controls} mode="preservation" />,
	);
	for (const controlLane of controlHtml.split('<section class="rd-branch__lane"').slice(1)) {
		assert.match(controlLane, /<details><summary>Control steps: 2 \(llm turns, decisions, …\), not work<\/summary><ol><li>#1 other<\/li><li>#2 other<\/li><\/ol><\/details>/);
	}
	assert.equal(controlHtml.split('<section class="rd-branch__lane"').length - 1, 2);

	const shellWrite = parseTranscript(toJsonl(ccEvents("write", [{ name: "Bash", command: "echo hello > src/a.ts" }]))).trace;
	const shellWriteHtml = renderToStaticMarkup(
		<RunDiffView diff={diffRuns(shellWrite, shellWrite)} leftFile="a" rightFile="b" leftTrace={shellWrite} rightTrace={shellWrite} mode="preservation" />,
	);
	const lane = shellWriteHtml.split('<section class="rd-branch__lane"')[1]!;
	const retained = lane.split("<h3>Retained</h3>")[1]!.split("<h3>Attempted and dropped</h3>")[0]!;
	const unknown = lane.split("<h3>Unknown</h3>")[1]!;
	assert.doesNotMatch(retained, /src\/a\.ts/);
	assert.match(unknown, /src\/a\.ts/);
	assert.match(unknown, /end state is incomplete|lineage was proven/);

	// More than six dropped branches stay collapsed so the lane can still be scanned.
	const crowded = parseTranscript(
		toJsonl(
			ccEvents(
				"several retries",
				["npm test", "npm run build", "npm run lint", "node build.js", "node lint.js", "node check.js", "make check"].flatMap(
					(command) => [
						{ name: "Bash" as const, command, error: "fixture failure" },
						{ name: "Bash" as const, command },
					],
				),
			),
		),
	).trace;
	const crowdedHtml = renderToStaticMarkup(
		<RunDiffView
			diff={diffRuns(crowded, crowded)}
			leftFile="crowded.jsonl"
			rightFile="crowded.jsonl"
			leftTrace={crowded}
			rightTrace={crowded}
			mode="preservation"
		/>,
	);
	const droppedGroups = crowdedHtml.match(/<details class="rd-branch-drop"/g) ?? [];
	assert.ok(droppedGroups.length > 6, `expected collapsed groups, saw ${droppedGroups.length}`);
	assert.equal(crowdedHtml.includes('<details class="rd-branch-drop" open="">'), false);
}

{
	// Long diffs must never squeeze the mode switch out of view (it lives in a height-limited column).
	const { readFileSync } = await import("node:fs");
	const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
	const rule = css.match(/\.rd-modes\s*\{([^}]*)\}/)?.[1] ?? "";
	assert.match(rule, /flex-shrink:\s*0/);
}

console.log("UI SSR replay checks passed");
