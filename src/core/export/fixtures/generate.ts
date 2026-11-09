import { ATTR, type Step, type Trace } from "../../types.ts";
import { traceDigest, type Manifest } from "../manifest.ts";

export interface GeneratedReplayFixtures {
	sessions: { slug: string; trace: Trace; faithful: Manifest }[];
	misleading: { slug: string; kind: string; manifest: Manifest; expect: { reason: string } }[];
}

export function generateReplayFixtures(): GeneratedReplayFixtures {
	const sessions: GeneratedReplayFixtures["sessions"] = [];
	const misleading: GeneratedReplayFixtures["misleading"] = [];
	const slugs = ["parser", "timeline", "cache", "search", "routing", "render", "schema", "alerts", "review", "archive", "filter", "metrics", "sorting", "layout", "tokens", "index", "events", "labels", "history", "summary"];
	for (let n = 0; n < slugs.length; n++) {
		const slug = `${String(n + 1).padStart(2, "0")}-${slugs[n]}`;
		const cwd = `/work/${slugs[n]}`;
		const workerCount = 2 + n % 3;
		const cycleCount = 1 + n % 4;
		const fanout = 2 + n % 3;
		const hookAt = n % 3; // Before dispatch, among worker phases, or before edits.
		const compactAt = n % 4;
		const steps: Step[] = [];
		function add(id: string, kind: Step["kind"], attributes: Step["attributes"] = {}, extra: Partial<Step> = {}) {
			const time = new Date(Date.UTC(2026, 0, 1, 0, 0, steps.length * 2)).toISOString();
			steps.push({ step_id: id, kind, started_at: time, ended_at: new Date(Date.parse(time) + 5000).toISOString(), status: "ok", attributes, ...extra });
		}
		const tool = (id: string, name: string, args: Record<string, unknown>, extra: Partial<Step> = {}) =>
			add(id, "tool_call", { [ATTR.TOOL_NAME]: name, [ATTR.TOOL_ARGS]: args }, extra);
		const workerId = (index: number) => `worker-${String.fromCharCode(97 + index)}`;
		const workerSteps = new Map<string, string[]>();
		const addHook = () => add("gate", "hook", { [ATTR.HOOK_EVENT]: "PreToolUse", [ATTR.HOOK_VERDICT]: "allow" });
		const addCompact = () => add("compact", "compaction", { [ATTR.COMPACT_REASON]: "context limit" });
		if (hookAt === 0) addHook();
		for (let i = 0; i < workerCount; i++) add(`spawn-${String.fromCharCode(97 + i)}`, "agent", { [ATTR.AGENT_SPAWNS]: workerId(i) }, hookAt === 0 && i === 0 ? { caused_by: "gate" } : {});
		// Vary worker visitation order between phases to diversify interleaving while
		// keeping each worker's read, plan, completion, and consumption causal chain.
		for (let phase = 0; phase < 4; phase++) {
			const order = n % 2 === 0 ? [...Array(workerCount).keys()] : [...Array(workerCount).keys()].reverse();
			if (phase === 1) order.sort((a, b) => a - b);
			for (const i of (n % 3 === 0 && phase === 3 ? order.reverse() : order)) {
				const agent = workerId(i);
				const ids = workerSteps.get(agent) ?? [];
				const suffix = String.fromCharCode(97 + i);
				if (phase === 0) tool(`${suffix}-read`, "Read", { file_path: `${cwd}/src/${suffix}.ts` }, { subagent_id: agent });
				else if (phase === 1) add(`${suffix}-plan`, "decision", {}, { subagent_id: agent, caused_by: i === 1 ? "a-plan" : `${suffix}-read` });
				else if (phase === 2) add(`${suffix}-done`, "agent", {}, { subagent_id: agent, caused_by: `${suffix}-plan` });
				else add(`consume-${suffix}`, "decision", {}, { caused_by: `${suffix}-done` });
				ids.push(phase === 3 ? `consume-${suffix}` : `${suffix}-${["read", "plan", "done"][phase]}`);
				workerSteps.set(agent, ids);
			}
			if (phase === 1 && hookAt === 2) addHook();
		}
		if (hookAt === 1) addHook();
		tool("edit-a", "Edit", { file_path: `${cwd}/src/a.ts` }, { caused_by: "gate" });
		tool("edit-b", "Edit", { file_path: `${cwd}/src/b.ts` });
		tool("test", "Bash", { command: "pnpm test" }, { status: n % 2 === 0 ? "error" : "ok" });
		if (n >= 17) tool("unresolved-shell", "Bash", { command: "echo refreshed > src/cache.ts" });
		for (let cycle = 1; cycle < cycleCount; cycle++) {
			const editId = cycle === 1 ? "fix" : `fix-${cycle}`;
			tool(editId, "Edit", { file_path: `${cwd}/src/${cycle % 2 === 0 ? "b" : "a"}.ts` }, { caused_by: cycle === 1 ? "test" : `retest-${cycle - 1}` });
			tool(`retest-${cycle}`, "Bash", { command: "pnpm test" }, { caused_by: editId });
		}
		if (cycleCount === 1) {
			add("review", "decision", {}, { caused_by: "test" });
			add("result", "llm", {}, { caused_by: "review" });
		}
		const finishStart = cycleCount > 1 ? "fix" : "review";
		addCompact();
		const parallelIds: string[] = [];
		for (let i = 0; i < fanout; i++) {
			const id = `parallel-${String.fromCharCode(97 + i)}`;
			parallelIds.push(id);
			tool(id, "Read", { file_path: `${cwd}/docs/${String.fromCharCode(97 + i)}.md` });
		}
		const [compact] = steps.splice(steps.findIndex((step) => step.step_id === "compact"), 1);
		const finishIndex = steps.findIndex((step) => step.step_id === finishStart);
		const parallelEnd = steps.findIndex((step) => step.step_id === parallelIds.at(-1));
		// Keep compaction within the finish scene while moving its position.
		steps.splice(finishIndex + Math.floor((parallelEnd - finishIndex) * compactAt / 4), 0, compact!);
		for (let i = 0; i < 17 + n % 5; i++) add(`note-${i}`, i % 3 === 0 ? "llm" : "decision");
		steps.forEach((step, index) => {
			const time = new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString();
			step.started_at = time;
			// Sequential edit/test cycles finish before the next invocation; only
			// the explicitly parallel reads retain overlapping intervals.
			step.ended_at = new Date(Date.parse(time) + (step.step_id.startsWith("parallel-") ? 20000 : 1000)).toISOString();
		});
		// Each synthetic Agent result returns after all of its child's steps end.
		for (const spawn of steps.filter((step) => step.attributes[ATTR.AGENT_SPAWNS])) {
			const child = spawn.attributes[ATTR.AGENT_SPAWNS];
			spawn.attributes[ATTR.CLAUDE_AGENT_RESULT_KIND] = "completed";
			spawn.ended_at = new Date(Math.max(...steps.filter((step) => step.subagent_id === child)
				.map((step) => Date.parse(step.ended_at!)))).toISOString();
		}
		const trace: Trace = { plumbline_version: "1", run: { run_id: `fixture-${slug}`, harness: { name: "synthetic" }, started_at: steps[0]!.started_at, workspace: { cwd } }, steps };
		const lastConsumer = trace.steps.filter((step) => /^consume-/.test(step.step_id)).at(-1)!.step_id;
		const firstConsumer = trace.steps.find((step) => /^consume-/.test(step.step_id))!.step_id;
		const firstWorkerRead = trace.steps.find((step) => /^[a-z]-read$/.test(step.step_id))!.step_id;
		const finishIds = new Set([finishStart, "fix", "review", "result", "compact", ...parallelIds]);
		if (n >= 17) finishIds.add("unresolved-shell");
		for (let cycle = 1; cycle < cycleCount; cycle++) {
			finishIds.add(cycle === 1 ? "fix" : `fix-${cycle}`);
			finishIds.add(`retest-${cycle}`);
		}
		const finishSteps = trace.steps.filter((step) => finishIds.has(step.step_id)).map((step) => step.step_id);
		const manifest: Manifest = {
			version: 1, source: { runId: trace.run.run_id, stepCount: steps.length, digest: traceDigest(trace) }, title: `Replay ${slugs[n]}`,
			scenes: [
				{ id: "dispatch", range: { from: "spawn-a", to: lastConsumer }, steps: trace.steps.filter((step) => /^spawn-/.test(step.step_id)).map((step) => step.step_id) },
				{ id: "worker-a", range: { from: firstWorkerRead, to: lastConsumer }, steps: workerSteps.get("worker-a")!.slice(0, 3) },
				{ id: "worker-b", range: { from: firstWorkerRead, to: lastConsumer }, steps: workerSteps.get("worker-b")!.slice(0, 3) },
				{ id: "work", range: { from: firstConsumer, to: "edit-b" }, steps: ["consume-a", "consume-b", ...(hookAt === 1 ? ["gate"] : []), "edit-a", "edit-b"] },
				{ id: "test", range: { from: "test", to: "test" }, steps: ["test"] },
				{ id: "finish", range: { from: finishSteps[0]!, to: parallelIds.at(-1)! }, steps: finishSteps },
			],
			captions: [
				{ id: "dispatch-caption", sceneId: "dispatch", kind: "shows", text: `${workerCount} workers start.`, refs: ["spawn-a", "spawn-b"] },
				{ id: "work-caption", sceneId: "work", kind: "because", text: "The recorded edits precede the test invocation.", cause: "edit-a", effect: "test" },
				{ id: "finish-caption", sceneId: "finish", kind: "shows", text: "The context is compacted.", refs: ["compact"] },
			],
		};
		sessions.push({ slug, trace, faithful: manifest });
		function addMisleading(kind: string, reason: string, mutate: (copy: Manifest) => void) {
			const copy: Manifest = structuredClone(manifest);
			mutate(copy);
			misleading.push({ slug, kind, manifest: copy, expect: { reason } });
		}
		addMisleading("reversed-cause-effect", "reversed-causal-order", (m) => {
			[m.scenes[3], m.scenes[4]] = [m.scenes[4]!, m.scenes[3]!];
		});
		addMisleading("dropped-prerequisite", "dropped-prerequisite", (m) => { m.scenes[3]!.steps = m.scenes[3]!.steps.filter((id) => id !== "edit-b"); });
		addMisleading("absent-event-caption", "caption-ref-absent", (m) => { m.captions.push({ id: "absent", sceneId: "finish", kind: "shows", text: "A later note appears.", refs: ["note-0"] }); });
		if (n < 10) addMisleading("unsupported-claim", "caption-unsupported-claim", (m) => { m.captions.push({ id: "unsupported", sceneId: "finish", kind: "because", text: "One independent read caused the other.", cause: "parallel-a", effect: "parallel-b" }); });
		if (n < 10) addMisleading("cross-subagent-reorder", "reversed-causal-order", (m) => { [m.scenes[1], m.scenes[2]] = [m.scenes[2]!, m.scenes[1]!]; });
		if (n >= 17) addMisleading("unresolved-reorder", "unresolved-operation", (m) => {
			m.scenes[5]!.steps = [...m.scenes[5]!.steps.filter((id) => id !== "unresolved-shell"), "unresolved-shell"];
		});
	}
	return { sessions, misleading };
}
