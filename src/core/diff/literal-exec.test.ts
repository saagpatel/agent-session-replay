import { test } from "node:test";
import assert from "node:assert/strict";
import { literalExecCalls } from "./normalize.ts";

test("literal exec calls scan escapes sequentially", () => {
	const patch = "*** Begin Patch\n*** Add File: src/example.ts\n+const pattern = /\\w+/;\n*** End Patch";
	assert.equal(literalExecCalls(`text(await tools.apply_patch(${JSON.stringify(patch)}))`)?.[0]?.patch, patch);
	for (const escape of [String.raw`\x41`, String.raw`\u0041`, String.raw`\123`, String.raw`\01`, "\\\n"]) {
		assert.equal(literalExecCalls(`text(await tools.apply_patch('value${escape}'))`), null, escape);
	}
	for (const escape of [String.raw`\\`, String.raw`\'`, String.raw`\"`, "\\`", String.raw`\n`, String.raw`\t`, String.raw`\r`, String.raw`\0`, String.raw`\$`, String.raw`\/`]) {
		assert.notEqual(literalExecCalls(`text(await tools.apply_patch('${escape}'))`), null, escape);
	}
});
