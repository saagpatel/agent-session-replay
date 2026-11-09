import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateReplayFixtures } from "../src/core/export/fixtures/generate.ts";
import { validateExport } from "../src/core/export/index.ts";
import { parseManifest } from "../src/core/export/manifest.ts";
import { buildSidecar, renderSidecarMarkdown, validateSidecar, type Sidecar } from "../src/core/export/sidecar.ts";
import type { Trace } from "../src/core/types.ts";

type EvidenceScene = Sidecar["scenes"][number];
export interface ScenePage {
	steps: EvidenceScene["steps"]; captions: EvidenceScene["captions"];
	page: number; pageCount: number; durationMs: number;
}

/** Every item appears once; pagination may extend a scene to preserve readable holds. */
export function planScenePages(scene: EvidenceScene): ScenePage[] {
	for (const caption of scene.captions) {
		if (Array.from(caption.text).length > 400) throw new Error(`Caption ${caption.id} exceeds 400 characters; refusing to render.`);
	}
	const pageCount = Math.max(1, Math.ceil(scene.steps.length / 8), Math.ceil(scene.captions.length / 3));
	return Array.from({ length: pageCount }, (_, i) => ({
		steps: scene.steps.slice(i * 8, (i + 1) * 8), captions: scene.captions.slice(i * 3, (i + 1) * 3),
		page: i + 1, pageCount, durationMs: Math.max(2000, scene.durationMs / pageCount),
	}));
}

const bundleFiles = ["evidence.json", "evidence.md", "replay.mp4"];
function promoteBundle(staging: string, out: string): void {
	const previous = bundleFiles.filter((name) => existsSync(resolve(out, name)));
	for (const name of previous) copyFileSync(resolve(out, name), resolve(staging, `previous-${name}`));
	try {
		for (const name of bundleFiles) rmSync(resolve(out, name), { force: true });
		for (const name of bundleFiles) renameSync(resolve(staging, name), resolve(out, name));
	} catch (error) {
		for (const name of bundleFiles) rmSync(resolve(out, name), { force: true });
		for (const name of previous) renameSync(resolve(staging, `previous-${name}`), resolve(out, name));
		throw error;
	}
}

