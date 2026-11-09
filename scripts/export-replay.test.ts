import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateReplayFixtures } from "../src/core/export/fixtures/generate.ts";
import { validateExport } from "../src/core/export/index.ts";
import { buildSidecar } from "../src/core/export/sidecar.ts";
import { main, planScenePages, promoteBundle } from "./export-replay.ts";

function crowdedScene() {
	const { trace, faithful } = generateReplayFixtures().sessions[0]!;
	const scene = buildSidecar(faithful, trace, validateExport(faithful, trace)).scenes[0]!;
	return {
		...scene, durationMs: 3500,
		steps: Array.from({ length: 20 }, (_, i) => ({ ...scene.steps[0]!, id: `step-${i}` })),
		captions: Array.from({ length: 7 }, (_, i) => ({
			...scene.captions[0]!, id: `caption-${i}`, text: i === 0 ? "Long caption. ".repeat(40).slice(0, 400) : `Caption ${i}`,
		})),
	};
}

test("crowded scenes paginate every row and caption with even, minimum holds", () => {
	const scene = crowdedScene();
	const pages = planScenePages(scene);
	assert.equal(pages.length, 3);
	assert.deepEqual(pages.map((page) => [page.steps.length, page.captions.length]), [[8, 3], [8, 3], [4, 1]]);
	assert.deepEqual(pages.flatMap((page) => page.steps), scene.steps);
	assert.deepEqual(pages.flatMap((page) => page.captions), scene.captions);
	assert.deepEqual(pages.map((page) => [page.page, page.pageCount, page.durationMs]), [[1, 3, 2000], [2, 3, 2000], [3, 3, 2000]]);
	assert.deepEqual(planScenePages({ ...scene, durationMs: 12000 }).map((page) => page.durationMs), [4000, 4000, 4000]);
});

test("a 401-character caption is rejected before rendering", () => {
	const scene = crowdedScene();
	scene.captions[0]!.text = "x".repeat(401);
	assert.throws(() => planScenePages(scene), /Caption caption-0 exceeds 400 characters/);
});

const bundleFiles = ["evidence.json", "evidence.md", "replay.mp4"];
for (const input of ["trace", "manifest"] as const) {
	for (const alias of ["direct", "input symlink", "output symlink"] as const) {
		test(`preflight refuses ${input} collision via ${alias} without creating files`, () => {
			const dir = mkdtempSync(resolve(tmpdir(), "asr-preflight-test-"));
			try {
				const { trace, faithful } = generateReplayFixtures().sessions[0]!;
				const tracePath = resolve(dir, input === "trace" ? "evidence.json" : "trace.json");
				const manifestPath = resolve(dir, input === "manifest" ? "evidence.md" : "manifest.json");
				writeFileSync(tracePath, JSON.stringify(trace));
				writeFileSync(manifestPath, JSON.stringify(faithful));
				let inputs = [tracePath, manifestPath]; let out = dir;
				if (alias !== "direct") {
					const link = resolve(dir, "alias");
					symlinkSync(alias === "input symlink" ? (input === "trace" ? tracePath : manifestPath) : dir, link);
					if (alias === "input symlink") inputs = input === "trace" ? [link, manifestPath] : [tracePath, link];
					else out = link;
				}
				const entries = readdirSync(dir);
				const before = [readFileSync(tracePath), readFileSync(manifestPath)];
				assert.throws(() => main([...inputs, "--out", out, "--allow-invalid"]), /collides with input/);
				assert.deepEqual([readFileSync(tracePath), readFileSync(manifestPath)], before);
				assert.deepEqual(readdirSync(dir), entries);
			} finally { rmSync(dir, { recursive: true, force: true }); }
		});
	}
}

