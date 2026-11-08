/**
 * Divergence ranker: find every fork in an alignment and decide which one
 * mattered.
 *
 * The first difference between two runs is usually cosmetic (one agent read a
 * README the other skipped, then both carried on identically). The ranker
 * instead scores each fork on what it changed: consequential verbs (edits,
 * tests, commands) over reads and searches, a failure on only one side, files
 * only one run ever touched, whether the runs re-converge afterwards, and, when
 * the two runs ended differently, how early the fork came, since everything
 * after the first consequential fork is downstream of it.
 */

import {
	ACTION_WEIGHT,
	isFailure,
	type DiffRow,
	type DiffStep,
	type DivergenceBlock,
	type RunSide,
	type RunVerdict,
} from "./types.ts";

const WEIGHT = ACTION_WEIGHT;
/** Matching rows after a fork that count as the runs lining back up. */
const RECONVERGE = 2;
const COSMETIC_FACTOR = 0.2;

const isDifferent = (r: DiffRow): boolean =>
	r.relation !== "same" || r.statusDiffers;

const failed = (s: DiffStep | null): boolean =>
	s !== null && isFailure(s.status);

/** Files a run edits or creates anywhere in its sequence. */
function touchedFiles(steps: DiffStep[]): Set<string> {
	const out = new Set<string>();
	for (const s of steps)
		if ((s.action === "edit" || s.action === "write") && s.target)
			out.add(s.target);
	return out;
}

/** Signatures of every step that failed somewhere in a run. */
function failingSignatures(steps: DiffStep[]): Set<string> {
	return new Set(steps.filter((s) => isFailure(s.status)).map((s) => s.signature));
}

/** Group consecutive differing rows into candidate forks. */
function spans(rows: DiffRow[]): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let start = -1;
	rows.forEach((r, i) => {
		if (isDifferent(r)) {
			if (start < 0) start = i;
		} else if (start >= 0) {
			out.push([start, i - 1]);
			start = -1;
		}
	});
	if (start >= 0) out.push([start, rows.length - 1]);
	return out;
}

function rowWeight(r: DiffRow): number {
	return Math.max(
		r.left ? WEIGHT[r.left.action] : 0,
		r.right ? WEIGHT[r.right.action] : 0,
	);
}

/** The earliest of the most consequential rows in a fork: its likely cause. */
function pivot(slice: DiffRow[]): number {
	let best = slice[0] as DiffRow;
	for (const r of slice) if (rowWeight(r) > rowWeight(best)) best = r;
	return best.row;
}

export function rankDivergences(
	rows: DiffRow[],
	left: RunSide,
	right: RunSide,
): DivergenceBlock[] {
	const leftFailSigs = failingSignatures(left.steps);
	const rightFailSigs = failingSignatures(right.steps);
	const leftFiles = touchedFiles(left.steps);
	const rightFiles = touchedFiles(right.steps);
	const outcomeDiffers = left.verdict !== right.verdict;
	const total = Math.max(1, rows.length);

	const blocks = spans(rows).map(([startRow, endRow]): DivergenceBlock => {
		const slice = rows.slice(startRow, endRow + 1);
		const reasons: Array<[number, string]> = [];
		let score = 0;

		// 1. What kind of work differs.
		const weights: number[] = [];
		for (const r of slice) {
			if (r.relation === "same") {
				weights.push(WEIGHT[(r.left as DiffStep).action]);
				continue;
			}
			if (r.left) weights.push(WEIGHT[r.left.action]);
			if (r.right) weights.push(WEIGHT[r.right.action]);
		}
		const maxW = Math.max(0, ...weights);
		const sumW = weights.reduce((a, b) => a + b, 0);
		score += maxW * 2 + Math.min(sumW, 6) * 0.25;
		if (maxW >= 3) reasons.push([maxW, "changes edits or test runs"]);
		else if (maxW >= 2) reasons.push([maxW, "changes commands run"]);

		// 2. A failure only one run ever hits. Both runs tripping over the same
		// failing suite at different times is not a fork. A failed edit, test or
		// command is a real fork; a failed read or search only nudges the score.
		const exclusiveFails = slice.flatMap((r) => [
			...(failed(r.left) && !rightFailSigs.has((r.left as DiffStep).signature) ? [r.left as DiffStep] : []),
			...(failed(r.right) && !leftFailSigs.has((r.right as DiffStep).signature) ? [r.right as DiffStep] : []),
		]);
		const failW = Math.max(0, ...exclusiveFails.map((x) => WEIGHT[x.action]));
		const flip = failW > 1;
		if (flip) {
			score += 4;
			reasons.push([4, "hits an error the other run never does"]);
		} else if (exclusiveFails.length > 0) {
			score += 1;
		}

		// 3. Files only one run ever touches.
		const exclusive = slice.some(
			(r) =>
				(r.left &&
					(r.left.action === "edit" || r.left.action === "write") &&
					r.left.target &&
					!rightFiles.has(r.left.target)) ||
				(r.right &&
					(r.right.action === "edit" || r.right.action === "write") &&
					r.right.target &&
					!leftFiles.has(r.right.target)),
		);
		if (exclusive) {
			score += 3;
			reasons.push([3, "touches a file the other run never edits"]);
		}

		// 4. Do the runs re-converge afterwards? Lining back up for RECONVERGE
		// matching steps counts; a fork that runs to the end never re-converges.
		let matched = 0;
		for (let i = endRow + 1; i < rows.length && matched < RECONVERGE; i++) {
			if (isDifferent(rows[i] as DiffRow)) break;
			matched++;
		}
		const reachedEnd = endRow + 1 + matched >= rows.length && matched > 0;
		const persistence = reachedEnd ? 0 : 1 - matched / RECONVERGE;
		score += 3 * persistence;
		if (persistence >= 0.5) reasons.push([2.5, "the runs do not re-converge"]);

		// Reads, searches and plan updates change nothing on their own; if they led
		// somewhere different, the later edit or test fork is what gets flagged.
		const cosmetic = maxW <= 1 && !flip && !exclusive;
		if (cosmetic) score *= COSMETIC_FACTOR;

		// 5. When outcomes differ, the earliest consequential fork is the likely cause.
		if (outcomeDiffers && !cosmetic) {
			const early = 4 * (1 - startRow / total);
			score += early;
			reasons.push([early, "comes before the different outcomes"]);
		}

		return {
			startRow,
			endRow,
			pivotRow: pivot(slice),
			score: Math.round(score * 100) / 100,
			cosmetic,
			reasons: reasons.sort((a, b) => b[0] - a[0]).map(([, r]) => r),
		};
	});

	// Consequential forks first, highest score first (earlier wins a tie). When
	// every fork is cosmetic, the earliest one leads: nothing outranks it.
	return blocks.sort((a, b) => {
		if (a.cosmetic !== b.cosmetic) return a.cosmetic ? 1 : -1;
		if (a.cosmetic) return a.startRow - b.startRow;
		return b.score - a.score || a.startRow - b.startRow;
	});
}

