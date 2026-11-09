import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ATTR, type Step, type Trace } from "../src/core/types.ts";
import { traceDigest, type Manifest } from "../src/core/export/manifest.ts";

// An optional output root allows byte-for-byte regeneration in a temporary directory.
const root = resolve(process.argv[2] ?? ".");
const sessionDir = resolve(root, "fixtures/replay-sessions");
const misleadingDir = resolve(root, "fixtures/misleading-edits");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(misleadingDir, { recursive: true });
const save = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const slugs = ["parser", "timeline", "cache", "search", "routing", "render", "schema", "alerts", "review", "archive", "filter", "metrics", "sorting", "layout", "tokens", "index", "events", "labels", "history", "summary"];
for (let n = 0; n < slugs.length; n++) {
	const slug = `${String(n + 1).padStart(2, "0")}-${slugs[n]}`;
	const cwd = `/work/${slugs[n]}`;
	const steps: Step[] = [];
	function add(id: string, kind: Step["kind"], attributes: Step["attributes"] = {}, extra: Partial<Step> = {}) {
		const time = new Date(Date.UTC(2026, 0, 1, 0, 0, steps.length * 2)).toISOString();
		steps.push({ step_id: id, kind, started_at: time, ended_at: new Date(Date.parse(time) + 5000).toISOString(), status: "ok", attributes, ...extra });
	}
	const tool = (id: string, name: string, args: Record<string, unknown>, extra: Partial<Step> = {}) =>
		add(id, "tool_call", { [ATTR.TOOL_NAME]: name, [ATTR.TOOL_ARGS]: args }, extra);
	add("spawn-a", "agent", { [ATTR.AGENT_SPAWNS]: "worker-a" });
	add("spawn-b", "agent", { [ATTR.AGENT_SPAWNS]: "worker-b" });
	tool("a-read", "Read", { file_path: `${cwd}/src/a.ts` }, { subagent_id: "worker-a" });
	tool("b-read", "Read", { file_path: `${cwd}/src/b.ts` }, { subagent_id: "worker-b" });
	add("a-plan", "decision", {}, { subagent_id: "worker-a", caused_by: "a-read" });
	add("b-plan", "decision", {}, { subagent_id: "worker-b", caused_by: "a-plan" });
	add("a-done", "agent", {}, { subagent_id: "worker-a", caused_by: "a-plan" });
	add("b-done", "agent", {}, { subagent_id: "worker-b", caused_by: "b-plan" });
	add("consume-a", "decision", {}, { caused_by: "a-done" });
	add("consume-b", "decision", {}, { caused_by: "b-done" });
	add("gate", "hook", { [ATTR.HOOK_EVENT]: "PreToolUse", [ATTR.HOOK_VERDICT]: "allow" });
	tool("edit-a", "Edit", { file_path: `${cwd}/src/a.ts` }, { caused_by: "gate" });
	tool("edit-b", "Edit", { file_path: `${cwd}/src/b.ts` });
	tool("test", "Bash", { command: "pnpm test" }, { status: n % 2 === 0 ? "error" : "ok" });
	if (n % 2 === 0) {
		tool("fix", "Edit", { file_path: `${cwd}/src/a.ts` }, { caused_by: "test" });
		tool("retest", "Bash", { command: "pnpm test" }, { caused_by: "fix" });
	} else {
		add("review", "decision", {}, { caused_by: "test" });
		add("result", "llm", {}, { caused_by: "review" });
	}
	add("compact", "compaction", { [ATTR.COMPACT_REASON]: "context limit" });
	tool("parallel-a", "Read", { file_path: `${cwd}/docs/a.md` });
	tool("parallel-b", "Read", { file_path: `${cwd}/docs/b.md` });
	for (let i = 0; i < 17 + n % 5; i++) add(`note-${i}`, i % 3 === 0 ? "llm" : "decision");
	const trace: Trace = { plumbline_version: "1", run: { run_id: `fixture-${slug}`, harness: { name: "synthetic" }, started_at: steps[0]!.started_at, workspace: { cwd } }, steps };
	const manifest: Manifest = {
		version: 1, source: { runId: trace.run.run_id, stepCount: steps.length, digest: traceDigest(trace) }, title: `Replay ${slugs[n]}`,
		scenes: [
			{ id: "dispatch", range: { from: "spawn-a", to: "consume-a" }, steps: ["spawn-a", "spawn-b"] },
			{ id: "worker-a", range: { from: "a-read", to: "b-done" }, steps: ["a-read", "a-plan", "a-done"] },
			{ id: "worker-b", range: { from: "a-read", to: "b-done" }, steps: ["b-read", "b-plan", "b-done"] },
			{ id: "work", range: { from: "consume-a", to: "edit-b" }, steps: ["consume-a", "consume-b", "gate", "edit-a", "edit-b"] },
			{ id: "test", range: { from: "test", to: "test" }, steps: ["test"] },
			{ id: "finish", range: { from: n % 2 === 0 ? "fix" : "review", to: "parallel-b" }, steps: n % 2 === 0 ? ["fix", "retest", "compact", "parallel-a", "parallel-b"] : ["review", "result", "compact", "parallel-a", "parallel-b"] },
		],
		captions: [
			{ id: "dispatch-caption", sceneId: "dispatch", kind: "shows", text: "Two workers start.", refs: ["spawn-a", "spawn-b"] },
			{ id: "work-caption", sceneId: "work", kind: "because", text: "The recorded edits precede the test invocation.", cause: "edit-a", effect: "test" },
			{ id: "finish-caption", sceneId: "finish", kind: "shows", text: "The context is compacted.", refs: ["compact"] },
		],
	};
	save(`${sessionDir}/${slug}.trace.json`, trace);
	save(`${sessionDir}/${slug}.faithful.manifest.json`, manifest);
	function misleading(kind: string, reason: string, mutate: (copy: Manifest) => void) {
		const copy: Manifest = structuredClone(manifest);
		mutate(copy);
		save(`${misleadingDir}/${slug}.${kind}.manifest.json`, { ...copy, expect: { reason } });
	}
	misleading("reversed-cause-effect", "reversed-causal-order", (m) => {
		[m.scenes[3], m.scenes[4]] = [m.scenes[4]!, m.scenes[3]!];
	});
	misleading("dropped-prerequisite", "dropped-prerequisite", (m) => { m.scenes[3]!.steps = m.scenes[3]!.steps.filter((id) => id !== "edit-b"); });
	misleading("absent-event-caption", "caption-ref-absent", (m) => { m.captions.push({ id: "absent", sceneId: "finish", kind: "shows", text: "A later note appears.", refs: ["note-0"] }); });
	if (n < 10) misleading("unsupported-claim", "caption-unsupported-claim", (m) => { m.captions.push({ id: "unsupported", sceneId: "finish", kind: "because", text: "One independent read caused the other.", cause: "parallel-a", effect: "parallel-b" }); });
	if (n < 10) misleading("cross-subagent-reorder", "reversed-causal-order", (m) => { [m.scenes[1], m.scenes[2]] = [m.scenes[2]!, m.scenes[1]!]; });
}
