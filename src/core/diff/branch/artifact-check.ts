import { fixtureRepoCommitShas, type FixtureRepoCommit } from "./git-sha.ts";
import { alignProvenance } from "./provenance-align.ts";
import type { BranchGraph, Lineage, NodeRef } from "./types.ts";

export type ArtifactStatus = Lineage | "after-claim";
export interface ArtifactCheck {
	claim: { status: "resolved" | "not-found" | "ambiguous" | "no-claim"; sha: string | null };
	effects: Array<{ node: NodeRef; file: string; status: ArtifactStatus; reason: string }>;
	steps: Array<{ node: NodeRef; status: ArtifactStatus; source: "artifact" | "structure"; reason: string }>;
	claimedButUnchanged: string[];
}

const key = (node: NodeRef) => JSON.stringify([node.stepId, node.part]);

/** Compare recorded payloads with a uniquely resolved fixture commit. */
export function checkArtifacts(graph: BranchGraph, repo: { commits: FixtureRepoCommit[] }): ArtifactCheck {
	const shas = fixtureRepoCommitShas(repo.commits);
	const short = graph.claim.commitShort?.toLowerCase() ?? null;
	const matches = short ? shas.map((sha, index) => ({ sha, index })).filter(({ sha }) => sha.startsWith(short)) : [];
	const status = !short ? "no-claim" : matches.length === 0 ? "not-found" : matches.length > 1 ? "ambiguous" : "resolved";
	const match = status === "resolved" ? matches[0] : undefined;
	const commit = match === undefined ? undefined : repo.commits[match.index];
	const parent = match === undefined || match.index === 0 ? undefined : repo.commits[match.index - 1];
	const boundary = graph.nodes.find((node) => node.stepId === graph.claim.stepId && node.part === graph.claim.part);
	const indices = new Map(graph.nodes.map((node) => [key(node), node.index]));
	const afterClaim = (node: NodeRef) => boundary !== undefined && (indices.get(key(node)) ?? -1) > boundary.index;
	const aligned = new Map<string, Map<string, number> | null>();
	const effects: ArtifactCheck["effects"] = graph.editEffects.map((effect) => {
		const result = (status: ArtifactStatus, reason: string) => ({ node: effect.node, file: effect.file, status, reason });
		if (afterClaim(effect.node)) return result("after-claim", "Edit made after the claimed commit.");
		if (!commit) return result("unknown", `Commit claim ${status}.`);
		const content = commit.files[effect.file];
		if (content === undefined) return result("unknown", "File is absent from the commit.");
		const file = graph.claim.tree?.[effect.file];
		if (!boundary || !file) return result("unknown", "File lineage at the claimed commit is unknown or absent.");
		const total = effect.introducedSpans.reduce((sum, span) => sum + span.text.length, 0);
		if (!effect.payload || total === 0) return result("unknown", "Edit has no proven introduced spans.");
		if (!aligned.has(effect.file)) aligned.set(effect.file, alignProvenance(file, content));
		const origins = aligned.get(effect.file);
		if (!origins) return result("unknown", "Committed content cannot be aligned within the text comparison limits.");
		const retained = origins.get(key(effect.node)) ?? 0;
		if (retained === 0) return result("abandoned", "No introduced spans align with the commit.");
		if (retained < total) return result("partial", "Only part of the introduced spans aligns with the commit.");
		return result("retained", "All introduced spans align with the commit.");
	});
	const steps: ArtifactCheck["steps"] = graph.nodes.map((node) => {
		if (afterClaim(node)) return { node, status: "after-claim", source: "structure", reason: "Operation made after the claimed commit." };
		const own = effects.filter((effect) => key(effect.node) === key(node));
		const branch = graph.branches.find((item) => item.id === node.branchId)!;
		if (own.length) {
			const statuses = new Set(own.map((effect) => effect.status));
			const status: ArtifactStatus = statuses.has("unknown") ? "unknown" : statuses.size === 1 ? own[0]!.status : "partial";
			return { node, status, source: "artifact", reason: own.map((effect) => effect.reason).join(" ") };
		}
		let fallback: Lineage = branch.structuralStatus;
		if ((node.action === "edit" || node.action === "write") && fallback === "retained") fallback = "unknown";
		return { node, status: fallback, source: "structure", reason: node.action === "edit" || node.action === "write" ? "Edit payload is unknown." : branch.reasons.join(" ") };
	});
	const claimedButUnchanged = commit && parent ? graph.claim.files.filter((file) => Object.hasOwn(commit.files, file) && Object.hasOwn(parent.files, file) && commit.files[file] === parent.files[file]) : [];
	return { claim: { status, sha: match?.sha ?? null }, effects, steps, claimedButUnchanged };
}
