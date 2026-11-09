import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateReplayFixtures } from "../src/core/export/fixtures/generate.ts";

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
		const expected = (7000 + session.faithful.scenes.reduce((sum, scene) => sum + (scene.durationMs ?? 3500), 0)) / 1000;
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