export function main(args = process.argv.slice(2)): void {
	const usage = "Usage: pnpm export:replay <trace.json> <manifest.json> --out <dir> [--allow-invalid] | --session <NN-slug> --out <dir> [--allow-invalid]";
	const allowInvalid = args.includes("--allow-invalid");
	const positional: string[] = []; let out = ""; let slug = "";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--allow-invalid") continue;
		if (arg === "--out" || arg === "--session") {
			const next = args[++i]; if (!next || next.startsWith("--")) throw new Error(usage);
			if (arg === "--out") { if (out) throw new Error(usage); out = next; }
			else { if (slug) throw new Error(usage); slug = next; }
		} else if (arg.startsWith("--")) throw new Error(usage);
		else positional.push(arg);
	}
	if (!out || (slug ? positional.length !== 0 : positional.length !== 2)) throw new Error(usage);
	mkdirSync(resolve(out), { recursive: true });
	const staging = mkdtempSync(resolve(out, ".staging-"));
	let evidence: unknown;
	let markdown = "";
	try {
		const session = slug ? generateReplayFixtures().sessions.find((s) => s.slug === slug) : undefined;
		if (slug && !session) throw new Error(`Unknown session: ${slug}`);
		const trace: Trace = session?.trace ?? JSON.parse(readFileSync(positional[0]!, "utf8"));
		const parsed = parseManifest(session?.faithful ?? readFileSync(positional[1]!, "utf8"));
		if ("errors" in parsed) {
			evidence = { verdict: "INVALID", failures: parsed.errors };
			throw new Error(parsed.errors.map((e) => e.message).join("\n"));
		}
		const validation = validateExport(parsed, trace);
		const sidecar = buildSidecar(parsed, trace, validation);
		evidence = sidecar;
		markdown = renderSidecarMarkdown(sidecar);
		const sidecarValidation = validateSidecar(sidecar, trace, parsed);
		if (!validation.ok && !allowInvalid) throw new Error(`Invalid manifest; refusing to render: ${validation.failures.map((f) => f.reason).join(", ")}`);
		if (!sidecarValidation.ok && validation.ok) throw new Error(`Invalid sidecar: ${sidecarValidation.errors.join("; ")}`);
		const pages = sidecar.scenes.map(planScenePages);
		let positionMs = 3500;
		sidecar.scenes.forEach((scene, i) => {
			scene.positionMs = positionMs;
			scene.durationMs = pages[i]!.reduce((sum, page) => sum + page.durationMs, 0);
			positionMs += scene.durationMs;
		});
		markdown = renderSidecarMarkdown(sidecar);
		writeFileSync(resolve(staging, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
		writeFileSync(resolve(staging, "evidence.md"), markdown);
		const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		const ffmpeg = process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg";
		if (!existsSync(chrome)) throw new Error(`Chrome not found: ${chrome}`);
		if (!existsSync(ffmpeg)) throw new Error(`ffmpeg not found: ${ffmpeg}`);
		const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
		const badge = `<span class="badge ${sidecar.verdict === "INVALID" ? "invalid" : ""}">${sidecar.verdict}</span>`;
		const card = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#0a1020;color:#eef4ff;font:24px -apple-system,BlinkMacSystemFont,sans-serif}
main{height:720px;padding:24px 72px;background:radial-gradient(circle at 95% 0%,#243c62,#0a1020 60%);display:flex;flex-direction:column}
.eyebrow{color:#75dfd2;letter-spacing:.15em;font-size:17px;text-transform:uppercase}h1{font-size:32px;line-height:36px;margin:8px 0 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hero{margin:auto 0}.hero p{color:#b7c9e2}.badge,.pill,.lane{display:inline-block;border-radius:20px;padding:5px 12px;font-size:15px;white-space:nowrap}.badge{color:#75dfd2;border:1px solid #75dfd2;font-weight:700}.invalid{color:#ff9c9f;border-color:#ff9c9f}
.steps{display:flex;flex-direction:column;border-left:2px solid #416b79;padding-left:16px;gap:2px}.step{display:flex;align-items:center;gap:10px;height:24px;flex-shrink:0;font-size:18px}.num{color:#75dfd2}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.pill{background:#ffffff16;color:#dbe9fa}.lane{background:#214b58;color:#a8f0e4}.captions{margin-top:12px;color:#f4f8ff;font:18px/22px monospace}.caption{margin:4px 0}.captions p{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.caption-ref{color:#8eddd2;font:16px/18px monospace}footer{color:#9db0ca;font-size:16px;line-height:20px;margin-top:auto;padding-top:8px}.progress{position:absolute;bottom:0;left:0;height:5px;background:#75dfd2}
</style></head><body><main>${body}</main><script>
// Wrap measured glyphs at the caption font size. Fail closed if content cannot fit.
let fits = true;
for (const element of document.querySelectorAll(".captions p")) {
	const text = Array.from(element.textContent.replace(/\\s+/g, " ").trim());
	const context = document.createElement("canvas").getContext("2d");
	context.font = getComputedStyle(element).font;
	const lines = []; let line = "";
	for (const char of text) {
		if (line && context.measureText(line + char).width > element.clientWidth) { lines.push(line); line = ""; }
		line += char;
	}
	if (line) lines.push(line);
	element.textContent = lines.join("\\n");
	if (lines.length > 4) fits = false;
}
for (const element of document.querySelectorAll(".step, .caption, footer")) {
	const bounds = element.getBoundingClientRect();
	if (bounds.bottom > 696 || bounds.right > 1208 || bounds.top < 24) fits = false;
}
const marker = document.createElement("meta");
marker.name = "replay-layout"; marker.content = fits ? "ok" : "overflow";
document.head.append(marker);
</script></body></html>`;
		const number = (step: { index: number } | undefined) => step ? `#${step.index + 1}` : "unknown";
		const cards = [card(`<div class="eyebrow">Agent Session Replay · Local export</div><div class="hero"><h1>${escape(parsed.title)}</h1><p>Source run ${escape(parsed.source.runId.slice(0, 12))}</p><p>Shortened replay: ${sidecar.counts.exportedSteps} of ${sidecar.counts.sourceSteps} source steps, ${sidecar.counts.scenes} scenes</p>${badge}</div>`),
			...sidecar.scenes.flatMap((scene, i) => pages[i]!.map((page) => card(`<div class="eyebrow">Scene ${i + 1} of ${sidecar.counts.scenes}</div><h1>${escape(scene.id)}</h1><div class="steps">${page.steps.map((step) => `<div class="step"><span class="num">${number(step)}</span><span class="label">${escape(step.label)}</span><span class="pill">${escape(step.status)}</span>${step.lane ? `<span class="lane">${escape(step.lane.replaceAll("-", " "))}</span>` : ""}</div>`).join("")}</div><div class="captions">${page.captions.map((caption) => `<div class="caption"><p>${caption.ok ? "✓" : "✗"} ${escape(caption.text)}</p>${caption.kind === "because" ? `<div class="caption-ref">${number(caption.refs[0])} → ${number(caption.refs[1])}</div>` : ""}</div>`).join("")}</div><footer>page ${page.page} of ${page.pageCount} · steps ${scene.range.from ? scene.range.from.index + 1 : "?"}–${scene.range.to ? scene.range.to.index + 1 : "?"} of ${trace.steps.length}</footer><div class="progress" style="width:${(i + 1) / sidecar.counts.scenes * 100}%"></div>`))),
			card(`<div class="eyebrow">Replay complete</div><div class="hero"><h1>Evidence summary</h1>${badge}<p>${sidecar.counts.exportedSteps} of ${sidecar.counts.sourceSteps} source steps · ${sidecar.counts.scenes} scenes · ${sidecar.counts.captions} captions</p><p>Evidence: evidence.md</p></div><footer>Source digest: ${escape(sidecar.sourceDigest)}</footer>`)];
		const durations = [3500, ...pages.flatMap((scene) => scene.map((page) => page.durationMs)), 3500];
		if (durations.some((d) => d < 400)) throw new Error("Scene durations must be at least 400 ms for crossfades.");
		const temp = mkdtempSync(resolve(staging, "cards-"));
		try {
			for (let i = 0; i < cards.length; i++) {
				const html = resolve(temp, `${i}.html`); const png = resolve(temp, `${i}.png`);
				writeFileSync(html, cards[i]!);
				// Check the actual fixed-font layout before capturing; never encode a clipped VALID card.
				const layout = spawnSync(chrome, ["--headless=new", `--user-data-dir=${resolve(temp, `chrome-layout-${i}`)}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,720", "--dump-dom", pathToFileURL(html).href], { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
				if (layout.error || layout.status !== 0 || !layout.stdout.includes('<meta name="replay-layout" content="ok">')) {
					throw new Error(`Chrome layout check failed: card ${i}; captions must fit four lines at 18px and all rows must fit the page. ${layout.error?.message ?? layout.stderr}`);
				}
				// An isolated profile per attempt keeps headless Chrome from attaching to a running browser;
				// headless screenshots occasionally hang under load, so retry once before failing.
				const shoot = (attempt: number) => spawnSync(chrome, ["--headless=new", `--user-data-dir=${resolve(temp, `chrome-profile-${i}-${attempt}`)}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--window-size=1280,720", `--screenshot=${png}`, pathToFileURL(html).href], { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
				// Headless Chrome sometimes writes the screenshot and then fails to exit; a complete PNG is the evidence.
				const written = () => existsSync(png) && statSync(png).size > 12 && readFileSync(png).subarray(-12).includes("IEND");
				let result = shoot(1);
				if (!written()) result = shoot(2);
				if (!written()) throw new Error(`Chrome screenshot failed: ${result.error?.message ?? result.stderr}`);
			}
			const input = cards.flatMap((_, i) => ["-loop", "1", "-framerate", "25", "-t", String((durations[i]! + (i < cards.length - 1 ? 400 : 0)) / 1000), "-i", resolve(temp, `${i}.png`)]);
			let offset = 0; const filters: string[] = [];
			for (let i = 1; i < cards.length; i++) {
				offset += durations[i - 1]! / 1000;
				filters.push(`${i === 1 ? "[0:v]" : `[v${i - 1}]`}[${i}:v]xfade=transition=fade:duration=0.4:offset=${offset}[v${i}]`);
			}
			const filterArgs = filters.length ? ["-filter_complex", filters.join(";"), "-map", `[v${cards.length - 1}]`] : [];
			const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", ...input, ...filterArgs, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", resolve(staging, "replay.mp4")], { encoding: "utf8" });
			if (result.error || result.status !== 0) throw new Error(`ffmpeg failed: ${result.error?.message ?? result.stderr}`);
		} finally { rmSync(temp, { recursive: true, force: true }); }
		promoteBundle(staging, out);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failed = mkdtempSync(resolve(out, `failed-${new Date().toISOString().replaceAll(":", "-")}-`));
		writeFileSync(resolve(failed, "evidence.json"), `${JSON.stringify(evidence ?? { verdict: "INVALID", failures: [message] }, null, 2)}\n`);
		writeFileSync(resolve(failed, "evidence.md"), markdown || `# Replay evidence\nVerdict: INVALID\n${message}\n`);
		writeFileSync(resolve(failed, "error.txt"), `${message}\n`);
		console.error(`Export failed; evidence saved to ${failed}`);
		throw error;
	} finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { main(); } catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
