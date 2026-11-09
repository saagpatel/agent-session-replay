import assert from "node:assert/strict";
import test from "node:test";
import { ATTR, type Step } from "../types.ts";
import { buildBranchGraph } from "../diff/branch/model.ts";
import { parseClaudeCodeEvents } from "./claude-code.ts";
import { parseCodexEvents } from "./codex.ts";

const timestamp = "2026-01-01T00:00:00Z";
const header = "[main 1a2b3c4] fixture";
const event = (payload: unknown) => ({ timestamp, type: "response_item", payload });
const claim = (steps: Step[]) => steps.find((step) => step.kind === "tool_call")?.attributes[ATTR.GIT_COMMIT];

function claude(command: unknown, output = header, exitCode = 0) {
	return claim(parseClaudeCodeEvents([
		{ type: "assistant", sessionId: "fixture", uuid: "call", timestamp, message: { content: [{ type: "tool_use", id: "command", name: "Bash", input: { command } }] } },
		{ type: "user", sessionId: "fixture", uuid: "result", timestamp, message: { content: [{ type: "tool_result", tool_use_id: "command", content: output }] }, toolUseResult: { stdout: output, exitCode } },
	]).steps);
}

function codex(command: unknown, output = header, exitCode = 0) {
	return claim(parseCodexEvents([
		event({ type: "function_call", name: "exec_command", call_id: "command", arguments: JSON.stringify({ cmd: command }) }),
		event({ type: "function_call_output", call_id: "command", output: `Process exited with code ${exitCode}\nOutput:\n${output}` }),
	]).steps);
}

function exec(input: string, outputs = [{ exit_code: 0, output: header }], completed = true) {
	return claim(parseCodexEvents([
		event({ type: "function_call", name: "exec", call_id: "cell", arguments: JSON.stringify({ input }) }),
		event({ type: "function_call_output", call_id: "cell", output: [
			{ type: "text", text: completed ? "Script completed\n" : "Script failed\n" },
			...outputs.map((chunk, i) => ({ type: "text", text: JSON.stringify({ chunk_id: `chunk-${i}`, ...chunk }) })),
		] }),
	]).steps);
}

const negatives = [
	"printf '[main 1a2b3c4] old log line\\n'", "cat log.txt", "pnpm test", "git log",
	"git show", "git status", "git diff", "cat log.txt && git commit -m fixture",
	"git commit -m fixture; cat log.txt", "git commit -m fixture || true",
	"cd src && git commit -m fixture", "MODE=test git commit -m fixture",
	"git commit -m fixture > log.txt", "git add .; git commit -m fixture",
	"git add . && git commit -m fixture && cat log.txt", "git log --format='[main 1a2b3c4] fixture'",
];

test("plausible commit headers require literal commit commands in both parsers and exec cells", () => {
	for (const command of negatives) {
		assert.equal(claude(command), undefined, `Claude: ${command}`);
		assert.equal(codex(command), undefined, `Codex: ${command}`);
		assert.equal(exec(`text(await tools.exec_command(${JSON.stringify({ cmd: command })}))`), undefined, `exec: ${command}`);
	}
});

test("commit claims accept only successful literal commits and add/commit chains", () => {
	for (const command of ["git commit -am fixture", "git add --all && git commit -m fixture"]) {
		assert.deepEqual(claude(command), { branch: "main", short: "1a2b3c4" });
		assert.deepEqual(codex(command), { branch: "main", short: "1a2b3c4" });
		assert.equal(claude(command, header, 1), undefined);
		assert.equal(codex(command, header, 1), undefined);
	}
	const argv = ["bash", "-lc", "git commit -m fixture"];
	assert.equal(claude(argv), undefined);
	assert.equal(codex(argv), undefined);
	const multipleHeaders = `${header}\n[other 5d6e7f8] later`;
	assert.equal(claude("git commit -m fixture", multipleHeaders), undefined);
	assert.equal(codex("git commit -m fixture", multipleHeaders), undefined);
	for (const command of ["git commit -m fixture", "git add . && git commit -m fixture"]) {
		const input = `text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: "/work/fixture" })}))`;
		assert.deepEqual(exec(input), { branch: "main", short: "1a2b3c4" });
		assert.equal(exec(input, [{ exit_code: 1, output: header }]), undefined);
		assert.equal(exec(input, [{ exit_code: 0, output: "no commit header" }]), undefined);
		assert.equal(exec(input, undefined, false), undefined);
	}
});

test("exec commit evidence is bound to its own literal call and output", () => {
	const read = 'text(await tools.exec_command({cmd:"cat log.txt"}));';
	const commit = 'const result = await tools.exec_command({cmd:"git commit -m fixture"}); text(result);';
	assert.equal(exec(read + commit, [{ exit_code: 0, output: header }, { exit_code: 0, output: "no commit header" }]), undefined);
	assert.equal(exec(read + commit, [{ exit_code: 0, output: header }, { exit_code: 1, output: header }]), undefined);
	assert.deepEqual(exec(read + commit, [{ exit_code: 0, output: "read" }, { exit_code: 0, output: header }]), { branch: "main", short: "1a2b3c4" });
	assert.equal(exec(`if (true) { ${commit} }`), undefined);
	assert.equal(exec(commit + 'text("extra")'), undefined);
	assert.equal(exec('text(await tools.exec_command({cmd:"git commit -m fixture",workdir}))'), undefined);
	assert.equal(exec('text(await tools.exec_command({cmd:"git commit -m fixture",foo:mutate()}))'), undefined);
});

test("branch claims stop at the exec call that actually produced the commit header", () => {
	const input = 'text(await tools.write_file({path:"src/a.ts",content:"idea\\n"})); text(await tools.exec_command({cmd:"git commit -m fixture"})); text(await tools.write_file({path:"src/later.ts",content:"later\\n"}));';
	const trace = parseCodexEvents([
		{ timestamp, type: "session_meta", payload: { id: "fixture", cwd: "/work/fixture" } },
		event({ type: "function_call", name: "exec", call_id: "cell", arguments: JSON.stringify({ input }) }),
		event({ type: "function_call_output", call_id: "cell", output: [
			{ type: "text", text: "Script completed\n" },
			{ type: "text", text: "{}" },
			{ type: "text", text: JSON.stringify({ chunk_id: "commit", exit_code: 0, output: header }) },
			{ type: "text", text: "{}" },
		] }),
	]);
	assert.equal(trace.steps[0].attributes[ATTR.GIT_COMMIT_CALL], 1);
	const graph = buildBranchGraph(trace, { "src/a.ts": "base\n" });
	assert.deepEqual(graph.claim.files, ["src/a.ts"]);
	assert.equal(graph.claim.commitShort, "1a2b3c4");
	assert.equal(graph.endState["src/later.ts"], "later\n");
});
