import assert from "node:assert/strict";
import test from "node:test";
import { ATTR, type Step, type Trace } from "../../types.ts";
import { normalizeTrace } from "../normalize.ts";
import { buildBranchGraph } from "./model.ts";

const base = { "src/a.ts": "base\n", "src/b.ts": "other\n" };
function tool(
	id: string,
	name: string,
	args: Record<string, unknown>,
	options: Partial<Step> = {},
): Step {
	return {
		step_id: id,
		kind: "tool_call",
		started_at: "2026-01-01T00:00:00Z",
		ended_at: "2026-01-01T00:00:01Z",
		status: "ok",
		attributes: { [ATTR.TOOL_NAME]: name, [ATTR.TOOL_ARGS]: args },
		...options,
	};
}
function trace(...steps: Step[]): Trace {
	return {
		plumbline_version: "0.1.0",
		run: {
			run_id: "synthetic",
			harness: { name: "fixture" },
			started_at: "2026-01-01T00:00:00Z",
			workspace: { cwd: "/work/fixture" },
		},
		// These helpers describe sequential calls; concurrency tests supply explicit intervals.
		steps: steps.map((step, index) => ({
			...step,
			started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString(),
			ended_at: step.ended_at == null ? step.ended_at : new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2 + 1)).toISOString(),
		})),
	};
}
const edit = (id: string, old_string: string, new_string: string) =>
	tool(id, "Edit", {
		file_path: "/work/fixture/src/a.ts",
		old_string,
		new_string,
	});
const shell = (id: string, command: string, status: Step["status"] = "ok") =>
	tool(id, "Bash", { command }, { status });
const lineages = (graph: ReturnType<typeof buildBranchGraph>) =>
	graph.editEffects.map((e) => e.lineage);

test("a retry preserves the failed attempt and the retained main branch", () => {
	const graph = buildBranchGraph(
		trace(shell("failed", "pnpm test", "error"), shell("pass", "pnpm test")),
		base,
	);
	assert.equal(graph.nodes.length, 2);
	const abandoned = graph.branches.find((b) => b.kind === "retry");
	assert.equal(abandoned?.structuralStatus, "abandoned");
	assert.deepEqual(abandoned?.nodes, [{ stepId: "failed", part: 0 }]);
	assert.equal(abandoned?.rejoinAtStepId, "pass");
	assert.ok(
		graph.branches
			.find((b) => b.kind === "main" && b.structuralStatus === "retained")
			?.nodes.some((n) => n.stepId === "pass"),
	);
});

test("reverted then reintroduced identical content has distinct provenance", () => {
	const graph = buildBranchGraph(
		trace(
			edit("first", "base", "idea"),
			edit("revert", "idea", "base"),
			edit("second", "base", "idea"),
		),
		base,
	);
	assert.deepEqual(lineages(graph), ["abandoned", "abandoned", "retained"]);
	assert.equal(graph.endState["src/a.ts"], "idea\n");
	assert.ok(
		graph.branches.some(
			(b) =>
				b.kind === "backtrack" && b.nodes.some((n) => n.stepId === "first"),
		),
	);
});

test("lineage distinguishes partial survival from matching text elsewhere", () => {
	const graph = buildBranchGraph(
		trace(edit("insert", "base", "left right"), edit("remove", "left", "next")),
		base,
	);
	assert.deepEqual(lineages(graph), ["partial", "retained"]);
	assert.deepEqual(graph.editEffects[0]?.endState, {
		"src/a.ts": "next right\n",
	});
	const duplicate = buildBranchGraph(
		trace(edit("insert", "base", "other"), edit("remove", "other", "gone")),
		{ ...base, "src/b.ts": "other\n" },
	);
	assert.equal(duplicate.editEffects[0]?.lineage, "abandoned");
});

