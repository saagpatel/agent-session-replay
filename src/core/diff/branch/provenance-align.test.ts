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

test("duplicate introduced lines with competing base ownership fail closed", () => {
	const owners = ["introduced", "introduced", "introduced", null, null, null, null, null];
	assert.equal(
		alignProvenance({ text: "new\nnew\n", owners }, "new\n"),
		null,
	);
	assert.equal(
		alignProvenance(
			{ text: "new\nnew\n", owners: [null, null, null, null, "introduced", "introduced", "introduced", null] },
			"new\n",
		),
		null,
	);
	assert.equal(
		alignProvenance(
			{ text: "context\nnew\n", owners: [...Array<null>(8).fill(null), "introduced", "introduced", "introduced", null] },
			"context\nnew\nnew\n",
		),
		null,
	);
});

test("owned-line ambiguity matches all optimal alignments for short inputs", () => {
	const sequences: string[][] = [[]];
	for (let length = 1; length <= 3; length++) {
		for (let mask = 0; mask < 2 ** length; mask++)
			sequences.push(Array.from({ length }, (_, bit) => (mask >> bit) & 1 ? "b\n" : "a\n"));
	}
	const oracle = (source: string[], target: string[], owned: number): Set<number> => {
		const rows = source.length + 1;
		const columns = target.length + 1;
		const suffix = new Uint32Array(rows * columns);
		for (let i = source.length - 1; i >= 0; i--)
			for (let j = target.length - 1; j >= 0; j--)
				suffix[i * columns + j] = source[i] === target[j]
					? 1 + suffix[(i + 1) * columns + j + 1]!
					: Math.max(suffix[(i + 1) * columns + j]!, suffix[i * columns + j + 1]!);
		const assignments = new Set<number>();
		const walk = (i: number, j: number, assigned: number) => {
			if (i === source.length || j === target.length) {
				assignments.add(assigned);
				return;
			}
			const best = suffix[i * columns + j]!;
			if (source[i] === target[j] && 1 + suffix[(i + 1) * columns + j + 1]! === best)
				walk(i + 1, j + 1, i === owned ? j : assigned);
			if (suffix[(i + 1) * columns + j]! === best)
				walk(i + 1, j, assigned);
			if (suffix[i * columns + j + 1]! === best)
				walk(i, j + 1, assigned);
		};
		walk(0, 0, -1);
		return assignments;
	};
	for (const source of sequences)
		for (const target of sequences)
			for (let owned = 0; owned < source.length; owned++) {
				const assignments = oracle(source, target, owned);
				const text = source.join("");
				const owners = Array<string | null>(text.length).fill(null);
			const offset = source.slice(0, owned).join("").length;
			owners[offset] = "introduced";
			const aligned = alignProvenance({ text, owners }, target.join(""));
			if (assignments.size > 1) assert.equal(aligned, null, `${source}/${target}/${owned}`);
			else if ([...assignments][0] === -1) assert.equal(aligned?.has("introduced"), false, `${source}/${target}/${owned}`);
			else assert.equal(aligned?.get("introduced"), 1, `${source}/${target}/${owned}`);
			}
});

test("binary-ish text, inconsistent provenance and oversized alignment fail closed", () => {
	assert.equal(alignProvenance({ text: "a\u0000", owners: [null, null] }, "a\u0000"), null);
	assert.equal(alignProvenance({ text: "a", owners: [] }, "a"), null);
	const text = "line\n".repeat(2000);
	assert.equal(alignProvenance({ text, owners: Array<null>(text.length).fill(null) }, text), null);
});
