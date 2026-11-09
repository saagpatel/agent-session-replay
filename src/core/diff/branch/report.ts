import type { ArtifactCheck } from "./artifact-check.ts";
import type { BranchGraph, BranchNode } from "./types.ts";

export interface ReportStep { id: string; nodes: BranchNode[]; source: "artifact" | "structure"; reason: string }
export interface BranchReport {
	claim: ArtifactCheck["claim"];
	retained: ReportStep[];
	abandoned: Array<{ branchId: string; kind: string; fork: string | null; rejoin: string | null; reason: string; steps: ReportStep[] }>;
	unknown: ReportStep[];
	claimedButUnchanged: string[];
}

export function branchReport(graph: BranchGraph, check: ArtifactCheck): BranchReport {
	const result: BranchReport = { claim: check.claim, retained: [], abandoned: [], unknown: [], claimedButUnchanged: check.claimedButUnchanged };
	const ids = [...new Set(graph.nodes.map((node) => node.stepId))];
	for (const id of ids) {
		const nodes = graph.nodes.filter((node) => node.stepId === id);
		const entries = check.steps.filter((entry) => entry.node.stepId === id);
		const statuses = new Set(entries.map((entry) => entry.status));
		const item: ReportStep = { id, nodes, source: entries.every((entry) => entry.source === "artifact") ? "artifact" : "structure", reason: [...new Set(entries.map((entry) => entry.reason))].join(" ") };
		if (statuses.size === 1 && statuses.has("retained")) result.retained.push(item);
		else if (statuses.size === 1 && statuses.has("abandoned")) {
			const branch = graph.branches.find((b) => b.id === nodes[0]!.branchId)!;
			let group = result.abandoned.find((b) => b.branchId === branch.id);
			if (!group) {
				group = { branchId: branch.id, kind: branch.kind, fork: branch.forkAfterStepId, rejoin: branch.rejoinAtStepId, reason: branch.reasons.join(" "), steps: [] };
				result.abandoned.push(group);
			}
			group.steps.push(item);
		} else {
			if (statuses.size > 1) item.reason = `Mixed operation statuses. ${item.reason}`;
			result.unknown.push(item);
		}
	}
	return result;
}

export function renderBranchReport(report: BranchReport, options: { width?: number; dense?: boolean } = {}): string {
	const width = Math.max(20, options.width ?? 119);
	const lines: string[] = [];
	const add = (text: string) => {
		while (text.length > width) {
			let at = text.lastIndexOf(" ", width);
			if (at < 1) at = width;
			lines.push(text.slice(0, at));
			text = text.slice(at).trimStart();
		}
		lines.push(text);
	};
	add(`Commit link: ${report.claim.status}${report.claim.sha ? ` ${report.claim.sha}` : ""}`);
	for (const file of report.claimedButUnchanged) add(`claimed-but-unchanged: ${file}`);
	add("Retained");
	for (const step of report.retained) add(`  ${step.id} · ${step.nodes.map((node) => `${node.action} ${node.target ?? ""}`).join(", ")} · ${step.source} · commit ${report.claim.status}`);
	add("Attempted and dropped");
	for (const branch of report.abandoned) {
		const ids = branch.steps.map((step) => step.id).join(", ");
		if (options.dense && report.abandoned.length > 6) {
			const reason = branch.kind === "backtrack" ? "restored" : branch.kind === "superseded" ? "replaced" : "retry";
			const target = branch.steps[0]?.nodes[0]?.target;
			add(`  ${branch.kind} · ${branch.steps.length} steps${target ? ` to ${target}` : ""} · fork ${branch.fork ?? "start"} · ${reason} at ${branch.rejoin ?? "unknown"} · ${ids}`);
		} else {
			add(`  ${branch.kind} · fork ${branch.fork ?? "start"} · rejoin ${branch.rejoin ?? "unknown"} · ${branch.steps.length} steps · ${branch.reason}`);
			for (const step of branch.steps) add(`    ${step.id} · ${step.nodes.map((node) => `${node.action} ${node.target ?? ""}`).join(", ")} · ${step.source}`);
		}
	}
	add("Unknown");
	for (const step of report.unknown) add(`  ${step.id} · ${step.reason}`);
	return lines.join("\n");
}