test("MultiEdit, sidechains, and every shell stage keep unique operation identities", () => {
	const input = trace(
		tool(
			"multi",
			"MultiEdit",
			{
				file_path: "src/a.ts",
				edits: [
					{ old_string: "base", new_string: "one" },
					{ old_string: "one", new_string: "two" },
				],
			},
			{ subagent_id: "helper" },
		),
		shell(
			"compound",
			Array.from({ length: 9 }, (_, i) => `cat src/${i}.ts`).join("; "),
		),
	);
	const graph = buildBranchGraph(input, base);
	assert.deepEqual(
		graph.nodes.filter((n) => n.stepId === "multi").map((n) => n.part),
		[0, 1],
	);
	assert.equal(graph.nodes.filter((n) => n.stepId === "compound").length, 9);
	assert.equal(
		new Set(graph.nodes.map((n) => `${n.stepId}:${n.part}`)).size,
		graph.nodes.length,
	);
	assert.equal(graph.endState["src/a.ts"], null);
	assert.equal(graph.endStateComplete, false);
	for (const step of normalizeTrace(input))
		assert.equal(
			graph.nodes.filter(
				(n) =>
					n.stepId === step.stepId &&
					n.action === step.action &&
					n.target === step.target,
			).length,
			1,
		);
	const members = graph.branches.flatMap((b) =>
		b.nodes.map((n) => `${n.stepId}:${n.part}`),
	);
	assert.equal(new Set(members).size, graph.nodes.length);
	assert.equal(members.length, graph.nodes.length);
});

test("uncapped patch files and multiple hunks preserve context ownership", () => {
	const patch =
		"*** Begin Patch\n" +
		Array.from(
			{ length: 8 },
			(_, i) => `*** Add File: src/new${i}.ts\n+new${i}\n`,
		).join("") +
		"*** End Patch";
	const confirmed = (id: string, input: string) =>
		tool(
			id,
			"apply_patch",
			{ input },
			{
				attributes: {
					[ATTR.TOOL_NAME]: "apply_patch",
					[ATTR.TOOL_ARGS]: { input },
					[ATTR.PATCH_CONFIRMED]: true,
				},
			},
		);
	const graph = buildBranchGraph(trace(confirmed("patch", patch)), base);
	assert.equal(graph.nodes.length, 8);
	assert.equal(graph.editEffects.length, 8);
	assert.ok(graph.editEffects.every((e) => e.lineage === "retained"));
	const contextual = buildBranchGraph(
		trace(
			edit("first", "base", "context\nold\ntail"),
			confirmed(
				"update",
				"*** Begin Patch\n*** Update File: src/a.ts\n@@\n context\n-old\n+new\n tail\n*** End Patch",
			),
		),
		base,
	);
	assert.deepEqual(lineages(contextual), ["partial", "retained"]);
	assert.equal(contextual.endState["src/a.ts"], "context\nnew\ntail\n");
});

test("mismatched edits, ambiguous old text, pending tools and unparsed writes fail closed", () => {
	for (const operation of [
		edit("mismatch", "absent", "new"),
		edit("ambiguous", "a", "new"),
		tool(
			"pending",
			"Write",
			{ path: "src/a.ts", content: "new" },
			{ ended_at: null },
		),
		shell("unparsed", "python3 mutate.py src/a.ts"),
	]) {
		const graph = buildBranchGraph(
			trace(
				tool("first", "Write", { path: "src/a.ts", content: "a a\n" }),
				operation,
				tool("last", "Write", { path: "src/a.ts", content: "known" }),
			),
			base,
		);
		assert.equal(graph.endState["src/a.ts"], null, operation.step_id);
		assert.equal(graph.editEffects[0]?.lineage, "unknown", operation.step_id);
		assert.equal(
			graph.editEffects.at(-1)?.lineage,
			"unknown",
			operation.step_id,
		);
	}
	const patch = tool("bad-patch", "apply_patch", {
		input:
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-missing\n+new\n*** End Patch",
	});
	patch.attributes[ATTR.PATCH_CONFIRMED] = true;
	assert.equal(buildBranchGraph(trace(patch), base).endState["src/a.ts"], null);
});

