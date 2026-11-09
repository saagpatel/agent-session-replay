import type { DiffAction, DiffRow, DiffStatus, DiffStep } from "../types.ts";

/** Equivalence rewrite rules that retain their original members. */
export type RuleId = "read-coalesce" | "search-dedupe" | "edit-batch";

/** Inclusive one-based bounds for a proven line range. */
export interface ReadRange {
	start: number;
	end: number;
}

/** Canonical event used only by Work Equivalence alignment. */
export interface CanonicalEvent {
	id: string;
	action: DiffAction;
	target: string | null;
	/** null means whole-file-or-unknown, not an inferred bounded range. */
	range?: ReadRange | null;
	key: string;
	rule: RuleId | null;
	/** Positions in the input array, independent of DiffStep.index or stepId. */
	members: number[];
	memberStepIds: string[];
	status: DiffStatus;
	signature: string;
}

/** Normalized event stream and evidence completeness for one trace. */
export interface EquivalentNormalization {
	steps: DiffStep[];
	events: CanonicalEvent[];
	incomplete: boolean;
	incompleteReasons: string[];
}

/** A paired or one-sided canonical event row. */
export interface EquivalentRow extends Omit<DiffRow, "left" | "right"> {
	left: CanonicalEvent | null;
	right: CanonicalEvent | null;
}

/** Comparison result with local completeness and truncation evidence. */
export interface EquivalentAlignment {
	left: EquivalentNormalization;
	right: EquivalentNormalization;
	rows: EquivalentRow[];
	divergences: EquivalentRow[];
	equivalent: boolean;
	incomplete: boolean;
	incompleteReasons: string[];
	truncated: {
		left: number;
		right: number;
	};
}
