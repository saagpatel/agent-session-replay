import type { ArtifactCheck } from "./artifact-check.ts";
import type { BranchGraph, BranchNode } from "./types.ts";
import type { Trace } from "../../types.ts";

export interface ReportStep { id: string; nodes: BranchNode[]; source: "artifact" | "structure"; reason: string }
export interface BranchReport {
	claim: ArtifactCheck["claim"];
	retained: ReportStep[];
	abandoned: Array<{ branchId: string; kind: string; fork: string | null; rejoin: string | null; reason: string; steps: ReportStep[] }>;
	unknown: ReportStep[];
	control: ReportStep[];
	afterClaim: ReportStep[];
	claimedButUnchanged: string[];
}

export function branchReport(graph: BranchGraph, check: ArtifactCheck, trace: Trace): BranchReport {
	const result: BranchReport = { claim: check.claim, retained: [], abandoned: [], unknown: [], control: [], afterClaim: [], claimedButUnchanged: check.claimedButUnchanged };
	const controls = new Set(trace.steps.filter((step) => step.kind !== "tool_call").map((step) => step.step_id));
	const ids = [...new Set(graph.nodes.map((node) => node.stepId))];
	for (const id of ids) {
		const own = check.steps.filter((entry) => entry.node.stepId === id);
		if (controls.has(id)) {
			result.control.push({ id, nodes: graph.nodes.filter((node) => node.stepId === id), source: "structure", reason: "Control step; not work." });
			continue;
		}
		const later = own.filter((entry) => entry.status === "after-claim");
		if (later.length && later.length !== own.length) {
			result.unknown.push({ id, nodes: graph.nodes.filter((node) => node.stepId === id), source: "structure", reason: "Mixed operation statuses across the claimed commit; some operations were made after the claim." });
			continue;
		}
		if (later.length) result.afterClaim.push({ id, nodes: graph.nodes.filter((node) => later.some((entry) => entry.node.stepId === node.stepId && entry.node.part === node.part)), source: "structure", reason: "Operations made after the claimed commit." });
		const entries = own.filter((entry) => entry.status !== "after-claim");
		if (!entries.length) continue;
		const nodes = graph.nodes.filter((node) => entries.some((entry) => entry.node.stepId === node.stepId && entry.node.part === node.part));
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
	const width = Math.min(119, Math.max(20, options.width ?? 119));
	const lines: string[] = [];
	const clean = (text: string) => text.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ");
	const shortTarget = (target: string | null | undefined, budget = Math.max(8, width - 32)) => {
		if (!target) return "";
		target = clean(target);
		budget = Math.max(1, budget);
		return target.length > budget ? `${target.slice(0, budget - 1)}…` : target;
	};
	const add = (text: string) => {
		text = clean(text);
		lines.push(text.length <= width ? text : `${text.slice(0, width - 1)}…`);
	};
	const stepOrder = [...report.retained, ...report.abandoned.flatMap((branch) => branch.steps), ...report.unknown, ...report.afterClaim, ...report.control]
		.sort((a, b) => Math.min(...a.nodes.map((node) => node.index)) - Math.min(...b.nodes.map((node) => node.index)));
	const numbers = new Map<string, number>();
	for (const step of stepOrder) if (!numbers.has(step.id)) numbers.set(step.id, numbers.size + 1);
	const workOrder = stepOrder.filter((step) => !report.control.includes(step));
	const workNumbers = new Map<string, number>();
	for (const step of workOrder) if (!workNumbers.has(step.id)) workNumbers.set(step.id, workNumbers.size + 1);
	const label = (step: ReportStep) => {
		const node = step.nodes[0];
		const action = node?.action ?? "step";
		const target = shortTarget(node?.target);
		return `#${numbers.get(step.id) ?? "?"} ${action}${target ? ` ${target}` : ""}`;
	};
	const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;
	const droppedCount = report.abandoned.reduce((sum, branch) => sum + branch.steps.length, 0);
	const kindCounts = new Map<string, number>();
	for (const branch of report.abandoned) kindCounts.set(branch.kind, (kindCounts.get(branch.kind) ?? 0) + branch.steps.length);
	const droppedKinds = [...kindCounts].map(([kind, count]) => `${count} ${kind}`).join(", ");
	const commit = report.claim.sha ? report.claim.sha.slice(0, 7) : report.claim.status;
	add(`Retained ${report.retained.length} · Dropped ${droppedCount}${droppedKinds ? ` (${droppedKinds})` : ""} · Unknown ${report.unknown.length} · Control ${report.control.length} · Commit ${commit}${report.claim.sha ? ` ${report.claim.status}` : ""}`);
	add(`Control steps: ${report.control.length} — not work, listed in the JSON report`);
	for (const file of report.claimedButUnchanged) add(`Claimed unchanged ${shortTarget(file)}`);
	add("Retained");
	for (const step of report.retained) add(`  ${label(step)} · ${step.source}`);
	add("Attempted and dropped");
	const dense = options.dense && report.abandoned.length > 6;
	const branchSteps = (branch: BranchReport["abandoned"][number]) => branch.steps.map((step) => numbers.get(step.id)!).filter((number, index, all) => all.indexOf(number) === index).sort((a, b) => a - b);
	const addStepRanges = (steps: number[]) => {
		const ranges: string[] = [];
		for (let i = 0; i < steps.length;) {
			const first = steps[i]!;
			let last = first;
			while (steps[i + 1] === last + 1) last = steps[++i]!;
			ranges.push(first === last ? `#${first}` : `#${first}–#${last}`);
			i++;
		}
		let line = "  ";
		for (const range of ranges) {
			if (line.length > 2 && line.length + range.length + 2 > width) {
				lines.push(line);
				line = "  ";
			}
			line += `${line.length > 2 ? ", " : ""}${range}`;
		}
		if (line.length > 2) lines.push(line);
	};
	const consecutiveSteps = (branch: BranchReport["abandoned"][number]) => {
		const steps = branch.steps.map((step) => workNumbers.get(step.id)!).sort((a, b) => a - b);
		return steps.length > 0 && steps.every((number, offset) => offset === 0 || number === steps[offset - 1]! + 1);
	};
	const rejoinAction = (branch: BranchReport["abandoned"][number]) => {
		const step = stepOrder.find((item) => item.id === branch.rejoin);
		return { step, action: step?.nodes[0]?.action, number: step ? numbers.get(step.id) : undefined };
	};
	const rejoinIsNext = (branch: BranchReport["abandoned"][number], action: string) => {
		const rejoin = rejoinAction(branch);
		return rejoin.action === action && workNumbers.get(rejoin.step!.id) === (workNumbers.get(branch.steps.at(-1)!.id) ?? 0) + 1;
	};
	const branchFile = (branch: BranchReport["abandoned"][number]) => {
		const targets = branch.steps.flatMap((step) => step.nodes.map((node) => node.target));
		if (!targets.length || targets.some((target) => target === null)) return null;
		const unique = new Set(targets.map((target) => target!));
		return unique.size === 1 ? [...unique][0]! : null;
	};
	for (let index = 0; index < report.abandoned.length;) {
		const branch = report.abandoned[index]!;
		const target = branchFile(branch);
		const eligible = dense && (branch.kind === "backtrack" || branch.kind === "superseded") && target !== null && consecutiveSteps(branch);
		if (eligible) {
			const group = [branch];
			let nextNumber = workNumbers.get(branch.steps.at(-1)!.id) ?? 0;
			while (index + group.length < report.abandoned.length) {
				const next = report.abandoned[index + group.length]!;
				if (next.kind !== branch.kind || branchFile(next) !== target || !consecutiveSteps(next) || workNumbers.get(next.steps[0]!.id) !== nextNumber + 1) break;
				group.push(next);
				nextNumber = workNumbers.get(next.steps.at(-1)!.id)!;
			}
			const steps = group.flatMap((item) => item.steps);
			const stepNumbers = group.flatMap(branchSteps);
			const first = stepNumbers[0] ?? 0;
			const last = stepNumbers.at(-1) ?? first;
			const range = first === last ? `#${first}` : `#${first}–#${last}${last - first + 1 === stepNumbers.length ? "" : ` (${stepNumbers.length} steps)`}`;
			const allRejoinAsNextEdit = group.every((item) => rejoinIsNext(item, "edit"));
			const allRejoinAsNextRun = group.every((item) => rejoinIsNext(item, "run"));
			const restore = allRejoinAsNextEdit ? "restored by the next edit" : allRejoinAsNextRun ? "restored by the next command" : "restored at its recorded rejoin";
			const replace = allRejoinAsNextEdit ? "replaced by the next" : "replaced before run end";
			const verb = branch.kind === "backtrack" ? restore : replace;
			const kind = branch.kind === "backtrack" ? "backtrack" : "superseded edit";
			const relation = branch.kind === "backtrack" ? "on" : "to";
			const count = branch.kind === "backtrack" ? `${steps.length} ${steps.length === 1 ? "backtrack" : "backtracks"}` : plural(steps.length, kind, "superseded edits");
			const prefix = `${count} ${relation} `;
			const qualifier = steps.length === 1 ? "" : "each ";
			const suffix = ` (${range}), ${qualifier}${verb}`;
			const summary = `${prefix}${shortTarget(target, width - prefix.length - suffix.length)}${suffix}`;
			if (summary.length <= width) add(summary);
			else {
				add(`${prefix}${shortTarget(target)}`);
				addStepRanges(stepNumbers);
				add(`  ${qualifier}${verb}`);
			}
			index += group.length;
		} else {
			const labels = branch.steps.map(label).join(", ");
			const summary = `  ${branch.kind} · ${plural(branch.steps.length, "step")} · ${labels}`;
			if (clean(summary).length <= width) add(summary);
			else {
				add(`  ${branch.kind} · ${plural(branch.steps.length, "step")}`);
				addStepRanges(branchSteps(branch));
			}
			index++;
		}
	}
	add("Unknown");
	for (const step of report.unknown) add(`  ${label(step)} · ${step.reason}`);
	if (report.afterClaim.length) {
		add("Operations made after the claimed commit");
		for (const step of report.afterClaim) add(`  ${label(step)} · after-claim`);
	}
	return lines.join("\n");
}
