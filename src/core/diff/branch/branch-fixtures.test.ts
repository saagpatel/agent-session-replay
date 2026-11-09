import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseClaudeCodeTranscript } from "../../parsers/claude-code.ts";
import { parseCodexTranscript } from "../../parsers/codex.ts";
import { normalizeTrace, relPath } from "../normalize.ts";
import { buildBranchGraph } from "./model.ts";
import { fixtureRepoCommitShas } from "./git-sha.ts";

const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const fixtureDir = join(root, "fixtures/run-diff/branch");

async function paths(directory: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory())
			out.push(...(await paths(join(directory, entry.name), relative)));
		else out.push(relative);
	}
	return out;
}

test("branch fixtures contain exactly 30 complete traces and preserve every tool step", async () => {
	const traceFiles = (await paths(fixtureDir)).filter((path) =>
		/^\d{2}-.+\.jsonl$/.test(path),
	);
	assert.equal(
		traceFiles.length,
		30,
		"expected exactly 30 branch fixture traces",
	);
	for (const file of traceFiles) {
		const slug = file.slice(0, -".jsonl".length);
		const labels = JSON.parse(
			await readFile(join(fixtureDir, `${slug}.labels.json`), "utf8"),
		);
		const raw = await readFile(join(fixtureDir, file), "utf8");
		const trace =
			labels.harness === "codex"
				? parseCodexTranscript(raw)
				: parseClaudeCodeTranscript(raw);
		const repo = JSON.parse(
			await readFile(join(fixtureDir, "repos", `${labels.repo}.json`), "utf8"),
		);
		const graph = buildBranchGraph(trace, repo.commits[0].files);
		const nodeKeys = graph.nodes.map((node) => `${node.stepId}:${node.part}`);
		assert.equal(
			new Set(nodeKeys).size,
			nodeKeys.length,
			`${slug}: duplicate node identity`,
		);
		const normalizedCounts = new Map<string, number>();
		for (const step of normalizeTrace(trace)) {
			let action = step.action;
			let target = step.target;
			if (step.action === "other" && step.target === "write_file") {
				const raw = trace.steps.find((entry) => entry.step_id === step.stepId);
				const args = raw?.attributes["tool.arguments"] as
					| Record<string, unknown>
					| undefined;
				action = "write";
				target =
					typeof args?.["file_path"] === "string"
						? relPath(args["file_path"] as string, trace.run.workspace?.cwd)
						: null;
			}
			const identity = JSON.stringify([step.stepId, action, target]);
			normalizedCounts.set(identity, (normalizedCounts.get(identity) ?? 0) + 1);
		}
		if (slug === "23-compound-over-six-stages") {
			const shell = trace.steps.find((step) => step.step_id === "toolu_0");
			const command = String(
				(shell?.attributes["tool.arguments"] as Record<string, unknown>)?.[
					"command"
				],
			);
			assert.ok(
				graph.nodes.filter((node) => node.stepId === "toolu_0").length >= 7,
				`${slug}: compound shell stages were capped`,
			);
			assert.ok(
				command.includes("git diff"),
				`${slug}: generated long compound command is incomplete`,
			);
		}
		for (const [identity, count] of normalizedCounts) {
			const [stepId, action, target] = JSON.parse(identity);
			const actual = graph.nodes.filter(
				(node) =>
					node.stepId === stepId &&
					node.action === action &&
					node.target === target,
			).length;
			const source = trace.steps.find((entry) => entry.step_id === stepId);
			const toolName = source?.attributes["gen_ai.tool.name"];
			const args = source?.attributes["tool.arguments"] as
				| Record<string, unknown>
				| undefined;
			const expected =
				toolName === "MultiEdit" && Array.isArray(args?.["edits"])
					? args.edits.length
					: count;
			assert.equal(
				actual,
				expected,
				`${slug}: normalized operation ${identity} count`,
			);
		}
		const graphNodeKeys = graph.nodes
			.map((node) => `${node.stepId}:${node.part}`)
			.sort();
		const branchNodeKeys = graph.branches
			.flatMap((branch) =>
				branch.nodes.map((node) => `${node.stepId}:${node.part}`),
			)
			.sort();
		assert.equal(
			new Set(branchNodeKeys).size,
			branchNodeKeys.length,
			`${slug}: branch membership duplicates a node`,
		);
		assert.deepEqual(
			branchNodeKeys,
			graphNodeKeys,
			`${slug}: branches do not partition graph nodes`,
		);
		for (const node of graph.nodes) {
			assert.ok(
				graph.branches.some((branch) => branch.id === node.branchId),
				`${slug}: ${node.stepId}:${node.part} has no branch`,
			);
		}
		const toolIds = trace.steps
			.filter((step) => step.kind === "tool_call")
			.map((step) => step.step_id);
		for (const stepId of toolIds) {
			assert.ok(
				graph.nodes.some((node) => node.stepId === stepId),
				`${slug}: tool step ${stepId} missing`,
			);
		}
		const effects = new Map(
			graph.editEffects.map((effect) => [
				`${effect.node.stepId}:${effect.node.part}`,
				effect,
			]),
		);
		const structuralSet = (
			status: "abandoned" | "retained" | "partial" | "unknown",
		): Set<string> => {
			const nodes = new Set<string>();
			for (const branch of graph.branches) {
				if (branch.structuralStatus !== status) continue;
				for (const node of branch.nodes) {
					const hasEffects = graph.editEffects.some(
						(e) => e.node.stepId === node.stepId && e.node.part === node.part,
					);
					if (!hasEffects) nodes.add(node.stepId);
				}
			}
			for (const effect of graph.editEffects)
				if (effect.lineage === status) nodes.add(effect.node.stepId);
			return nodes;
		};
		const decided = new Set<string>([
			...(labels.expected.abandoned as string[]),
			...(labels.expected.retained as string[]),
			...((labels.expected.partial as string[]) ?? []),
			...((labels.expected.unknown as string[]) ?? []),
		]);
		const actualAbandoned = [...structuralSet("abandoned")]
			.filter((stepId) => decided.has(stepId))
			.sort();
		const actualRetained = [...structuralSet("retained")]
			.filter((stepId) => decided.has(stepId))
			.sort();
		const actualPartial = [...structuralSet("partial")]
			.filter((stepId) => decided.has(stepId))
			.sort();
		assert.deepEqual(
			actualAbandoned,
			[...(labels.expected.abandoned as string[])].sort(),
			`${slug}: abandoned label set`,
		);
		assert.deepEqual(
			actualRetained,
			[...(labels.expected.retained as string[])].sort(),
			`${slug}: retained label set`,
		);
		assert.deepEqual(
			actualPartial,
			[...((labels.expected.partial as string[]) ?? [])].sort(),
			`${slug}: partial label set`,
		);
		for (const stepId of (labels.expected.unknown as string[]) ?? []) {
			assert.ok(
				structuralSet("unknown").has(stepId),
				`${slug}: expected ${stepId} structurally unknown`,
			);
		}
		for (const stepId of labels.expected.artifactOnly ?? []) {
			assert.equal(
				effects.get(`${stepId}:0`)?.lineage,
				"retained",
				`${slug}: artifact-only edit should remain in run lineage`,
			);
		}
		assert.equal(
			graph.claim.commitShort,
			labels.claim.commitShort,
			`${slug}: commit claim mismatch`,
		);
		if (labels.claim.commitShort !== null) {
			const repoShas = fixtureRepoCommitShas(repo.commits);
			if (slug === "12-claim-outside-repo") {
				assert.ok(
					!repoShas.some((sha) => sha.startsWith(labels.claim.commitShort)),
					`${slug}: external claim unexpectedly exists in the repo`,
				);
			} else {
				assert.ok(
					repoShas.at(-1)?.startsWith(labels.claim.commitShort),
					`${slug}: claim is not the final fixture commit`,
				);
			}
		}
		const artifactFiles = new Set<string>();
		for (const stepId of labels.expected.artifactOnly ?? []) {
			for (const effect of graph.editEffects)
				if (effect.node.stepId === stepId) artifactFiles.add(effect.file);
		}
		const unknownFiles = new Set(
			graph.editEffects
				.filter((effect) => effect.lineage === "unknown")
				.map((effect) => effect.file),
		);
		const finalTree = repo.commits.at(-1).files as Record<string, string>;
		const files = new Set([
			...Object.keys(graph.endState),
			...Object.keys(finalTree),
		]);
		for (const filePath of files) {
			if (
				artifactFiles.has(filePath) ||
				unknownFiles.has(filePath) ||
				graph.endState[filePath] === null
			)
				continue;
			assert.equal(
				graph.endState[filePath] ?? null,
				finalTree[filePath] ?? null,
				`${slug}: structurally known end state for ${filePath}`,
			);
		}
	}
});

test("branch fixture generator reproduces every fixture byte-for-byte", async () => {
	const tempParent = join(root, ".tmp");
	await mkdir(tempParent, { recursive: true });
	const tempRoot = await mkdtemp(join(tempParent, "branch-fixture-repro-"));
	try {
		const out = join(tempRoot, "generated");
		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"scripts/gen-branch-fixtures.ts",
				"--out",
				out,
			],
			{ cwd: root },
		);
		const expectedFiles = await paths(fixtureDir);
		const generatedFiles = await paths(join(out, "fixtures/run-diff/branch"));
		assert.deepEqual(generatedFiles, expectedFiles);
		for (const file of expectedFiles) {
			assert.deepEqual(
				await readFile(join(out, "fixtures/run-diff/branch", file)),
				await readFile(join(fixtureDir, file)),
				`${file} changed when regenerated`,
			);
		}
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
