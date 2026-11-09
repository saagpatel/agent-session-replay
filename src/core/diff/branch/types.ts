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
	lineage: Lineage;
	/** Only this file at run end; an absent key means deletion. */
	endState: FileSnapshot;
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
		/** Candidate paths touched by the claim step; commit membership is not proven. */
		files: string[];
	};
}
