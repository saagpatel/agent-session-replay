/** Headless render proof (dev-only): SSR the UI components against a real
 * transcript via Vite's ssrLoadModule. Not part of the build. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { detect } from "../src/core/detect/engine.ts";
import { parseTranscript } from "../src/core/parse.ts";
import { buildTimeline } from "../src/core/view/timeline.ts";
import { FindingsPanel } from "../src/ui/components/FindingsPanel.tsx";
import { RunHeader } from "../src/ui/components/RunHeader.tsx";
import { Waterfall } from "../src/ui/components/Waterfall.tsx";

const fixture = new URL("../fixtures/render-smoke.jsonl", import.meta.url);
const expectedFixture = new URL("../fixtures/render-smoke.expected.json", import.meta.url);
const text = readFileSync(fixture, "utf8");
const { harness, trace } = parseTranscript(text);
const findings = detect(trace);
const timeline = buildTimeline(trace, findings);

const html = renderToStaticMarkup(
	<>
		<RunHeader trace={trace} findings={findings} timeline={timeline} />
		<Waterfall
			timeline={timeline}
			selectedStepId={null}
			onSelect={() => {}}
			focusedFindingId={null}
		/>
		<FindingsPanel findings={findings} activeId={null} onSelect={() => {}} />
	</>,
);

const count = (re: RegExp) => (html.match(re) || []).length;
const totalBars = timeline.lanes.reduce((n, l) => n + l.bars.length, 0);
const actual = {
	harness,
	stats: count(/stat__value/g),
	lanes: count(/lane__label/g),
	bars: count(/class="bar/g),
	tracers: count(/class="tracer/g),
	findings: count(/finding__title/g),
};
const expected = JSON.parse(readFileSync(expectedFixture, "utf8")) as typeof actual;
assert.deepEqual(actual, expected, "rendered UI counts must match the committed smoke fixture");
console.log("render smoke counts:", JSON.stringify(actual));