test("restore commands abandon tracked edits and retain the restoring command", () => {
	for (const command of [
		"git checkout -- src/a.ts",
		"git restore src/a.ts",
		"git stash",
		"git reset --hard",
	]) {
		const graph = buildBranchGraph(
			trace(edit("try", "base", "idea"), shell("restore", command)),
			base,
		);
		assert.equal(graph.editEffects[0]?.lineage, "abandoned", command);
		assert.equal(graph.endState["src/a.ts"], "base\n", command);
		assert.ok(
			graph.branches.some(
				(b) => b.kind === "backtrack" && b.rejoinAtStepId === "restore",
			),
			command,
		);
	}
});

test("last commit claim is provenance only and excludes later touched files", () => {
	const first = shell("commit-one", "git commit -am first");
	first.attributes[ATTR.GIT_COMMIT] = { branch: "main", short: "abcdef0" };
	const second = shell("commit-two", "git commit -am second");
	second.attributes[ATTR.GIT_COMMIT] = { branch: "main", short: "abcdef1" };
	const graph = buildBranchGraph(
		trace(
			edit("change", "base", "idea"),
			first,
			second,
			tool("later", "Write", { path: "src/later.ts", content: "later\n" }),
		),
		base,
	);
	assert.deepEqual(graph.claim, {
		commitShort: "abcdef1",
		stepId: "commit-two",
		part: 0,
		tree: {
			"src/a.ts": { text: "idea\n", owners: [...Array<string>(4).fill(JSON.stringify(["change", 0])), null] },
			"src/b.ts": { text: "other\n", owners: Array<null>(6).fill(null) },
		},
		files: ["src/a.ts"],
	});
	assert.deepEqual(buildBranchGraph(trace(), base).claim, {
		commitShort: null,
		stepId: null,
		part: null,
		tree: null,
		files: [],
	});
});

test("quoted Git wildcard and magic pathspecs invalidate the whole tree", () => {
	for (const verb of ["restore", "checkout --"])
		for (const pathspec of ["'*.ts'", '"src/?.ts"', "'src/[ab].ts'", "':(glob)**/*.ts'", "':src/a.ts'", "':(literal)src/a.ts'"]) {
			const command = `git ${verb} ${pathspec}`;
			for (const operation of [shell("restore", command), cell(`text(await tools.exec_command(${JSON.stringify({ cmd: command })}))`)]) {
				const graph = buildBranchGraph(trace(edit("change", "base", "idea"), operation), base);
				assert.equal(graph.endStateComplete, false, command);
				assert.equal(graph.endState["src/a.ts"], null, command);
				assert.equal(graph.endState["src/b.ts"], null, command);
				assert.deepEqual(lineages(graph), ["unknown"], command);
				assert.ok(!Object.hasOwn(graph.endState, "*.ts"), command);
			}
		}
});

test("no-op edits preserve the earlier owner's lineage and superseded rejoin provenance", () => {
	const graph = buildBranchGraph(
		trace(edit("one", "base", "idea"), edit("noop", "idea", "idea")),
		base,
	);
	assert.deepEqual(lineages(graph), ["retained", "unknown"]);
	assert.ok(!graph.branches.some((b) => b.kind === "backtrack"));
	const replaced = buildBranchGraph(
		trace(edit("one", "base", "idea"), edit("two", "idea", "next")),
		base,
	);
	assert.equal(
		replaced.branches.find((b) => b.kind === "superseded")?.rejoinAtStepId,
		"two",
	);
});

test("retry supporting edits and nested backtracks preserve parent lineage", () => {
	const graph = buildBranchGraph(
		trace(
			edit("hypothesis", "base", "wrong"),
			shell("failed", "pnpm test", "error"),
			edit("nested", "wrong", "try"),
			edit("undo", "try", "wrong"),
			edit("fix", "wrong", "right"),
			shell("pass", "pnpm test"),
		),
		base,
	);
	const retry = graph.branches.find((b) => b.kind === "retry");
	assert.ok(retry);
	assert.ok(retry.nodes.some((n) => n.stepId === "failed"));
	assert.ok(
		graph.branches.some(
			(b) =>
				b.kind === "backtrack" &&
				b.parentId === retry.id &&
				b.nodes.some((n) => n.stepId === "nested"),
		),
	);
	const first = graph.nodes.find((n) => n.stepId === "hypothesis");
	assert.equal(first?.branchId, retry.id);
});

