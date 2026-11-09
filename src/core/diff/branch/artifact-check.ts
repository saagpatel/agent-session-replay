import { fixtureRepoCommitShas, type FixtureRepoCommit } from "./git-sha.ts";
import type { BranchGraph, Lineage, NodeRef } from "./types.ts";

export type ArtifactStatus = "retained" | "abandoned" | "unknown";
export interface ArtifactCheck {
	claim: { status: "resolved" | "not-found" | "ambiguous" | "no-claim"; sha: string | null };
	effects: Array<{ node: NodeRef; file: string; status: ArtifactStatus; reason: string }>;
	steps: Array<{ node: NodeRef; status: Lineage; source: "artifact" | "structure"; reason: string }>;
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
	const effects: ArtifactCheck["effects"] = graph.editEffects.map((effect) => {
		const result = (status: ArtifactStatus, reason: string) => ({ node: effect.node, file: effect.file, status, reason });
		if (!commit) return result("unknown", `Commit claim ${status}.`);
		const content = commit.files[effect.file];
		if (content === undefined) return result("unknown", "File is absent from the commit.");
		if (effect.lineage === "unknown") return result("unknown", "Edit application or lineage is unknown.");
		if (!effect.payload || (!effect.payload.inserted.length && !effect.payload.removed.length)) return result("unknown", "Edit payload is unknown.");
		const inserted = effect.payload.inserted;
		if (inserted.length && inserted.every((text) => !content.includes(text))) return result("abandoned", "Inserted text is absent from the commit.");
		if (inserted.some((text) => !content.includes(text)) || effect.payload.removed.some((text) => content.includes(text))) return result("unknown", "Payload is only partly present or removed text remains.");
		// Matching content cannot identify its origin when a later operation replaced it.
		if (effect.lineage === "abandoned" || effect.lineage === "partial") return result("unknown", "Matching text has conflicting structural lineage.");
		return result("retained", "Recorded payload matches the commit.");
	});
	const steps: ArtifactCheck["steps"] = graph.nodes.map((node) => {
		const own = effects.filter((effect) => key(effect.node) === key(node));
		const branch = graph.branches.find((item) => item.id === node.branchId)!;
		if (own.length && own.every((effect) => effect.status === "retained")) return { node, status: "retained", source: "artifact", reason: "All edit payloads match the commit." };
		if (own.length && own.every((effect) => effect.status === "abandoned")) return { node, status: "abandoned", source: "artifact", reason: "Inserted text is absent from the commit." };
		const structural = graph.editEffects.filter((effect) => key(effect.node) === key(node));
		let fallback: Lineage = structural.length === 1 ? structural[0]!.lineage : branch.structuralStatus;
		if ((own.length || node.action === "edit" || node.action === "write") && fallback === "retained") fallback = "unknown";
		return { node, status: fallback, source: "structure", reason: own.length ? own.map((effect) => effect.reason).join(" ") : node.action === "edit" || node.action === "write" ? "Edit payload is unknown." : branch.reasons.join(" ") };
	});
	const claimedButUnchanged = commit && parent ? graph.claim.files.filter((file) => Object.hasOwn(commit.files, file) && Object.hasOwn(parent.files, file) && commit.files[file] === parent.files[file]) : [];
	return { claim: { status, sha: match?.sha ?? null }, effects, steps, claimedButUnchanged };
}
