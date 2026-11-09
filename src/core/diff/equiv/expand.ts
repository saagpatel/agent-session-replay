import type { DiffStep } from "../types.ts";
import type { CanonicalEvent, EquivalentNormalization } from "./types.ts";

/** Preserve object identity as well as source ids, including repeated stepIds. */
export function expand(event: CanonicalEvent, steps: DiffStep[]): DiffStep[] {
	return [...event.members].sort((a, b) => a - b).map((index) => {
		const step = steps[index];
		if (!step) throw new RangeError(`Missing original member ${index}`);
		return step;
	});
}

/** Interleaved read groups must be expanded by original position, not event order. */
export function expandAll(normalized: EquivalentNormalization): DiffStep[] {
	return normalized.events.flatMap((event) => event.members)
		.sort((a, b) => a - b).map((index) => {
			const step = normalized.steps[index];
			if (!step) throw new RangeError(`Missing original member ${index}`);
			return step;
		});
}
