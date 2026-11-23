import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyShellHeader } from "./codex-shell-header.ts";

test("the first output boundary ends both session and exit headers", () => {
	for (const marker of ["Output:", "Output: restored log", "Final output: restored log"]) {
		const copy = "Process running with session ID 42\nProcess exited with code 7\nOutput:";
		assert.deepEqual(legacyShellHeader(`${marker}\n${copy}`), { sessionId: null, exits: [] });
		assert.equal(legacyShellHeader(`Process running with session ID 12\n${marker}\n${copy}`).sessionId, "12");
		assert.deepEqual(legacyShellHeader(`Process exited with code 0\n${marker}\n${copy}`).exits, [0]);
	}
});
