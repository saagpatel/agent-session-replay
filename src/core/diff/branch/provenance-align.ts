import type { ProvenanceFile } from "./types.ts";

// Bound quadratic LCS work in the browser. Exceeding the cap is unknown evidence.
const MAX_CELLS = 4_000_000;
const binary = (text: string) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Count surviving owned characters only on equal, contextually aligned lines.
 * Base characters have no owner and can never prove retention of an edit.
 * Newlines stay in the tokens so a missing final newline is not equal evidence.
 */
export function alignProvenance(file: ProvenanceFile, committed: string): Map<string, number> | null {
	if (binary(file.text) || binary(committed) || file.owners.length !== file.text.length) return null;
	const source = lines(file.text);
	const target = lines(committed);
	const columns = target.length + 1;
	const cells = (source.length + 1) * columns;
	if (cells > MAX_CELLS) return null;
	const lcs = new Uint32Array(cells);
	for (let i = source.length - 1; i >= 0; i--)
		for (let j = target.length - 1; j >= 0; j--)
			lcs[i * columns + j] = source[i] === target[j]
				? 1 + lcs[(i + 1) * columns + j + 1]!
				: Math.max(lcs[(i + 1) * columns + j]!, lcs[i * columns + j + 1]!);
	const retained = new Map<string, number>();
	const best = lcs[0]!;
	let i = 0;
	let j = 0;
	let offset = 0;
	const prefix = new Uint32Array(columns);
	for (let row = 0; row < source.length; row++) {
		const line = source[row]!;
		const end = offset + line.length;
		const owners = new Set(file.owners.slice(offset, end).filter((owner): owner is string => owner !== null));
		if (owners.size) {
			let canBeOmitted = false;
			let assignments = 0;
			for (let split = 0; split < columns; split++) {
				if (prefix[split]! + lcs[(row + 1) * columns + split]! === best)
					canBeOmitted = true;
				if (
					split < target.length && line === target[split] &&
					prefix[split]! + 1 + lcs[(row + 1) * columns + split + 1]! === best
				)
					assignments++;
			}
			// The artifact checker consumes one file-wide map, so ambiguous ownership fails closed for the file.
			if (assignments > 1 || (assignments > 0 && canBeOmitted)) return null;
		}
		let diagonal = prefix[0]!;
		for (let column = 1; column < columns; column++) {
			const above = prefix[column]!;
			prefix[column] = line === target[column - 1]
				? diagonal + 1
				: Math.max(above, prefix[column - 1]!);
			diagonal = above;
		}
		offset = end;
	}
	offset = 0;
	while (i < source.length && j < target.length) {
		const line = source[i]!;
		if (line === target[j]) {
			for (let at = offset; at < offset + line.length; at++) {
				const owner = file.owners[at];
				if (owner) retained.set(owner, (retained.get(owner) ?? 0) + 1);
			}
			offset += line.length;
			i++; j++;
		} else if (lcs[(i + 1) * columns + j]! >= lcs[i * columns + j + 1]!) {
			// Deterministic ties discard the earlier source line.
			offset += line.length;
			i++;
		} else j++;
	}
	return retained;
}