test("shell noise and directories keep labels but cannot preserve lineage", () => {
	const input = trace(
		edit("known", "base", "idea"),
		shell("read", "pwd; cd src && cat a.ts"),
	);
	const graph = buildBranchGraph(input, base);
	assert.equal(graph.editEffects[0]?.lineage, "unknown");
	assert.equal(graph.endStateComplete, false);
	assert.equal(
		graph.nodes.filter(
			(n) =>
				n.stepId === "read" && n.action === "read" && n.target === "src/a.ts",
		).length,
		1,
	);
	const moved = buildBranchGraph(
		trace(
			edit("change", "base", "idea"),
			shell("restore", "cd src && git restore a.ts"),
		),
		base,
	);
	assert.equal(moved.endState["src/a.ts"], null);
	assert.equal(moved.endStateComplete, false);
});

test("empty file creation is distinct from an absent file", () => {
	const patch = tool("empty-patch", "apply_patch", {
		input: "*** Begin Patch\n*** Add File: src/empty.ts\n*** End Patch",
	});
	patch.attributes[ATTR.PATCH_CONFIRMED] = true;
	const graph = buildBranchGraph(
		trace(
			patch,
			tool("empty-write", "Write", { path: "src/empty-write.ts", content: "" }),
		),
		base,
	);
	assert.equal(graph.endState["src/empty.ts"], "");
	assert.equal(graph.endState["src/empty-write.ts"], "");
});

test("restore directories are explicit and staged-only options never imply a worktree restore", () => {
	for (const command of [
		"git restore -- src",
		"git checkout -- .",
	]) {
		const graph = buildBranchGraph(
			trace(edit("change", "base", "idea"), shell("restore", command)),
			base,
		);
		assert.equal(graph.endState["src/a.ts"], "base\n", command);
		assert.equal(graph.editEffects[0]?.lineage, "abandoned", command);
	}
	const staged = buildBranchGraph(
		trace(
			edit("change", "base", "idea"),
			shell("staged", "git restore --staged src/a.ts"),
		),
		base,
	);
	assert.equal(staged.endState["src/a.ts"], null);
	assert.ok(!staged.branches.some((b) => b.kind === "backtrack"));
});

test("unparsed writers cannot imply that unnamed files remain absent", () => {
	const graph = buildBranchGraph(
		trace(shell("unknown", "python3 mutate.py src/new.ts")),
		{},
	);
	assert.equal(graph.endStateComplete, false);
	assert.equal(buildBranchGraph(trace(), {}).endStateComplete, true);
});

test("a failed edit is not evidence of a superseded insertion", () => {
	const failed = edit("failed", "base", "idea");
	failed.status = "error";
	const graph = buildBranchGraph(trace(failed), base);
	assert.equal(graph.endState["src/a.ts"], "base\n");
	assert.ok(!graph.branches.some((branch) => branch.kind === "superseded"));
});

test("redirects from reads, searches and tests invalidate the whole tree", () => {
	for (const command of [
		"git diff > src/a.ts",
		"pnpm test > src/a.ts",
		"rg idea src/b.ts >>src/a.ts",
		"git diff>src/a.ts",
		"pnpm test 2>src/a.ts",
		"git diff > 'src/a.ts' > src/new.ts",
		"cd src && git diff > a.ts",
		"bash -lc 'git diff > src/a.ts'",
	]) {
		const graph = buildBranchGraph(
			trace(edit("change", "base", "idea"), shell("redirect", command)),
			base,
		);
		assert.equal(graph.endState["src/a.ts"], null, command);
		assert.equal(graph.editEffects[0]?.lineage, "unknown", command);
		assert.equal(graph.endState["src/b.ts"], null, command);
		assert.equal(graph.endStateComplete, false, command);
	}
});

