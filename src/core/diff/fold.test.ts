import assert from "node:assert/strict";
import { test } from "node:test";

import { foldRows } from "./fold.ts";
import type { DiffRow, DiffStep } from "./types.ts";

function row(i: number, relation: DiffRow["relation"]): DiffRow {
	const s: DiffStep = {
		index: i,
		stepId: `s${i}`,
		action: "read",
		target: `f${i}`,
		label: `read f${i}`,
		status: "ok",
		startedAt: "2026-10-01T00:00:00.000Z",
		signature: `read:f${i}`,
	};
	return {
		row: i,
		left: relation === "right-only" ? null : s,
		right: relation === "left-only" ? null : s,
		relation,
		statusDiffers: false,
	};
}

test("long identical stretches fold, keeping two rows of context around a change", () => {
	const rows = Array.from({ length: 20 }, (_, i) => row(i, i === 10 ? "changed" : "same"));
	const items = foldRows(rows, new Set());
	assert.deepEqual(
		items.map((it) => (it.type === "fold" ? `fold ${it.from}-${it.to}` : it.row.row)),
		["fold 0-7", 8, 9, 10, 11, 12, "fold 13-19"],
	);
});

test("an expanded fold shows its rows; short stretches never fold", () => {
	const rows = Array.from({ length: 20 }, (_, i) => row(i, i === 10 ? "changed" : "same"));
	const items = foldRows(rows, new Set([0]));
	assert.equal(items[0]?.type, "row");
	assert.equal(items.at(-1)?.type, "fold");
	const short = Array.from({ length: 6 }, (_, i) => row(i, i === 5 ? "left-only" : "same"));
	assert.ok(foldRows(short, new Set()).every((it) => it.type === "row"));
});

test("identical runs are shown in full", () => {
	const rows = Array.from({ length: 30 }, (_, i) => row(i, "same"));
	assert.equal(foldRows(rows, new Set()).length, 30);
});
