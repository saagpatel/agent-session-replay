import assert from "node:assert/strict";
import test from "node:test";
import { renderBranchReport, type BranchReport, type ReportStep } from "./report.ts";
import type { DiffAction } from "../types.ts";

const step = (id: string, index: number, action: DiffAction = "edit", target: string | null = "src/value.ts"): ReportStep => ({
	id,
	nodes: [{ stepId: id, part: 0, index, branchId: `branch-${id}`, action, target, status: "ok" }],
	source: "structure",
	reason: "Synthetic test step.",
});

function denseReport(): BranchReport {
	const abandoned = Array.from({ length: 9 }, (_, index) => {
		const kind = index < 7 ? "superseded" : "backtrack";
		const item = step(`toolu_private_${index + 1}`, index, "edit");
		const rejoin = index < 8 ? `toolu_private_${index + 2}` : "toolu_kept";
		return {
			branchId: `branch-${index + 1}`,
			kind,
			fork: `toolu_fork_${index}`,
			rejoin,
			reason: "Synthetic branch.",
			steps: [item],
		};
	});
	return {
		claim: { status: "resolved", sha: "3a6790b1234567890abcdef" },
		retained: [step("toolu_kept", 9)],
		abandoned,
		unknown: [],
		afterClaim: [],
		claimedButUnchanged: [],
	};
}

test("dense report groups consecutive same-file abandoned branches and uses readable step labels", () => {
	const report = denseReport();
	const rendered = renderBranchReport(report, { dense: true });
	const lines = rendered.split("\n");
	assert.equal(lines[0], "Retained 1 · Dropped 9 (7 superseded, 2 backtrack) · Unknown 0 · Commit 3a6790b resolved");
	assert.ok(rendered.includes("7 superseded edits to src/value.ts (#1–#7), each replaced by the next"));
	assert.ok(rendered.includes("2 backtracks on src/value.ts (#8–#9), each restored by the next edit"));
	assert.ok(rendered.includes("#10 edit src/value.ts"));
	assert.ok(lines.every((line) => line.length < 120));
	for (const id of ["toolu_private_1", "toolu_kept", "toolu_fork_0"]) assert.ok(!rendered.includes(id));
	assert.deepEqual(JSON.parse(JSON.stringify(report)).abandoned[0].steps[0].id, "toolu_private_1");
});

test("expanded report keeps separate branch entries and truncates long targets without wrapping", () => {
	const report = denseReport();
	report.retained = [step("toolu_kept", 9, "edit", `src/${"very-long-segment/".repeat(12)}value.ts`)];
	const rendered = renderBranchReport(report, { dense: false });
	const lines = rendered.split("\n");
	const branches = lines.filter((line) => line.startsWith("  superseded ·") || line.startsWith("  backtrack ·"));
	assert.equal(branches.length, report.abandoned.length);
	assert.ok(branches.every((line) => line.includes(" · #")));
	assert.ok(rendered.includes("#10 edit src/very-long-segment/"));
	assert.ok(lines.every((line) => line.length < 120));
	assert.ok(!rendered.includes("toolu_"));
});

test("dense grouping starts only above six branches and does not span retained steps", () => {
	const report = denseReport();
	report.abandoned = report.abandoned.slice(0, 6);
	const six = renderBranchReport(report, { dense: true });
	assert.equal(six.split("\n").filter((line) => line.includes(" superseded · 1 step") || line.includes(" backtrack · 1 step")).length, 6);

	report.abandoned = denseReport().abandoned.slice(0, 7);
	report.abandoned.forEach((branch, index) => { branch.steps[0] = step(`toolu_gap_${index}`, index < 3 ? index : index + 1); });
	report.retained = [step("toolu_between", 3)];
	const rendered = renderBranchReport(report, { dense: true });
	const groups = rendered.split("\n").filter((line) => line.startsWith("7 superseded") || line.includes("superseded edits to"));
	assert.equal(groups.length, 2);
	assert.ok(!rendered.includes("#1–#7"));
	assert.ok(rendered.includes("#5–#8"));
});

test("dense groups require a single file and report the actual backtrack rejoin operation", () => {
	const report = denseReport();
	report.abandoned = report.abandoned.slice(0, 7);
	report.abandoned[1]!.steps[0]!.nodes[0]!.target = "src/other.ts";
	report.abandoned[6]!.kind = "backtrack";
	report.abandoned[6]!.rejoin = "toolu_reset";
	report.retained = [step("toolu_reset", 9, "run", "git reset --hard")];
	const rendered = renderBranchReport(report, { dense: true });
	assert.ok(rendered.includes("src/other.ts (#2)"));
	assert.ok(rendered.includes("restored by the next command"));
	assert.ok(!rendered.includes("each restored by the next edit"));
});

test("a branch with mixed file targets is excluded from dense file grouping", () => {
	const report = denseReport();
	report.abandoned = report.abandoned.slice(0, 7);
	report.abandoned[0]!.steps.push(step("toolu_extra", 1, "edit", "src/other.ts"));
	report.abandoned.slice(1).forEach((branch, index) => { branch.steps[0] = step(`toolu_tail_${index}`, index + 2); });
	const rendered = renderBranchReport(report, { dense: true });
	assert.ok(rendered.includes("superseded · 2 steps · #1 edit src/value.ts, #2 edit src/other.ts"));
	assert.ok(rendered.includes("6 superseded edits to src/value.ts (#3–#8)"));
	assert.ok(!rendered.includes("8 superseded edits to"));
});

test("many retained steps stay visible and embedded newlines never wrap into extra lines", () => {
	const report = denseReport();
	report.abandoned = [];
	report.retained = Array.from({ length: 24 }, (_, index) => step(`toolu_retained_${index}`, index, "edit", index === 0 ? "src/a\nb.ts" : `src/${index}.ts`));
	report.unknown = [step("toolu_unknown", 24, "other", "src/unknown.ts")];
	report.unknown[0]!.reason = "unproven\ncontent";
	const rendered = renderBranchReport(report);
	assert.equal(rendered.split("\n").filter((line) => line.includes(" · structure")).length, 24);
	assert.ok(rendered.includes("#1 edit src/a b.ts"));
	assert.ok(rendered.includes("#25 other src/unknown.ts · unproven content"));
	assert.ok(rendered.split("\n").every((line) => line.length < 120));
	assert.ok(renderBranchReport(report, { width: 200 }).split("\n").every((line) => line.length < 120));
});

test("dense long targets are clipped before the step range and explanation", () => {
	const report = denseReport();
	for (const branch of report.abandoned)
		branch.steps[0]!.nodes[0]!.target = `src/${"long-segment/".repeat(20)}value.ts`;
	const rendered = renderBranchReport(report, { dense: true });
	assert.ok(rendered.includes("… (#1–#7), each replaced by the next"));
	assert.ok(rendered.includes("… (#8–#9), each restored by the next edit"));
	assert.ok(rendered.split("\n").every((line) => line.length < 120));
});