test("all redirects fail closed while quoted redirect text stays literal", () => {
	for (const command of ["pnpm test 2>&1", "git diff > $OUTPUT", 'pnpm test > "$OUTPUT"', 'git diff "$(pnpm test > src/a.ts)"']) {
		const graph = buildBranchGraph(trace(edit("change", "base", "idea"), shell("redirect", command)), base);
		assert.equal(graph.endStateComplete, false, command);
		assert.equal(graph.endState["src/a.ts"], null, command);
	}
	for (const command of ["rg '>' src/a.ts", 'git diff -- ">"']) {
		const graph = buildBranchGraph(trace(edit("change", "base", "idea"), shell("read", command)), base);
		assert.equal(graph.endState["src/a.ts"], "idea\n", command);
		assert.equal(graph.editEffects[0]?.lineage, "retained", command);
	}
});

test("whole-tree reset and stash invalidate staged additions absent from the base", () => {
	for (const command of ["git reset --hard", "git stash", "git stash push"]) {
		const graph = buildBranchGraph(
			trace(
				tool("new", "Write", { path: "src/new.ts", content: "new\n" }),
				shell("stage", "git add src/new.ts"),
				shell("restore", command),
			),
			base,
		);
		assert.equal(graph.endState["src/new.ts"], null, command);
		assert.equal(graph.editEffects[0]?.lineage, "unknown", command);
		assert.ok(!graph.branches.some((branch) => branch.kind === "backtrack"), command);
	}
});

const unparsedCommands = [
	'cat src/a.ts | python3 -c \'open("src/a.ts","w").write("gone")\'',
	"find src -type f -delete", "find src -exec rm {} +", "rg idea src | xargs rm",
	"tee src/a.ts", 'python3 -c \'open("src/a.ts","w").write("gone")\'',
	'node -e \'require("fs").writeFileSync("src/a.ts","gone")\'',
	"sed -i 's/idea/gone/' src/a.ts", "sed -n '1p' -i src/a.ts",
	"sed -n '1p' src/a.ts --in-place", "sed -f script.sed src/a.ts",
	"cd src && cat a.ts", "cd src && git restore a.ts", "cd src && git stash",
	"MODE=test pnpm test", "env MODE=test pnpm test", "export MODE=test; cat src/a.ts",
	"git diff > src/a.ts", "pnpm test >> src/a.ts", "pnpm test 2>&1",
	"cat < src/a.ts", "cat <<< text", "cat <<EOF\ntext\nEOF",
	'cat "$(node mutate.js)"', "cat `node mutate.js`", "cat src/a.ts; pnpm test",
	"cat src/a.ts && cat src/b.ts", "pnpm test || true", "pnpm test &",
	"git diff --output=src/a.ts", "git log --output src/a.ts", "git show -osrc/a.ts",
	"rg --pre mutate idea src", "grep --exclude-from=src/a.ts idea src",
	"head -c 10 src/a.ts", "ls -l src", "cat src/a.ts src/b.ts", "tail src/a.ts",
	"git add src/a.ts && git commit -m fixture && cat src/a.ts", "git status; git commit -m fixture",
	"git restore --staged src/a.ts", "printf fixture", "npm run build", "pwd",
];

function cell(input: string, parts = [{ kind: "chunk", result: { exit_code: 0, session_id: null, test_failures: false, test_passes: false } }]): Step {
	const step = tool("cell", "exec", { input });
	step.attributes[ATTR.EXEC_COMPLETED] = true;
	step.attributes[ATTR.EXEC_PARTS] = parts;
	return step;
}

