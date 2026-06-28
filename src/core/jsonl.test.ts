import assert from "node:assert/strict";
import { test } from "node:test";

import { parseJsonl, parseJsonlWithStats } from "./jsonl.ts";

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

test("parseJsonlWithStats returns records plus a count of unparseable lines", () => {
	const { records, malformed } = parseJsonlWithStats(
		'{"a":1}\nnot json\n{"b":2}\n{oops\n',
	);
	assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
	assert.equal(malformed, 2);
});

test("parseJsonlWithStats counts zero malformed for a clean transcript (blanks ignored)", () => {
	const { malformed } = parseJsonlWithStats('{"a":1}\n  \n{"b":2}\n');
	assert.equal(malformed, 0);
});
