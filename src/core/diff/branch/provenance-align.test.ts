import assert from "node:assert/strict";
import test from "node:test";
import { alignProvenance } from "./provenance-align.ts";

test("line alignment credits only equal-line owners and preserves the final newline", () => {
	const file = { text: "new\nmarker\nnew\n", owners: [...Array<string>(3).fill("introduced"), ...Array<null>(12).fill(null)] };
	assert.equal(file.owners.length, file.text.length);
	assert.deepEqual(alignProvenance(file, "marker\nnew\n"), new Map());
	assert.deepEqual(alignProvenance(file, file.text), new Map([["introduced", 3]]));
	assert.deepEqual(alignProvenance({ text: "new\n", owners: Array<string>(4).fill("edit") }, "new"), new Map());
	assert.deepEqual(alignProvenance({ text: "", owners: [] }, ""), new Map());
});

test("binary-ish text, inconsistent provenance and oversized alignment fail closed", () => {
	assert.equal(alignProvenance({ text: "a\u0000", owners: [null, null] }, "a\u0000"), null);
	assert.equal(alignProvenance({ text: "a", owners: [] }, "a"), null);
	const text = "line\n".repeat(2000);
	assert.equal(alignProvenance({ text, owners: Array<null>(text.length).fill(null) }, text), null);
});