test("only the explicit shell allowlist preserves lineage, directly and in exec cells", () => {
	for (const command of unparsedCommands) {
		for (const operation of [shell("command", command), cell(`text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: "/work/fixture" })}))`)]) {
			const graph = buildBranchGraph(trace(edit("change", "base", "idea"), operation, tool("later", "Write", { path: "src/new.ts", content: "new" })), base);
			assert.equal(graph.endStateComplete, false, command);
			assert.equal(graph.endState["src/a.ts"], null, command);
			assert.equal(graph.endState["src/b.ts"], null, command);
			assert.equal(graph.endState["src/new.ts"], null, command);
			assert.deepEqual(lineages(graph), ["unknown", "unknown"], command);
			assert.ok(graph.branches.some((branch) => branch.reasons.some((reason) => reason.includes(command))), command);
		}
	}
});

test("literal reads, tests, tool reads and shell argv wrappers preserve lineage", () => {
	for (const command of [
		"cat src/a.ts", "sed -n '1,20p' src/a.ts", "sed -n '1,$p' src/a.ts", "head -n 5 src/a.ts",
		"ls", "ls src", "rg -n -i -w -l -F -r --no-heading idea src", "grep -n idea src/a.ts",
		"git status --short", "git diff -- src/a.ts", "git log --oneline", "git show HEAD", "pnpm test", "node --test test.ts",
	]) {
		for (const operation of [shell("read", command), tool("argv", "shell", { command: ["bash", "-lc", command] }), cell(`text(await tools.exec_command(${JSON.stringify({ cmd: command })}))`)]) {
			const graph = buildBranchGraph(trace(edit("change", "base", "idea"), operation), base);
			assert.equal(graph.endStateComplete, true, command);
			assert.deepEqual(lineages(graph), ["retained"], command);
		}
	}
	for (const name of ["Read", "Grep", "Glob", "TodoWrite", "read_file"]) {
		const graph = buildBranchGraph(trace(edit("change", "base", "idea"), tool("read", name, { path: "src/a.ts" })), base);
		assert.deepEqual(lineages(graph), ["retained"], name);
		assert.equal(graph.endStateComplete, true, name);
	}
});

test("exec workdirs resolve restore paths and distinct calls keep their own commands", () => {
	const input = 'text(await tools.exec_command({cmd:"git restore a.ts",workdir:"/work/fixture/src"})); text(await tools.exec_command({cmd:"cat src/b.ts"}));';
	const operation = cell(input);
	const parts = operation.attributes[ATTR.EXEC_PARTS] as unknown[];
	operation.attributes[ATTR.EXEC_PARTS] = [...parts, ...parts];
	const graph = buildBranchGraph(trace(edit("change", "base", "idea"), operation), base);
	assert.equal(graph.endState["src/a.ts"], "base\n");
	assert.deepEqual(lineages(graph), ["abandoned"]);
	assert.equal(graph.nodes.find((node) => node.stepId === "cell")?.target, "git restore a.ts");
	assert.equal(new Set(graph.nodes.map((node) => `${node.stepId}:${node.part}`)).size, graph.nodes.length);
});

test("nonliteral, non-straight-line cells and unlisted tools are unparsed writers", () => {
	for (const input of [
		'if (true) text(await tools.exec_command({cmd:"cat src/a.ts"}))',
		'await tools.exec_command({cmd:"cat src/a.ts"})',
		'text(await tools.exec_command({cmd:"cat src/a.ts",workdir}))',
		'text(await tools.exec_command({cmd:"cat src/a.ts",...options}))',
		'text(await tools.exec_command({cmd:"cat src/a.ts",cmd:"pnpm test"}))',
		'text(await tools.exec_command({cmd:"cat src/a.ts",foo:mutate()}))',
		'text(await tools.exec_command({cmd:"cat src/a.ts"})); mutate();',
		'text(await tools.exec_command({cmd:command}))',
		'text(await tools.exec_command({cmd:"cat src/a.ts" + suffix}))',
		'text(await tools.exec_command({cmd:`cat ${target}`}))',
		'text(await tools.exec_command({cmd:"cat src/a.ts\\u003b node mutate.js"}))',
		"text(await tools.exec_command({cmd:'cat src/a.ts\\x3b node mutate.js'}))",
	]) {
		const graph = buildBranchGraph(trace(edit("change", "base", "idea"), cell(input)), base);
		assert.equal(graph.endStateComplete, false, input);
		assert.deepEqual(lineages(graph), ["unknown"], input);
	}
	for (const name of ["update_plan", "ExitPlanMode", "WebSearch", "unknown_tool"]) {
		const graph = buildBranchGraph(trace(edit("change", "base", "idea"), tool("unknown", name, { cmd: "cat src/a.ts" })), base);
		assert.equal(graph.endStateComplete, false, name);
	}
});

