import { diffRuns } from "../run-diff.ts";
import { alignEquivalent } from "./align.ts";
import type { Trace } from "../../types.ts";

export type EquivalenceLabel = "equivalent" | "divergent";

export interface EquivalencePair {
	slug: string;
	label: EquivalenceLabel;
	why: string;
	category: string;
	left: Trace;
	right: Trace;
}

export interface PairEvaluation {
	slug: string;
	label: EquivalenceLabel;
	judged: EquivalenceLabel | "incomplete";
	baseline: EquivalenceLabel;
	why: string;
	category: string;
	incompleteReasons: string[];
}

export interface EquivalenceEvaluation {
	total: number;
	equivalentLabeled: number;
	divergentLabeled: number;
	falseMatches: number;
	missedMatches: number;
	falseMatchRate: number;
	missedMatchRate: number;
	incomplete: number;
	baseline: {
		falseMatches: number;
		missedMatches: number;
		falseMatchRate: number;
		missedMatchRate: number;
	};
	perPair: PairEvaluation[];
}

/**
 * Compare labeled fixture pairs. Incomplete equivalence comparisons are
 * reported separately and excluded from false/missed counts. Rates retain the
 * full labeled-class denominator: divergent labels for false matches and
 * equivalent labels for misses.
 *
 * Baseline uses the unmodified linear diffRuns alignment with no equivalence
 * normalization. It judges a pair equivalent exactly when there is no
 * non-cosmetic divergence block; cosmetic-only differences count as equal.
 */
export function evaluate(pairs: readonly EquivalencePair[]): EquivalenceEvaluation {
	let equivalentLabeled = 0;
	let divergentLabeled = 0;
	let falseMatches = 0;
	let missedMatches = 0;
	let baselineFalseMatches = 0;
	let baselineMissedMatches = 0;
	let incomplete = 0;
	const perPair = pairs.map((pair): PairEvaluation => {
		if (pair.label === "equivalent") equivalentLabeled++;
		else divergentLabeled++;
		const result = alignEquivalent(pair.left, pair.right);
		const judged = result.incomplete ? "incomplete" : result.equivalent ? "equivalent" : "divergent";
		if (judged === "incomplete") incomplete++;
		else if (pair.label === "divergent" && judged === "equivalent") falseMatches++;
		else if (pair.label === "equivalent" && judged === "divergent") missedMatches++;

		const baselineDiff = diffRuns(pair.left, pair.right);
		const baseline: EquivalenceLabel = baselineDiff.blocks.some((block) => !block.cosmetic) ? "divergent" : "equivalent";
		if (pair.label === "divergent" && baseline === "equivalent") baselineFalseMatches++;
		else if (pair.label === "equivalent" && baseline === "divergent") baselineMissedMatches++;
		return {
			slug: pair.slug, label: pair.label, judged, baseline,
			why: pair.why, category: pair.category,
			incompleteReasons: result.incompleteReasons,
		};
	});
	return {
		total: pairs.length,
		equivalentLabeled,
		divergentLabeled,
		falseMatches,
		missedMatches,
		falseMatchRate: divergentLabeled === 0 ? 0 : falseMatches / divergentLabeled,
		missedMatchRate: equivalentLabeled === 0 ? 0 : missedMatches / equivalentLabeled,
		incomplete,
		baseline: {
			falseMatches: baselineFalseMatches,
			missedMatches: baselineMissedMatches,
			falseMatchRate: divergentLabeled === 0 ? 0 : baselineFalseMatches / divergentLabeled,
			missedMatchRate: equivalentLabeled === 0 ? 0 : baselineMissedMatches / equivalentLabeled,
		},
		perPair,
	};
}
