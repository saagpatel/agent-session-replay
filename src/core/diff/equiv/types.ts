import type { DiffAction, DiffRow, DiffStatus, DiffStep } from "../types.ts";

export type RuleId = "read-coalesce" | "search-dedupe" | "edit-batch";
export interface ReadRange {
	/** Inclusive, one-based line numbers. */
	start: number;
	end: number;
}
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
export interface EquivalentNormalization {
	steps: DiffStep[];
	events: CanonicalEvent[];
	incomplete: boolean;
	incompleteReasons: string[];
}
export interface EquivalentRow extends Omit<DiffRow, "left" | "right"> {
	left: CanonicalEvent | null;
	right: CanonicalEvent | null;
}
export interface EquivalentAlignment {
	left: EquivalentNormalization;
	right: EquivalentNormalization;
	rows: EquivalentRow[];
	divergences: EquivalentRow[];
	equivalent: boolean;
	incomplete: boolean;
	incompleteReasons: string[];
	truncated: { left: number; right: number };
}