// ---- explanation ---------------------------------------------------------

function code(t: string | null): string {
	return t ? `\`${t}\`` : "";
}

/** Past-tense phrase for one step: "edited `src/a.ts`", "ran `pnpm test`, which failed". */
export function describeStep(s: DiffStep): string {
	const t = code(s.target);
	let phrase: string;
	switch (s.action) {
		case "read":
			phrase = `read ${t}`;
			break;
		case "search":
			phrase = t ? `searched with ${t}` : "searched the code";
			break;
		case "edit":
			phrase = `edited ${t}`;
			break;
		case "write":
			phrase = `created ${t}`;
			break;
		case "test":
		case "run":
			phrase = `ran ${t}`;
			break;
		case "plan":
			phrase = "updated its plan";
			break;
		case "delegate":
			phrase = `delegated to a ${t} subagent`;
			break;
		case "web":
			phrase = "looked something up on the web";
			break;
		case "compaction":
			phrase = "compacted its context";
			break;
		case "blocked":
			phrase = `was blocked (${s.target ?? "guard"})`;
			break;
		default:
			phrase = `called ${t}`;
	}
	phrase = phrase.trim();
	if (s.status === "unknown")
		return s.action === "test" || s.action === "run" ? `${phrase}, with no clear result` : phrase;
	if (isFailure(s.status)) return `${phrase}, which failed`;
	if (s.action === "test") return `${phrase}, which passed`;
	return phrase;
}

const VERDICT_PHRASE: Record<RunVerdict, string> = {
	passed: "with passing tests",
	failed: "with failing tests",
	unclear: "with an unclear test result",
	completed: "reporting the task complete",
	unfinished: "without finishing",
};

export function explainDivergence(
	block: DivergenceBlock | null,
	rows: DiffRow[],
	left: RunSide,
	right: RunSide,
): string {
	if (!block) {
		return `${left.label} and ${right.label} took the same ${rows.length} steps in the same order, so there is no divergence to flag.`;
	}
	const r = rows[block.pivotRow] as DiffRow;
	const at = `At row ${r.row + 1}`;
	let first: string;
	if (r.left && r.right && r.relation === "same") {
		const who = isFailure(r.left.status) ? left.label : right.label;
		const shared = describeStep({ ...r.left, status: "ok" }).replace(
			/, which passed$/,
			"",
		);
		first = `${at} both runs ${shared}, but it failed only for ${who}.`;
	} else if (r.left && r.right) {
		first = `${at} ${left.label} ${describeStep(r.left)}, while ${right.label} ${describeStep(r.right)}.`;
	} else {
		const [doer, other, s] = r.left
			? [left.label, right.label, r.left]
			: [right.label, left.label, r.right as DiffStep];
		first = `${at} ${doer} ${describeStep(s)}, a step ${other} never took here.`;
	}

	let second: string;
	if (block.cosmetic && left.verdict !== right.verdict) {
		second = `The runs differ only in reads, searches and lookups, so these steps do not explain why ${left.label} ended ${VERDICT_PHRASE[left.verdict]} while ${right.label} ended ${VERDICT_PHRASE[right.verdict]}.`;
	} else if (left.verdict !== right.verdict) {
		const opener = block.reasons.includes("the runs do not re-converge")
			? "The runs never line back up after this, and"
			: "After this fork,";
		second = `${opener} ${left.label} ended ${VERDICT_PHRASE[left.verdict]} while ${right.label} ended ${VERDICT_PHRASE[right.verdict]}.`;
	} else if (block.cosmetic) {
		second = `Every difference between the runs is a read, search, lookup or plan update, and both ended ${VERDICT_PHRASE[left.verdict]}, so they took effectively the same path.`;
	} else {
		second = `Both runs still ended ${VERDICT_PHRASE[left.verdict]}, so this is the biggest change in approach rather than an outcome change.`;
	}
	return `${first} ${second}`;
}
