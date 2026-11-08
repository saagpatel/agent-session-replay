/**
 * View model for the Run Diff grid: fold long stretches of identical rows the
 * way a code diff hides unchanged context.
 */

import type { DiffRow } from "./types.ts";

/** Identical rows kept visible on each side of a difference before folding. */
const CONTEXT = 2;
/** Runs of identical rows at least this long get folded. */
const FOLD_MIN = 6;

export type DiffViewItem =
	| { type: "row"; row: DiffRow }
	| { type: "fold"; from: number; to: number };

const isDifferent = (r: DiffRow): boolean =>
	r.relation !== "same" || r.statusDiffers;

/** Fold long stretches of identical rows, keeping CONTEXT rows around each change. */
export function foldRows(
	rows: DiffRow[],
	expanded: ReadonlySet<number>,
): DiffViewItem[] {
	if (!rows.some(isDifferent)) return rows.map((row) => ({ type: "row", row }));
	const keep = new Array<boolean>(rows.length).fill(false);
	rows.forEach((r, i) => {
		if (!isDifferent(r)) return;
		for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++)
			keep[k] = true;
	});
	const items: DiffViewItem[] = [];
	let i = 0;
	while (i < rows.length) {
		if (keep[i]) {
			items.push({ type: "row", row: rows[i] as DiffRow });
			i++;
			continue;
		}
		let j = i;
		while (j < rows.length && !keep[j]) j++;
		if (j - i >= FOLD_MIN && !expanded.has(i)) {
			items.push({ type: "fold", from: i, to: j - 1 });
		} else {
			for (let k = i; k < j; k++) items.push({ type: "row", row: rows[k] as DiffRow });
		}
		i = j;
	}
	return items;
}