test("exec cells reconstruct confirmed patch and write_file payloads", () => {
	const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-base\n+idea\n*** End Patch";
	const operation = cell(`text(await tools.apply_patch(${JSON.stringify(patch)})); text(await tools.write_file({path:"src/b.ts",content:"next\\n"}));`);
	operation.attributes[ATTR.EXEC_PARTS] = [{ kind: "empty-object" }, { kind: "empty-object" }];
	const graph = buildBranchGraph(trace(operation), base);
	assert.equal(graph.endStateComplete, true);
	assert.deepEqual(lineages(graph), ["retained", "retained"]);
	assert.deepEqual(graph.endState, { "src/a.ts": "idea\n", "src/b.ts": "next\n" });
});

test("confirmed patch moves track both source and destination", () => {
	const operation = tool("move", "apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/moved.ts\n@@\n-base\n+idea\n*** End Patch" });
	operation.attributes[ATTR.PATCH_CONFIRMED] = true;
	const graph = buildBranchGraph(trace(operation), base);
	assert.equal(graph.endStateComplete, true);
	assert.equal(Object.hasOwn(graph.endState, "src/a.ts"), false);
	assert.equal(graph.endState["src/moved.ts"], "idea\n");
	assert.deepEqual(lineages(graph), ["retained"]);
	const pureMove = tool("pure-move", "apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/moved.ts\n*** End Patch" });
	pureMove.attributes[ATTR.PATCH_CONFIRMED] = true;
	const moved = buildBranchGraph(trace(edit("change", "base", "idea"), pureMove), base);
	assert.equal(moved.editEffects[0]?.lineage, "retained");
	assert.equal(moved.endState["src/moved.ts"], "idea\n");
	const uncertain = buildBranchGraph(trace(edit("change", "base", "idea"), pureMove, tool("pending", "write_file", { path: "src/moved.ts", content: "next" }, { ended_at: null })), base);
	assert.equal(uncertain.editEffects[0]?.lineage, "unknown");
	assert.equal(uncertain.endState["src/moved.ts"], null);
});

test("git moves preserve owners only for confirmed single-file literal destinations", () => {
	for (const command of [
		"git mv src/a.ts src/moved.ts", "git mv 'src/a.ts' 'src/moved.ts'",
	]) {
		const graph = buildBranchGraph(trace(edit("change", "base", "idea"), shell("move", command)), base);
		assert.equal(graph.editEffects[0]?.lineage, "retained", command);
		assert.equal(graph.endState["src/moved.ts"], "idea\n", command);
		assert.equal(Object.hasOwn(graph.endState, "src/a.ts"), false, command);
	}
	for (const command of [
		"git mv src/a.ts src/b.ts", "git mv src/a.ts src", "git mv src src/moved",
		"git mv src/a.ts /work/outside/moved.ts", "git mv src/a.ts $DESTINATION",
		"git mv -f src/a.ts src/moved.ts", "git mv src/a.ts src/b.ts src/moved.ts",
	]) {
		const graph = buildBranchGraph(trace(edit("change", "base", "idea"), shell("move", command)), base);
		assert.equal(graph.editEffects[0]?.lineage, "unknown", command);
	}
	for (const status of ["error", "unknown"] as const) {
		const move = shell("move", "git mv src/a.ts src/moved.ts");
		move.status = status === "unknown" ? "ok" : status;
		if (status === "unknown") move.ended_at = null;
		assert.equal(buildBranchGraph(trace(edit("change", "base", "idea"), move), base).editEffects[0]?.lineage, "unknown");
	}
});
