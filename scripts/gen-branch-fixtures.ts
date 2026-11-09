import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fixtureRepoCommitShas,
	gitCommitSha,
	type FixtureRepoCommit,
} from "../src/core/diff/branch/git-sha.ts";

type Tool = {
	name: string;
	input: Record<string, unknown>;
	output?: string;
	failed?: boolean;
	sidechain?: boolean;
};
type Case = {
	slug: string;
	tools: Tool[];
	abandoned?: string[];
	retained?: string[];
	partial?: string[];
	unknown?: string[];
	artifactOnly?: string[];
	claim?: "missing" | "none";
	notes: string;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseTree = {
	"src/value.ts": "const value = 0;\n",
	"src/other.ts": "const other = 0;\n",
};
const edit = (
	old_string: string,
	new_string: string,
	file_path = "/work/branch-fixture/src/value.ts",
): Tool => ({ name: "Edit", input: { file_path, old_string, new_string } });
const write = (
	content: string,
	file_path = "/work/branch-fixture/src/value.ts",
): Tool => ({ name: "Write", input: { file_path, content } });
const test = (failed = false, command = "pnpm test"): Tool => ({
	name: "Bash",
	input: { command },
	...(failed
		? { failed: true, output: "ℹ tests 2\nℹ pass 1\nℹ fail 1" }
		: { output: "ℹ tests 2\nℹ pass 2\nℹ fail 0" }),
});
const bash = (command: string, output = "ok"): Tool => ({
	name: "Bash",
	input: { command },
	output,
});

const cases: Case[] = [
	{
		slug: "01-single-retry",
		tools: [test(true), test(false)],
		abandoned: ["toolu_0"],
		retained: ["toolu_1"],
		notes: "One failed test attempt is repeated and passes.",
	},
	{
		slug: "02-retry-then-edit",
		tools: [
			edit("const value = 0;", "const value = 1;"),
			test(true),
			edit("const value = 1;", "const value = 2;"),
			test(false),
		],
		abandoned: ["toolu_0", "toolu_1"],
		retained: ["toolu_2", "toolu_3"],
		notes:
			"The first edit and failed test belong to the abandoned attempt; the retry edit and pass survive.",
	},
	{
		slug: "03-edit-revert",
		tools: [
			edit("const value = 0;", "const value = 1;"),
			edit("const value = 1;", "const value = 0;"),
		],
		abandoned: ["toolu_0"],
		retained: ["toolu_1"],
		notes: "An edit restores the base text.",
	},
	{
		slug: "04-checkout-restore",
		tools: [
			edit("const value = 0;", "const value = 1;"),
			bash("git checkout -- src/value.ts"),
		],
		abandoned: ["toolu_0"],
		retained: ["toolu_1"],
		notes: "A checkout restores the named file.",
	},
	{
		slug: "05-stash-backtrack",
		tools: [edit("const value = 0;", "const value = 1;"), bash("git stash")],
		abandoned: ["toolu_0"],
		retained: ["toolu_1"],
		notes: "Stash is a backtrack signal after an edit.",
	},
	{
		slug: "06-superseded-edit",
		tools: [
			edit("const value = 0;", "const value = 1;"),
			edit("const value = 1;", "const value = 2;"),
		],
		abandoned: ["toolu_0"],
		retained: ["toolu_1"],
		notes: "The later replacement removes the first inserted text.",
	},
	{
		slug: "07-two-hypotheses",
		tools: [
			edit("const value = 0;", "const value = 1;"),
			edit(
				"const other = 0;",
				"const other = 1;",
				"/work/branch-fixture/src/other.ts",
			),
			edit("const value = 1;", "const value = 0;"),
			edit(
				"const other = 1;",
				"const other = 0;",
				"/work/branch-fixture/src/other.ts",
			),
		],
		abandoned: ["toolu_0", "toolu_1"],
		retained: ["toolu_2", "toolu_3"],
		notes: "Two independent hypotheses are both restored.",
	},
	{
		slug: "08-retry-nested-backtrack",
		tools: [
			edit("const value = 0;", "const value = 1;"),
			test(true),
			edit("const value = 1;", "const value = 2;"),
			edit("const value = 2;", "const value = 1;"),
			test(false),
		],
		abandoned: ["toolu_0", "toolu_1", "toolu_2"],
		retained: ["toolu_3", "toolu_4"],
		notes:
			"The retry has an edit hypothesis that is reverted; both the original and intermediate hypothesis are removed.",
	},
	{
		slug: "09-dense-dead-ends",
		tools: [
			...Array.from({ length: 12 }, (_, i) =>
				edit(`const value = ${i};`, `const value = ${i + 1};`),
			),
			...Array.from({ length: 12 }, (_, i) =>
				edit(`const value = ${12 - i};`, `const value = ${11 - i};`),
			),
			test(false),
		],
		abandoned: Array.from({ length: 23 }, (_, i) => `toolu_${i}`),
		retained: ["toolu_23", "toolu_24"],
		notes:
			"Twelve hypotheses and eleven intermediate restorations are superseded; the final restore survives.",
	},
	{
		slug: "10-no-dead-ends",
		tools: [edit("const value = 0;", "const value = 1;"), test(false)],
		retained: ["toolu_0", "toolu_1"],
		notes: "A straightforward edit and passing test.",
	},
	{
		slug: "11-artifact-omits-edit",
		tools: [edit("const value = 0;", "const value = 1;"), test(false)],
		artifactOnly: ["toolu_0"],
		retained: ["toolu_1"],
		notes:
			"The successful run claims a commit that omits the edit; packet 03 decides artifact membership.",
	},
	{
		slug: "12-claim-outside-repo",
		tools: [test(false)],
		claim: "missing",
		retained: ["toolu_0"],
		notes: "Claim short SHA is absent from fixture repository.",
	},
	{
		slug: "13-unparsed-write",
		tools: [
			edit("const value = 0;", "const value = 1;"),
			bash('python3 -c \'open("src/value.ts", "w").write("unknown")\''),
		],
		unknown: ["toolu_0"],
		retained: ["toolu_1"],
		notes:
			"A shell write names a target but its payload cannot be reconstructed; the touched file lineage is unknown.",
	},
	{
		slug: "14-no-commit",
		tools: [edit("const value = 0;", "const value = 1;")],
		claim: "none",
		retained: ["toolu_0"],
		notes: "No git commit output is present.",
	},
	{
		slug: "15-reset-hard",
		tools: [write("const value = 1;"), bash("git reset --hard")],
		abandoned: ["toolu_0"],
		retained: ["toolu_1"],
		notes: "Reset hard marks the preceding edit branch abandoned.",
	},
	{
		slug: "16-write-overwrite",
		tools: [write("const value = 1;"), write("const value = 2;")],
		abandoned: ["toolu_0"],
		retained: ["toolu_1"],
		notes: "A full write replaces the earlier file contents.",
	},
	{
		slug: "17-codex-retry",
		tools: [test(true), test(false)],
		abandoned: ["call_0"],
		retained: ["call_1"],
		notes: "Codex rollout: failing test repeated successfully.",
	},
	{
		slug: "18-codex-patch-revert",
		tools: [
			{
				name: "apply_patch",
				input: {
					input:
						"*** Begin Patch\n*** Update File: /work/branch-fixture/src/value.ts\n@@\n-const value = 0;\n+const value = 1;\n*** End Patch",
				},
				output: "Success",
			},
			{
				name: "shell",
				input: { command: ["bash", "-lc", "git checkout -- src/value.ts"] },
				output: "Process exited with code 0\nOutput:\nok",
			},
		],
		abandoned: ["call_0"],
		retained: ["call_1"],
		notes: "Codex rollout: patch attempt followed by file restore.",
	},
	{
		slug: "19-codex-zero-dead-ends",
		tools: [test(false)],
		retained: ["call_0"],
		notes: "Codex rollout with one passing test.",
	},
	{
		slug: "20-codex-superseded",
		tools: [write("const value = 1;"), write("const value = 2;")],
		abandoned: ["call_0"],
		retained: ["call_1"],
		notes: "Codex write_file steps replace the earlier contents.",
	},
	{
		slug: "21-codex-unparsed",
		tools: [
			{
				name: "shell",
				input: { command: ["bash", "-lc", "python3 mutate.py src/value.ts"] },
				output: "Process exited with code 0\nOutput:\nok",
			},
		],
		retained: ["call_0"],
		notes: "Codex command may write the path but does not expose its payload.",
	},
	{
		slug: "22-multiedit-parts",
		tools: [
			{
				name: "MultiEdit",
				input: {
					file_path: "/work/branch-fixture/src/value.ts",
					edits: [
						{ old_string: "const value", new_string: "const result" },
						{ old_string: "= 0;", new_string: "= 1;" },
					],
				},
			},
		],
		retained: ["toolu_0"],
		notes: "One MultiEdit tool call contains two ordered edit operations.",
	},
	{
		slug: "23-compound-over-six-stages",
		tools: [
			bash(
				"npm run build && npm run typecheck && npm test; git status; pwd; echo done; git diff",
			),
		],
		retained: ["toolu_0"],
		notes:
			"A compound shell command has more than six stages and retains its final commit claim.",
	},
	{
		slug: "24-codex-seven-file-patch",
		tools: [
			{
				name: "apply_patch",
				input: {
					input: [
						"*** Begin Patch",
						...Array.from(
							{ length: 7 },
							(_, i) =>
								`*** Add File: /work/branch-fixture/src/new${i}.ts\n+export const new${i} = ${i};`,
						),
						"*** End Patch",
					].join("\n"),
				},
				output: "Success",
			},
		],
		retained: ["call_0"],
		notes: "One Codex patch call contains seven added files.",
	},
	{
		slug: "25-sidechain-tool",
		tools: [
			{
				name: "Read",
				input: { file_path: "/work/branch-fixture/src/other.ts" },
				sidechain: true,
			},
		],
		retained: ["toolu_0"],
		notes: "A Claude sidechain read remains represented in the branch graph.",
	},
	{
		slug: "26-partial-lineage",
		tools: [edit("const value = 0;", "const value = 10;"), edit("10;", "1;")],
		partial: ["toolu_0"],
		retained: ["toolu_1"],
		notes:
			"The first edit retains part of its inserted line while a later edit replaces the suffix.",
	},
	{
		slug: "27-identical-edit-reintroduced",
		tools: [
			edit("const value = 0;", "const value = 1;"),
			edit("const value = 1;", "const value = 0;"),
			edit("const value = 0;", "const value = 1;"),
		],
		abandoned: ["toolu_0", "toolu_1"],
		retained: ["toolu_2"],
		notes:
			"The same text is removed and reintroduced; origin belongs only to the later edit.",
	},
	{
		slug: "28-unconfirmed-patch",
		tools: [
			{
				name: "apply_patch",
				input: {
					input:
						"*** Begin Patch\n*** Update File: /work/branch-fixture/src/value.ts\n@@\n-const value = missing;\n+const value = 1;\n*** End Patch",
				},
				output: "Success",
			},
		],
		unknown: ["toolu_0"],
		notes:
			"The patch is reported successful but its context cannot be located in the known file, leaving lineage unknown.",
	},
	{
		slug: "29-codex-single-revert",
		tools: [
			{
				name: "Write",
				input: {
					file_path: "/work/branch-fixture/src/value.ts",
					content: "const value = 1;\n",
				},
			},
			{
				name: "shell",
				input: { command: ["bash", "-lc", "git restore -- src/value.ts"] },
				output: "Process exited with code 0\nOutput:\nok",
			},
		],
		abandoned: ["call_0"],
		retained: ["call_1"],
		notes: "Codex write_file call followed by a successful path restore.",
	},
	{
		slug: "30-codex-partial-edit",
		tools: [
			{
				name: "Write",
				input: {
					file_path: "/work/branch-fixture/src/value.ts",
					content: "const value = 10;\n",
				},
			},
			{
				name: "Write",
				input: {
					file_path: "/work/branch-fixture/src/value.ts",
					content: "const value = 1;\n",
				},
			},
		],
		abandoned: ["call_0"],
		retained: ["call_1"],
		notes: "Codex writes replace and supersede the earlier inserted text.",
	},
];

function ccEvents(
	tools: Tool[],
	claim: { short: string; message: string; command: string } | null,
): Record<string, unknown>[] {
	const events: Record<string, unknown>[] = [
		{
			sessionId: "branch-fixture",
			cwd: "/work/branch-fixture",
			gitBranch: "main",
			type: "user",
			uuid: "user",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "Synthetic fixture task." },
		},
	];
	const commitLine = claim ? `[main ${claim.short}] ${claim.message}` : null;
	const traceTools = [
		...tools,
		...(claim && commitLine ? [bash(claim.command, commitLine)] : []),
	];
	traceTools.forEach((t, i) => {
		const id = `toolu_${i}`;
		const input = { ...t.input };
		events.push({
			sessionId: "branch-fixture",
			cwd: "/work/branch-fixture",
			gitBranch: "main",
			...(t.sidechain ? { isSidechain: true, agentId: "fixture-agent" } : {}),
			type: "assistant",
			uuid: `a${i}`,
			timestamp: `2026-01-01T00:00:${String(i * 2 + 1).padStart(2, "0")}.000Z`,
			message: {
				role: "assistant",
				model: "fixture-model",
				stop_reason: "tool_use",
				content: [{ type: "tool_use", id, name: t.name, input }],
			},
		});
		const content = t.output ?? "ok";
		events.push({
			sessionId: "branch-fixture",
			cwd: "/work/branch-fixture",
			gitBranch: "main",
			...(t.sidechain ? { isSidechain: true, agentId: "fixture-agent" } : {}),
			type: "user",
			uuid: `r${i}`,
			timestamp: `2026-01-01T00:00:${String(i * 2 + 2).padStart(2, "0")}.000Z`,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: id,
						is_error: t.failed === true,
						content,
					},
				],
			},
		});
	});
	events.push({
		sessionId: "branch-fixture",
		cwd: "/work/branch-fixture",
		gitBranch: "main",
		type: "assistant",
		uuid: "done",
		timestamp: "2026-01-01T00:10:00.000Z",
		message: {
			role: "assistant",
			model: "fixture-model",
			stop_reason: "end_turn",
			content: [{ type: "text", text: "Done" }],
		},
	});
	return events;
}

