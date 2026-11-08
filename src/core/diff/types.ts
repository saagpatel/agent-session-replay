/**
 * Run Diff model: two runs of the same task, normalized into comparable steps,
 * aligned like a code diff, with the divergence that mattered ranked first.
 *
 * Pure data, no UI concerns. The core stays zero-dependency like the rest of
 * `src/core/`.
 */

import type { StepStatus } from "../types.ts";

/**
 * Harness-neutral verb for a step. Claude Code's `Read` and a Codex shell
 * `sed -n` on the same file both normalize to `read`, which is what lets two
 * different harnesses line up.
 */
export type DiffAction =
	| "read"
	| "search"
	| "edit"
	| "write"
	| "test"
	| "run"
	| "plan"
	| "delegate"
	| "web"
	| "compaction"
	| "blocked"
	| "other";

/**
 * How consequential each verb is. Shared by the aligner (matching an edit or a
 * test outweighs matching a read) and the ranker (a fork in edits matters more
 * than a fork in reads).
 */
export const ACTION_WEIGHT: Record<DiffAction, number> = {
	edit: 3,
	write: 3,
	test: 3,
	run: 2,
	delegate: 2,
	blocked: 2,
	compaction: 1,
	web: 1,
	other: 1,
	plan: 0.5,
	read: 0.5,
	search: 0.5,
};

export interface DiffStep {
	/** Position in this run's normalized sequence. */
	index: number;
	/** The source `Step.step_id`, so the UI can link back to the raw step. */
	stepId: string;
	action: DiffAction;
	/** Workspace-relative file, command head, query or tool name. */
	target: string | null;
	/** Display-only detail kept out of the signature, e.g. the search tool. */
	note?: string;
	/** Short human label: "edit src/parse.ts", "test pnpm test". */
	label: string;
	status: StepStatus;
	/** Truncated error text when the step failed. */
	error?: string;
	startedAt: string;
	/** Alignment key: action plus normalized target. */
	signature: string;
}

/** How a row of the alignment relates its two sides. */
export type RowRelation = "same" | "changed" | "left-only" | "right-only";

export interface DiffRow {
	/** 0-based row number in the alignment. */
	row: number;
	left: DiffStep | null;
	right: DiffStep | null;
	relation: RowRelation;
	/** Both sides did the same thing but only one of them failed. */
	statusDiffers: boolean;
}

/** A coarse end state for one run, used to tell whether a fork changed the outcome. */
export type RunVerdict = "passed" | "failed" | "completed" | "unfinished";

export interface RunSide {
	label: string;
	harness: string;
	model: string | null;
	steps: DiffStep[];
	verdict: RunVerdict;
	/** Why the verdict was chosen, e.g. "last test `pnpm test` failed". */
	verdictReason: string;
}

/** A maximal span of consecutive non-identical rows: one candidate fork. */
export interface DivergenceBlock {
	startRow: number;
	/** Inclusive. */
	endRow: number;
	/** The earliest most consequential row in the fork: its likely cause. */
	pivotRow: number;
	score: number;
	/** True when the fork only differs in reads, searches, lookups or plan updates. */
	cosmetic: boolean;
	/** Short reasons the ranker used, highest weight first. */
	reasons: string[];
}

export interface RunDiff {
	left: RunSide;
	right: RunSide;
	rows: DiffRow[];
	/** Every candidate fork, highest score first. */
	blocks: DivergenceBlock[];
	/** The fork the ranker flags, or null when the runs are step-identical. */
	flagged: DivergenceBlock | null;
	/** First row that differs at all, even cosmetically. */
	firstDifferenceRow: number | null;
	/** One or two plain sentences explaining the flagged fork. */
	explanation: string;
	/** Steps dropped from the end of each run when the alignment hit its size cap. */
	truncated: { left: number; right: number };
}
