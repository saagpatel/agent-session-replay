import type { DiffAction, DiffStatus } from "../types.ts";

/** Missing keys are absent files; null is explicitly unknown content. */
export type FileSnapshot = Record<string, string | null>;
export type Lineage = "retained" | "partial" | "abandoned" | "unknown";
export interface NodeRef {
	stepId: string;
	/** Zero-based operation ordinal within the raw step. */
	part: number;
}
export interface BranchNode extends NodeRef {
	index: number;
	branchId: string;
	action: DiffAction;
	target: string | null;
	status: DiffStatus;
}
export interface Branch {
	id: string;
	kind: "main" | "retry" | "backtrack" | "superseded";
	parentId: string | null;
	forkAfterStepId: string | null;
	rejoinAtStepId: string | null;
	nodes: NodeRef[];
	structuralStatus: Lineage;
	reasons: string[];
}
export interface IntroducedSpan {
	/** UTF-16 offsets immediately after the edit. */
	start: number;
	end: number;
	text: string;
}
export interface EditEffect {
	node: NodeRef;
	file: string;
	introducedSpans: IntroducedSpan[];
	/** Recorded payload; null means the operation could not be reconstructed. */
	payload: { inserted: string[]; removed: string[] } | null;
	lineage: Lineage;
	/** Only this file at run end; an absent key means deletion. */
	endState: FileSnapshot;
}
/** Character origins at one operation boundary; null origins belong to the base. */
export interface ProvenanceFile {
	text: string;
	/** Each non-null owner is JSON.stringify([stepId, part]). */
	owners: Array<string | null>;
}
export interface BranchGraph {
	nodes: BranchNode[];
	branches: Branch[];
	editEffects: EditEffect[];
	endState: FileSnapshot;
	/** False when an unparsed writer could also have changed unnamed paths. */
	endStateComplete: boolean;
	claim: {
		commitShort: string | null;
		stepId: string | null;
		part: number | null;
		/** Independent tree and provenance snapshot at the claimed commit operation. */
		tree: Record<string, ProvenanceFile | null> | null;
		/** Candidate paths touched by the claim step; commit membership is not proven. */
		files: string[];
	};
}
