/** Headless render proof (dev-only): SSR the UI components against a real
 * transcript via Vite's ssrLoadModule. Not part of the build. */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { detect } from "../src/core/detect/engine.ts";
import { parseTranscript } from "../src/core/parse.ts";
import { buildTimeline } from "../src/core/view/timeline.ts";
import { FindingsPanel } from "../src/ui/components/FindingsPanel.tsx";
import { RunHeader } from "../src/ui/components/RunHeader.tsx";
import { Waterfall } from "../src/ui/components/Waterfall.tsx";

const text = process.argv
	.slice(2)
	.map((p) => readFileSync(p, "utf8"))
	.join("\n");
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
console.log("harness         :", harness);
console.log("html length     :", html.length, "chars (rendered, no throw)");
console.log("stat readouts   :", count(/stat__value/g));
console.log(
	"lanes rendered  :",
	count(/lane__label/g),
	"(expected",
	timeline.lanes.length,
	")",
);
console.log(
	"bars rendered   :",
	count(/class="bar/g),
	"(expected",
	totalBars,
	")",
);
console.log("tracers overlay :", count(/class="tracer/g));
console.log(
	"findings cards  :",
	count(/finding__title/g),
	"(expected",
	findings.length,
	")",
);
console.log("top finding     :", findings[0]?.title ?? "(clean run)");
