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
	const ownedPaths = new Map<string, string[]>();
	for (const [path, file] of Object.entries(graph.claim.tree ?? {})) {
		for (const owner of new Set(file?.owners ?? [])) {
			if (owner === null) continue;
			const paths = ownedPaths.get(owner) ?? [];
			paths.push(path);
			ownedPaths.set(owner, paths);
		}
	}
	const effects: ArtifactCheck["effects"] = graph.editEffects.map((effect) => {
		const result = (status: ArtifactStatus, reason: string) => ({ node: effect.node, file: effect.file, status, reason });
		if (afterClaim(effect.node)) return result("after-claim", "Edit made after the claimed commit.");
		if (effect.file.startsWith("external:")) return result("unknown", "External paths cannot be attributed to repository commits.");
		if (!commit) return result("unknown", `Commit claim ${status}.`);
		if (!boundary || !graph.claim.tree) return result("unknown", "File lineage at the claimed commit is unknown or absent.");
		const total = effect.introducedSpans.reduce((sum, span) => sum + span.text.length, 0);
		if (!effect.payload || total === 0) return result("unknown", "Edit has no proven introduced spans.");
		const owner = key(effect.node);
		// Moves keep owners at their destination even if the original path is recreated.
		const paths = ownedPaths.get(owner) ?? [effect.file];
		let retained = 0;
		for (const path of paths) {
			if (path.startsWith("external:")) return result("unknown", "External paths cannot be attributed to repository commits.");
			const file = graph.claim.tree[path];
			if (!file) return result("unknown", "File lineage at the claimed commit is unknown or absent.");
			const content = commit.files[path];
			if (content === undefined) return result("unknown", "File is absent from the commit.");
			if (!aligned.has(path)) aligned.set(path, alignProvenance(file, content));
			const origins = aligned.get(path);
			if (!origins) return result("unknown", "Committed content has ambiguous alignment or exceeds the text comparison limits.");
			retained += origins.get(owner) ?? 0;
		}
		if (retained < total && Object.values(graph.claim.tree).some((file) => file === null))
			return result("unknown", "Unknown boundary files may contain introduced spans.");
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
