/**
 * Global sequence alignment (Needleman-Wunsch) over normalized steps.
 *
 * Scoring keeps unrelated work apart: an exact signature match scores high (and
 * higher for consequential verbs, so two test runs pair before two reads), the
 * same verb on a different target (editing a different file) pairs up as a
 * `changed` row, and different verbs never pair: they become a one-sided row on
 * each lane, the way a code diff shows a deletion next to an insertion.
 */

import {
	ACTION_WEIGHT,
	type DiffRow,
	type DiffStep,
	isFailure,
} from "./types.ts";

/** An exact match scores MATCH plus the verb's weight, so tests outrank reads. */
const MATCH = 2;
const SAME_ACTION = 1;
const MISMATCH = -3; // cheaper to open two gaps than to pair different verbs
const GAP = -1;

/** Traceback is a byte per cell, so this caps memory near 16 MB. */
export const MAX_CELLS = 16_000_000;

const DIAG = 1;
const UP = 2; // consume a left step only
const LEFT = 3; // consume a right step only

function pairScore(a: DiffStep, b: DiffStep): number {
	if (a.signature === b.signature) return MATCH + ACTION_WEIGHT[a.action];
	if (a.action === b.action) return SAME_ACTION;
	return MISMATCH;
}

export interface Alignment {
	rows: DiffRow[];
	truncated: { left: number; right: number };
}

/**
 * Trim the sequences so the DP table fits under `cap` cells. The long run is
 * trimmed first; the short one only when trimming the long one alone cannot fit.
 */
export function fit<T>(left: T[], right: T[], cap = MAX_CELLS): [T[], T[]] {
	const cells = (left.length + 1) * (right.length + 1);
	if (cells <= cap) return [left, right];
	const leftLonger = left.length >= right.length;
	const short = leftLonger ? right : left;
	const long = leftLonger ? left : right;
	let keepShort = short.length;
	let keepLong = Math.floor(cap / (keepShort + 1)) - 1;
	if (keepLong < keepShort) {
		// Both must shrink: a square table of side sqrt(cap).
		keepShort = Math.max(0, Math.floor(Math.sqrt(cap)) - 1);
		keepLong = keepShort;
	}
	const a = long.slice(0, Math.max(0, keepLong));
	const b = short.slice(0, keepShort);
	return leftLonger ? [a, b] : [b, a];
}

export function alignSteps(
	leftAll: DiffStep[],
	rightAll: DiffStep[],
): Alignment {
	const [left, right] = fit(leftAll, rightAll);
	const n = left.length;
	const m = right.length;
	const w = m + 1;
	const trace = new Uint8Array((n + 1) * w);
	let prev = new Float64Array(w);
	let cur = new Float64Array(w);
	for (let j = 1; j <= m; j++) {
		prev[j] = j * GAP;
		trace[j] = LEFT;
	}
	for (let i = 1; i <= n; i++) {
		cur[0] = i * GAP;
		trace[i * w] = UP;
		const a = left[i - 1] as DiffStep;
		for (let j = 1; j <= m; j++) {
			const b = right[j - 1] as DiffStep;
			const diag = (prev[j - 1] as number) + pairScore(a, b);
			const up = (prev[j] as number) + GAP;
			const lf = (cur[j - 1] as number) + GAP;
			// Ties prefer pairing; between gaps, tracing back through the right-only
			// row first puts left-only rows ahead of right-only ones (a code diff
			// shows deletions before insertions).
			if (diag >= up && diag >= lf) {
				cur[j] = diag;
				trace[i * w + j] = DIAG;
			} else if (up > lf) {
				cur[j] = up;
				trace[i * w + j] = UP;
			} else {
				cur[j] = lf;
				trace[i * w + j] = LEFT;
			}
		}
		[prev, cur] = [cur, prev];
	}

	const reversed: Array<Omit<DiffRow, "row">> = [];
	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		const dir = trace[i * w + j];
		if (i > 0 && j > 0 && dir === DIAG) {
			const a = left[i - 1] as DiffStep;
			const b = right[j - 1] as DiffStep;
			reversed.push({
				left: a,
				right: b,
				relation: a.signature === b.signature ? "same" : "changed",
				// An unknown result is missing evidence, not a difference.
				statusDiffers:
					a.status !== "unknown" &&
					b.status !== "unknown" &&
					isFailure(a.status) !== isFailure(b.status),
			});
			i--;
			j--;
		} else if (i > 0 && (j === 0 || dir === UP)) {
			reversed.push({
				left: left[i - 1] as DiffStep,
				right: null,
				relation: "left-only",
				statusDiffers: false,
			});
			i--;
		} else {
			reversed.push({
				left: null,
				right: right[j - 1] as DiffStep,
				relation: "right-only",
				statusDiffers: false,
			});
			j--;
		}
	}
	const rows = reversed.reverse().map((r, row) => ({ row, ...r }));
	return {
		rows,
		truncated: {
			left: leftAll.length - n,
			right: rightAll.length - m,
		},
	};
}