function codexEvents(
	tools: Tool[],
	claim: { short: string; message: string; command: string } | null,
): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [
		{
			timestamp: "2026-01-01T00:00:00.000Z",
			type: "session_meta",
			payload: {
				id: "branch-fixture",
				cwd: "/work/branch-fixture",
				originator: "codex_cli",
			},
		},
		{
			timestamp: "2026-01-01T00:00:00.001Z",
			type: "turn_context",
			payload: { cwd: "/work/branch-fixture", model: "fixture-model" },
		},
		{
			timestamp: "2026-01-01T00:00:00.002Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Synthetic fixture task." }],
			},
		},
	];
	const commitLine = claim ? `[main ${claim.short}] ${claim.message}` : null;
	const traceTools = [
		...tools,
		...(claim && commitLine
			? [
					{
						name: "shell",
						input: {
							command: ["bash", "-lc", claim.command],
						},
						output: `Process exited with code 0\nOutput:\n${commitLine}`,
					} as Tool,
				]
			: []),
	];
	traceTools.forEach((t, i) => {
		const id = `call_${i}`;
		const name =
			t.name === "Bash" ? "shell" : t.name === "Write" ? "write_file" : t.name;
		const args =
			name === "shell"
				? {
						command: Array.isArray(t.input.command)
							? t.input.command
							: ["bash", "-lc", String(t.input.command)],
					}
				: name === "apply_patch"
					? t.input
					: name === "write_file"
						? {
								file_path:
									t.input.file_path ?? "/work/branch-fixture/src/value.ts",
								content: t.input.content,
							}
						: t.input;
		const type =
			name === "shell" || name === "write_file"
				? "function_call"
				: "custom_tool_call";
		out.push({
			timestamp: `2026-01-01T00:00:${String(i * 2 + 1).padStart(2, "0")}.000Z`,
			type: "response_item",
			payload:
				type === "function_call"
					? { type, name, call_id: id, arguments: JSON.stringify(args) }
					: {
							type,
							name,
							call_id: id,
							status: "completed",
							input:
								name === "apply_patch"
									? String(args.input)
									: JSON.stringify(args),
						},
		});
		let output =
			t.output ??
			(t.failed
				? "Process exited with code 1\nOutput:\nℹ pass 1\nℹ fail 1"
				: type === "function_call"
					? "Process exited with code 0\nOutput:\nok"
					: "Success");
		out.push({
			timestamp: `2026-01-01T00:00:${String(i * 2 + 2).padStart(2, "0")}.000Z`,
			type: "response_item",
			payload: {
				type:
					type === "function_call"
						? "function_call_output"
						: "custom_tool_call_output",
				call_id: id,
				output,
			},
		});
	});
	out.push({
		timestamp: "2026-01-01T00:10:00.000Z",
		type: "event_msg",
		payload: { type: "task_complete", last_agent_message: "Done" },
	});
	return out;
}