test("preflight refuses an output directory equal to or nested inside either input file", () => {
	const dir = mkdtempSync(resolve(tmpdir(), "asr-preflight-test-"));
	try {
		const inputs = [resolve(dir, "trace.json"), resolve(dir, "manifest.json")];
		inputs.forEach((path) => writeFileSync(path, "synthetic input"));
		const alias = resolve(dir, "alias"); symlinkSync(dir, alias);
		for (const name of ["trace.json", "manifest.json"]) {
			for (const suffix of ["", "nested/output"]) {
				assert.throws(() => main([...inputs, "--out", resolve(alias, name, suffix)]), /output directory inside input file/);
			}
		}
		assert.deepEqual(readdirSync(dir).sort(), ["alias", "manifest.json", "trace.json"]);
		inputs.forEach((path) => assert.equal(readFileSync(path, "utf8"), "synthetic input"));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const name of bundleFiles) {
	for (const kind of ["directory", "symlink", "dangling symlink"] as const) {
		test(`preflight and promotion preserve ${kind} at ${name} without moving anything`, () => {
			const dir = mkdtempSync(resolve(tmpdir(), "asr-preflight-test-"));
			const staging = mkdtempSync(resolve(dir, ".staging-"));
			try {
				const destination = resolve(dir, name);
				const userFile = resolve(dir, "user-file"); writeFileSync(userFile, "user content");
				if (kind === "directory") {
					mkdirSync(destination); writeFileSync(resolve(destination, "keep"), "user content");
				} else symlinkSync(kind === "symlink" ? userFile : resolve(dir, "absent"), destination);
				for (const file of bundleFiles) {
					if (file !== name) writeFileSync(resolve(dir, file), `previous ${file}`);
					writeFileSync(resolve(staging, file), `new ${file}`);
				}
				const before = readdirSync(dir);
				assert.throws(() => main(["--session", "01-parser", "--out", dir]), /not a regular file/);
				assert.throws(() => promoteBundle(staging, dir), /not a regular file/);
				assert.deepEqual(readdirSync(dir), before);
				assert.equal(readFileSync(userFile, "utf8"), "user content");
				if (kind === "directory") {
					assert.deepEqual(readdirSync(destination), ["keep"]);
					assert.equal(readFileSync(resolve(destination, "keep"), "utf8"), "user content");
				} else {
					assert.ok(lstatSync(destination).isSymbolicLink());
					assert.equal(readlinkSync(destination), kind === "symlink" ? userFile : resolve(dir, "absent"));
				}
				for (const file of bundleFiles) {
					if (file !== name) assert.equal(readFileSync(resolve(dir, file), "utf8"), `previous ${file}`);
					assert.equal(readFileSync(resolve(staging, file), "utf8"), `new ${file}`);
				}
			} finally { rmSync(dir, { recursive: true, force: true }); }
		});
	}
}

for (const fault of ["rename-out second", "rename-in third", "undo previous", "undo new"] as const) {
	test(`bundle promotion preserves every previous file: ${fault}`, () => {
		const out = mkdtempSync(resolve(tmpdir(), "asr-promotion-test-"));
		const staging = mkdtempSync(resolve(out, ".staging-"));
		let previous = "";
		const cleanup: string[] = [];
		const attempts: Array<[string, string]> = [];
		try {
			for (const name of bundleFiles) {
				writeFileSync(resolve(out, name), `previous ${name}`);
				writeFileSync(resolve(staging, name), `new ${name}`);
			}
			let reported = "";
			assert.throws(() => promoteBundle(staging, out, {
				mkdir(path) { previous = path; mkdirSync(path); },
				exists: existsSync,
				lstat: lstatSync,
				rm(path, options) { cleanup.push(path); rmSync(path, options); },
				rename(from, to) {
					attempts.push([from, to]);
					if ((fault === "rename-out second" && from === resolve(out, "evidence.md") && to === resolve(previous, "evidence.md")) ||
						(fault !== "rename-out second" && from === resolve(staging, "replay.mp4")) ||
						(fault === "undo previous" && from === resolve(previous, "evidence.md")) ||
						(fault === "undo new" && from === resolve(out, "evidence.md") && to === resolve(staging, "evidence.md"))) {
						throw new Error(`Injected EPERM: ${fault}`);
					}
					renameSync(from, to);
				},
			}), (error: unknown) => {
				assert.ok(error instanceof Error);
				reported = error.message;
				return true;
			});
			const incomplete = fault.startsWith("undo");
			assert.equal(existsSync(previous), incomplete);
			assert.equal(existsSync(staging), incomplete);
			assert.deepEqual(cleanup, incomplete ? [] : [previous, staging]);
			for (const name of bundleFiles) {
				const copies = [resolve(out, name), resolve(previous, name)].filter(existsSync);
				assert.ok(copies.some((path) => readFileSync(path, "utf8") === `previous ${name}`), `Lost previous ${name}`);
			}
			if (incomplete) {
				assert.ok(reported.includes(previous), reported);
				assert.ok(reported.includes(staging), reported);
				assert.ok(reported.includes(`${resolve(previous, "evidence.md")} -> ${resolve(out, "evidence.md")}`), reported);
				assert.match(reported, /Manual restore required/);
				// Restoring evidence.json follows the failed undo; rollback must continue.
				assert.deepEqual(attempts.at(-1), [resolve(previous, "evidence.json"), resolve(out, "evidence.json")]);
				assert.equal(readFileSync(resolve(out, "evidence.json"), "utf8"), "previous evidence.json");
				if (fault === "undo new") {
					assert.equal(readFileSync(resolve(out, "evidence.md"), "utf8"), "new evidence.md");
					assert.equal(readFileSync(resolve(previous, "evidence.md"), "utf8"), "previous evidence.md");
				}
			} else assert.match(reported, /Injected EPERM/);
		} finally { rmSync(out, { recursive: true, force: true }); }
	});
}

test("promotion installs a bundle and cleans recovery directories with or without a previous bundle", () => {
	for (const oldFiles of [[], bundleFiles]) {
		const out = mkdtempSync(resolve(tmpdir(), "asr-promotion-test-"));
		const staging = mkdtempSync(resolve(out, ".staging-"));
		try {
			for (const name of oldFiles) writeFileSync(resolve(out, name), `previous ${name}`);
			for (const name of bundleFiles) writeFileSync(resolve(staging, name), `new ${name}`);
			promoteBundle(staging, out);
			assert.deepEqual(readdirSync(out).sort(), [...bundleFiles].sort());
			for (const name of bundleFiles) assert.equal(readFileSync(resolve(out, name), "utf8"), `new ${name}`);
		} finally { rmSync(out, { recursive: true, force: true }); }
	}
});

for (const failure of ["invalid manifest", "malformed manifest", "missing Chrome", "missing ffmpeg", "layout failure", "long caption"] as const) {
	test(`failed rerun preserves the existing bundle: ${failure}`, () => {
		const dir = mkdtempSync(resolve(tmpdir(), "asr-bundle-test-"));
		try {
			const { trace, faithful } = generateReplayFixtures().sessions[0]!;
			const previous = bundleFiles.map((name) => Buffer.from(`previous ${name}\n`));
			bundleFiles.forEach((name, i) => writeFileSync(resolve(dir, name), previous[i]!));
			if (failure === "invalid manifest") faithful.source.digest = "mismatched";
			if (failure === "long caption") faithful.captions[0]!.text = "x".repeat(401);
			writeFileSync(resolve(dir, "trace.json"), JSON.stringify(trace));
			writeFileSync(resolve(dir, "manifest.json"), failure === "malformed manifest" ? "{}" : JSON.stringify(faithful));
			const run = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/export-replay.ts", resolve(dir, "trace.json"), resolve(dir, "manifest.json"), "--out", dir], {
				encoding: "utf8", env: { ...process.env,
					// Node is an existing executable that rejects Chrome flags immediately; no browser starts.
					CHROME_PATH: failure === "missing ffmpeg" || failure === "layout failure" ? process.execPath : "/missing",
					FFMPEG_PATH: failure === "layout failure" ? process.execPath : "/missing",
				},
			});
			assert.notEqual(run.status, 0);
			bundleFiles.forEach((name, i) => assert.deepEqual(readFileSync(resolve(dir, name)), previous[i]));
			const entries = readdirSync(dir);
			assert.ok(!entries.some((name) => name.startsWith(".staging-")));
			const failures = entries.filter((name) => name.startsWith("failed-"));
			assert.equal(failures.length, 1);
			const failed = resolve(dir, failures[0]!);
			assert.ok(run.stderr.includes(failed), run.stderr);
			assert.ok(readFileSync(resolve(failed, "evidence.md"), "utf8").length > 0);
			const evidence = JSON.parse(readFileSync(resolve(failed, "evidence.json"), "utf8"));
			const error = readFileSync(resolve(failed, "error.txt"), "utf8");
			const expected = {
				"invalid manifest": /Invalid manifest; refusing to render/, "malformed manifest": /invalid structure/,
				"missing Chrome": /Chrome not found/, "missing ffmpeg": /ffmpeg not found/,
				"layout failure": /Chrome layout check failed/, "long caption": /exceeds 400 characters/,
			}[failure];
			assert.match(error, expected);
			if (failure === "long caption") assert.equal(evidence.scenes[0].captions[0].text, "x".repeat(401));
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
}

// These process stubs exercise bundle handling, not browser layout or real video encoding.
for (const scenario of ["none", "screenshot", "encoding", "missing cause", "missing effect", "missing shows"] as const) {
	const missing = scenario.startsWith("missing");
	const failure = missing ? "none" : scenario;
	test(`staged render ${scenario}: ${failure === "none" ? "replaces" : "preserves"} all three bundle files`, () => {
		const dir = mkdtempSync(resolve(tmpdir(), "asr-staging-test-"));
		try {
			bundleFiles.forEach((name) => writeFileSync(resolve(dir, name), `previous ${name}`));
			const tool = resolve(dir, "mock-tool.cjs");
			writeFileSync(tool, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const screenshot = args.find((arg) => arg.startsWith("--screenshot="));
if (args.includes("--dump-dom")) {
	console.log('<meta name="replay-layout" content="ok">');
} else if (screenshot) {
	if (process.env.ASR_MOCK_FAIL === "screenshot") { console.error("synthetic screenshot failure"); process.exit(1); }
	const html = require("node:url").fileURLToPath(args.at(-1));
	fs.copyFileSync(html, path.join(process.env.ASR_MOCK_OUT, "captured-" + path.basename(html)));
	fs.writeFileSync(screenshot.slice("--screenshot=".length), Buffer.concat([Buffer.alloc(20), Buffer.from("IEND"), Buffer.alloc(8)]));
} else {
	const output = args.at(-1);
	assert.match(path.basename(path.dirname(output)), /^\\.staging-/);
	assert.ok(!args.includes("-y"));
	for (const name of ["evidence.json", "evidence.md", "replay.mp4"]) {
		assert.equal(fs.readFileSync(path.join(process.env.ASR_MOCK_OUT, name), "utf8"), "previous " + name);
	}
	fs.writeFileSync(output, "mock encoded video");
	if (process.env.ASR_MOCK_FAIL === "encoding") { console.error("synthetic encoding failure"); process.exit(1); }
}
`, { mode: 0o755 });
			const session = generateReplayFixtures().sessions[0]!;
			const ids = session.trace.steps.map((step) => step.step_id);
			session.faithful.scenes = [
				{ id: "crowded", range: { from: ids[0]!, to: ids[19]! }, steps: ids.slice(0, 20) },
				{ id: "following", range: { from: ids[20]!, to: ids.at(-1)! }, steps: ids.slice(20) },
			];
			session.faithful.captions = Array.from({ length: 7 }, (_, i) => ({
				id: `caption-${i}`, sceneId: "crowded", kind: "shows", refs: [ids[0]!],
				text: i === 0 ? "Long caption. ".repeat(40).slice(0, 400) : `Caption ${i}`,
			}));
			if (missing) {
				session.faithful.captions[1] = scenario === "missing shows" ? {
					id: "caption-1", sceneId: "crowded", kind: "shows", text: "Missing shown step.", refs: ["missing-shown", ids[0]!],
				} : {
					id: "caption-1", sceneId: "crowded", kind: "because", text: "Missing causal evidence.",
					cause: scenario === "missing cause" ? "missing-cause" : ids[0]!,
					effect: scenario === "missing effect" ? "missing-effect" : ids[1]!,
				};
			}
			writeFileSync(resolve(dir, "trace.json"), JSON.stringify(session.trace));
			writeFileSync(resolve(dir, "manifest.json"), JSON.stringify(session.faithful));
			const run = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/export-replay.ts", resolve(dir, "trace.json"), resolve(dir, "manifest.json"), "--out", dir, ...(missing ? ["--allow-invalid"] : [])], {
				encoding: "utf8", env: { ...process.env, CHROME_PATH: tool, FFMPEG_PATH: tool, ASR_MOCK_OUT: dir, ASR_MOCK_FAIL: failure },
			});
			const entries = readdirSync(dir);
			assert.ok(!entries.some((name) => name.startsWith(".staging-")));
			if (failure !== "none") {
				assert.notEqual(run.status, 0);
				bundleFiles.forEach((name) => assert.equal(readFileSync(resolve(dir, name), "utf8"), `previous ${name}`));
				const failed = entries.find((name) => name.startsWith("failed-"));
				assert.ok(failed);
				assert.match(readFileSync(resolve(dir, failed, "error.txt"), "utf8"), failure === "encoding" ? /ffmpeg failed: synthetic encoding failure/ : /Chrome screenshot failed: synthetic screenshot failure/);
				assert.ok(existsSync(resolve(dir, failed, "evidence.json")) && existsSync(resolve(dir, failed, "evidence.md")));
			} else {
				assert.equal(run.status, 0, run.stderr);
				assert.equal(readFileSync(resolve(dir, "replay.mp4"), "utf8"), "mock encoded video");
				const evidence = JSON.parse(readFileSync(resolve(dir, "evidence.json"), "utf8"));
				assert.equal(evidence.verdict, missing ? "INVALID" : "VALID");
				const markdown = readFileSync(resolve(dir, "evidence.md"), "utf8");
				assert.ok(markdown.includes(`Verdict: ${missing ? "INVALID" : "VALID"}`));
				const firstPages = [1, 2, 3].map((i) => readFileSync(resolve(dir, `captured-${i}.html`), "utf8"));
				assert.deepEqual(firstPages.map((html) => (html.match(/class="step"/g) ?? []).length), [8, 8, 4]);
				assert.deepEqual(firstPages.map((html) => (html.match(/class="caption"/g) ?? []).length), [3, 3, 1]);
				firstPages.forEach((html, i) => assert.ok(html.includes(`page ${i + 1} of 3`)));
				assert.ok(firstPages[0]!.includes(session.faithful.captions[0]!.text));
				if (missing) {
					const detail = scenario === "missing cause" ? "cause: unknown (id missing-cause) → effect: #2" :
						scenario === "missing effect" ? "cause: #1 → effect: unknown (id missing-effect)" : "unknown (id missing-shown), #1";
					assert.ok(firstPages[0]!.includes(`<div class="caption-ref">${detail}</div>`));
					assert.ok(markdown.includes(detail));
					assert.ok(readFileSync(resolve(dir, "captured-0.html"), "utf8").includes('class="badge invalid">INVALID'));
					const refs = evidence.scenes[0].captions[1].refs;
					assert.equal(refs.length, 2);
					const absent = refs[scenario === "missing effect" ? 1 : 0];
					assert.equal(absent.step, null);
					assert.equal(absent.id, scenario === "missing shows" ? "missing-shown" : scenario.replace(" ", "-"));
					if (scenario !== "missing shows") assert.deepEqual(refs.map((ref: { role: string }) => ref.role), ["cause", "effect"]);
				}
				const expected = buildSidecar(session.faithful, session.trace, validateExport(session.faithful, session.trace));
				let positionMs = 3500;
				expected.scenes.forEach((scene, i) => {
					const durationMs = planScenePages(scene).reduce((sum, page) => sum + page.durationMs, 0);
					assert.equal(evidence.scenes[i].positionMs, positionMs);
					assert.equal(evidence.scenes[i].durationMs, durationMs);
					positionMs += durationMs;
				});
				assert.ok(!entries.some((name) => name.startsWith("failed-")));
			}
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
}

const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ffmpeg = process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "/opt/homebrew/bin/ffprobe";
const skip = process.env.ASR_SKIP_VIDEO ? "Chrome cannot run in this sandbox" :
	![chrome, ffmpeg, ffprobe].every(existsSync) ? "Chrome, ffmpeg or ffprobe unavailable" : false;
test("replay export produces an H.264 video with the expected duration", { skip }, () => {
	const dir = mkdtempSync(resolve(tmpdir(), "asr-video-test-"));
	try {
		const session = generateReplayFixtures().sessions[0]!;
		const run = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/export-replay.ts", "--session", session.slug, "--out", dir], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		const file = resolve(dir, "replay.mp4");
		assert.ok(statSync(file).size > 20_000);
		const probe = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" });
		assert.equal(probe.status, 0, probe.stderr);
		const info = JSON.parse(probe.stdout); const stream = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
		assert.equal(stream.codec_name, "h264"); assert.equal(stream.width, 1280); assert.equal(stream.height, 720);
		const sidecar = buildSidecar(session.faithful, session.trace, validateExport(session.faithful, session.trace));
		const expected = (7000 + sidecar.scenes.flatMap(planScenePages).reduce((sum, page) => sum + page.durationMs, 0)) / 1000;
		assert.ok(Math.abs(Number(info.format.duration) - expected) <= expected * 0.1);
		// Sample the middle of the title, first scene, and end holds. Distinct
		// frames confirm that both bookend cards survived the assembled video.
		const frames = [1, 5, expected - 1].map((at) => {
			const frame = spawnSync(ffmpeg, ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-f", "md5", "-"], { encoding: "utf8" });
			assert.equal(frame.status, 0, frame.stderr);
			assert.match(frame.stdout, /^MD5=[0-9a-f]{32}/);
			return frame.stdout.trim();
		});
		assert.equal(new Set(frames).size, 3, "title, scene and end cards must differ");
		assert.ok(existsSync(resolve(dir, "evidence.json")) && existsSync(resolve(dir, "evidence.md")));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
