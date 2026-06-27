import assert from "node:assert/strict";
import { test } from "node:test";

import { parseJsonl } from "./jsonl.ts";

test("parseJsonl parses each non-blank line as JSON", () => {
	const out = parseJsonl('{"a":1}\n{"b":2}\n');
	assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test("parseJsonl skips blank and whitespace-only lines", () => {
	const out = parseJsonl('\n  \n{"a":1}\n\n');
	assert.deepEqual(out, [{ a: 1 }]);
});

test("parseJsonl tolerates a malformed line without aborting the parse", () => {
	const out = parseJsonl('{"a":1}\nnot valid json\n{"b":2}');
	assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test("parseJsonl handles CRLF line endings", () => {
	const out = parseJsonl('{"a":1}\r\n{"b":2}\r\n');
	assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});