async function generate(outRoot = root): Promise<void> {
	const dir = join(outRoot, "fixtures/run-diff/branch");
	await mkdir(join(dir, "repos"), { recursive: true });
	for (let i = 0; i < cases.length; i++) {
		const c = cases[i]!;
		const codex =
			c.slug.includes("codex") ||
			c.slug.startsWith("17-") ||
			c.slug.startsWith("19-") ||
			c.slug.startsWith("20-") ||
			c.slug.startsWith("21-");
		const repoName = c.slug.slice(3);
		const finalTree: Record<string, string> = { ...baseTree };
		// Trace mutations that end in an unambiguous known file value shape the second commit.
		for (const t of c.tools) {
			const file = String(
				t.input.file_path ?? "/work/branch-fixture/src/value.ts",
			).replace("/work/branch-fixture/", "");
			if (
				t.name === "Edit" &&
				typeof t.input.old_string === "string" &&
				typeof t.input.new_string === "string"
			)
				finalTree[file] = (finalTree[file] ?? "").replace(
					t.input.old_string,
					t.input.new_string,
				);
			if (t.name === "MultiEdit" && Array.isArray(t.input.edits))
				for (const e of t.input.edits as Record<string, string>[])
					finalTree[file] = (finalTree[file] ?? "").replace(
						e.old_string,
						e.new_string,
					);
			if (t.name === "Write" || t.name === "write_file")
				finalTree[file] = String(t.input.content);
			if (t.name === "apply_patch" && typeof t.input.input === "string")
				for (const match of (t.input.input as string).matchAll(
					/^\*\*\* Add File: \/work\/branch-fixture\/(.+)\n\+([^\n]*)/gm,
				))
					finalTree[match[1]!] = `${match[2]}\n`;
		}
		// Cases explicitly representing restoration have the base tree at commit.
		if (
			[
				"03-edit-revert",
				"04-checkout-restore",
				"05-stash-backtrack",
				"07-two-hypotheses",
				"15-reset-hard",
				"18-codex-patch-revert",
				"29-codex-single-revert",
			].includes(c.slug)
		)
			Object.assign(finalTree, baseTree);
		if (c.slug === "13-unparsed-write") finalTree["src/value.ts"] = "unknown";
		if (c.slug === "11-artifact-omits-edit") Object.assign(finalTree, baseTree);
		const commits: FixtureRepoCommit[] = [
			{ parent: null, message: `${repoName} base`, files: baseTree },
			{ parent: null, message: `${repoName} final`, files: finalTree },
		];
		commits[1]!.parent = gitCommitSha(commits[0]!);
		const hashes = fixtureRepoCommitShas(commits);
		const repo = { commits };
		await writeFile(
			join(dir, "repos", `${repoName}.json`),
			`${JSON.stringify(repo, null, 2)}\n`,
		);
		const message =
			c.claim === "missing" ? "external fixture result" : `${repoName} final`;
		const short =
			c.claim === "missing"
				? gitCommitSha({
						parent: hashes[0]!,
						message,
						files: baseTree,
					})
				: hashes[1]!;
		const addPath =
			c.slug === "11-artifact-omits-edit"
				? "git add -- src/other.ts"
				: "git add --all";
		const claim =
			c.claim === "none"
				? null
				: {
						short: short.slice(0, 7),
						message,
						command: `${addPath} && git commit --allow-empty -m '${message}'`,
					};
		const events = codex
			? codexEvents(c.tools, claim)
			: ccEvents(c.tools, claim);
		await writeFile(
			join(dir, `${c.slug}.jsonl`),
			events.map((e) => JSON.stringify(e)).join("\n") + "\n",
		);
		const prefix = codex ? "call_" : "toolu_";
		const excluded = new Set([
			...(c.abandoned ?? []),
			...(c.partial ?? []),
			...(c.unknown ?? []),
		]);
		const retained = [
			...new Set([
				...(c.retained ?? []),
				...Array.from(
					{ length: c.tools.length + (claim ? 1 : 0) },
					(_, n) => `${prefix}${n}`,
				).filter((id) => !excluded.has(id)),
			]),
		].sort(
			(a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)),
		);
		const labels = {
			repo: repoName,
			harness: codex ? "codex" : "claude-code",
			expected: {
				abandoned: c.abandoned ?? [],
				retained,
				...(c.partial ? { partial: c.partial } : {}),
				...(c.unknown ? { unknown: c.unknown } : {}),
				...(c.artifactOnly ? { artifactOnly: c.artifactOnly } : {}),
			},
			claim: {
				commitShort: c.claim === "none" ? null : short.slice(0, 7),
			},
			notes: c.notes,
		};
		await writeFile(
			join(dir, `${c.slug}.labels.json`),
			`${JSON.stringify(labels, null, 2)}\n`,
		);
	}
}

const outArg = process.argv.indexOf("--out");
const outRoot = outArg >= 0 ? resolve(process.argv[outArg + 1]!) : root;
await generate(outRoot);
