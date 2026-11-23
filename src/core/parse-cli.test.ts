import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the smoke CLI reports partial coverage when parsed records have no findings", (t) => {
	const cli = fileURLToPath(new URL("../../scripts/parse-real.ts", import.meta.url));
	const input = [
		{ type: "system", subtype: "api_error", sessionId: "example", uuid: "event-a" },
		{ type: "data-flow-incomplete" },
	].map((event) => JSON.stringify(event)).join("\n");
	const dir = mkdtempSync(join(tmpdir(), "replay-partial-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "partial.jsonl");
	writeFileSync(path, input);
	const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /unsupported records\s*:\s*1/i);
	assert.match(result.stdout, /incomplete records\s*:\s*1/i);
	assert.match(result.stdout, /no findings in (?:the )?parsed records/i);
	assert.doesNotMatch(result.stdout, /clean run/i);
});
