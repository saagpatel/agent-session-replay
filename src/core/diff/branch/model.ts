/** Evidence-only branch reconstruction; no filesystem access or execution. */
import { ATTR, type ExecPart, type Trace } from "../../types.ts";
import { shellCommand, shellEvidence, type ShellEvidence } from "../../shell-evidence.ts";
import {
	classifyCommand,
	literalExecCalls,
	normalizeTrace,
	splitStages,
} from "../normalize.ts";
import type { DiffAction, DiffStatus } from "../types.ts";
import { lineagePath, workingDirectory } from "./path.ts";
import type {
	Branch,
	BranchGraph,
	BranchNode,
	EditEffect,
	FileSnapshot,
	NodeRef,
} from "./types.ts";

type Json = Record<string, unknown>;
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "TodoWrite", "read_file"]);
const SHELL_TOOLS = new Set(["Bash", "bash", "shell", "local_shell", "local_shell_call", "exec_command"]);
const obj = (v: unknown): Json =>
	typeof v === "object" && v !== null ? (v as Json) : {};
const str = (v: unknown): string | undefined =>
	typeof v === "string" ? v : undefined;
const ref = (n: NodeRef): NodeRef => ({ stepId: n.stepId, part: n.part });
const key = (n: NodeRef): string => JSON.stringify([n.stepId, n.part]);
interface Operation {
	node: BranchNode;
	args: Json;
	name: string;
	command?: string;
	evidence?: ShellEvidence;
	call?: number;
	unparsed?: string;
	patch?: string;
	directory?: string | null;
}
interface FileState {
	text: string;
	owners: Array<string | null>;
}
interface Effect extends EditEffect {
	total: number;
	applied: boolean;
}

function operations(trace: Trace): Operation[] {
	const out: Operation[] = [];
	// Label each context separately, so sidechains cannot change main-run labels.
	const labels = normalizeTrace(trace);
	const contexts = new Set(
		trace.steps.map((s) => s.subagent_id).filter((id) => id),
	);
	for (const id of contexts)
		labels.push(
			...normalizeTrace({
				...trace,
				steps: trace.steps
					.filter((s) => s.subagent_id === id)
					.map((s) => ({ ...s, subagent_id: null })),
			}),
		);
	const cwd = trace.run.workspace?.cwd;
	for (const step of trace.steps) {
		const own = labels.filter((n) => n.stepId === step.step_id);
		if (step.kind === "llm") continue;
		const name = str(step.attributes[ATTR.TOOL_NAME]) ?? "";
		const args = obj(step.attributes[ATTR.TOOL_ARGS]);
		const directory = workingDirectory(cwd, args);
		const settled =
			Boolean(step.ended_at) ||
			step.status === "error" ||
			step.status === "interrupted";
		const status: DiffStatus = settled ? (step.status ?? "ok") : "unknown";
		let part = 0;
		const add = (
			action: DiffAction,
			target: string | null,
			extra: Partial<Operation> = {},
			result = status,
		) => {
			out.push({
				name,
				args,
				directory,
				...extra,
				node: {
					stepId: step.step_id,
					part: part++,
					index: out.length,
					branchId: "main",
					action,
					target,
					status: result,
				},
			});
		};
		if (name === "exec") {
			const calls = literalExecCalls(str(args["input"]) ?? "");
			if (!calls) {
				for (const label of own.length ? own : [{ action: "run" as const, target: "exec", status }])
					add(label.action, label.target, { unparsed: "exec cell" }, label.status);
			} else {
				const parts = step.attributes[ATTR.EXEC_PARTS] as ExecPart[] | undefined;
				const complete = step.attributes[ATTR.EXEC_COMPLETED] === true && parts?.length === calls.length;
				for (const [i, call] of calls.entries()) {
					const result = complete ? parts?.[i] : undefined;
					const chunk = result?.kind === "chunk" ? result.result : undefined;
					const known = chunk?.exit_code !== null && chunk?.exit_code !== undefined;
					const patchOK = call.name === "apply_patch" && result?.kind === "empty-object";
					const toolOK = !["exec_command", "apply_patch"].includes(call.name) && result && !(result.kind === "other" && result.error);
					const child = operations({ ...trace, steps: [{
						...step,
						ended_at: known || patchOK || toolOK ? step.ended_at : null,
						status: known && chunk?.exit_code !== 0 ? "error" : "ok",
						attributes: {
							[ATTR.TOOL_NAME]: call.name,
							[ATTR.TOOL_ARGS]: call.name === "exec_command"
								? { cmd: call.command, ...(call.workdir === undefined ? {} : { workdir: call.workdir }) }
								: call.name === "apply_patch" ? { input: call.patch } : { path: call.path, content: call.content },
							[ATTR.PATCH_CONFIRMED]: patchOK,
							...(chunk ? { [ATTR.EXEC_RESULTS]: [chunk] } : {}),
						},
					}] });
					for (const op of child)
						out.push({ ...op, call: i, node: { ...op.node, part: part++, index: out.length } });
				}
			}
			continue;
		}
		const file = str(args["file_path"]) ?? str(args["path"]);
		if (name === "MultiEdit") {
			const edits =
				Array.isArray(args["edits"]) && args["edits"].length
					? args["edits"]
					: [{}];
			for (const edit of edits)
				add("edit", file ? lineagePath(file, cwd, directory) : null, { args: obj(edit) });
		} else if (["Edit", "Write", "write_file"].includes(name)) {
			add(
				name === "write_file"
					? "write"
					: (own[0]?.action ?? (name === "Edit" ? "edit" : "write")),
				file ? lineagePath(file, cwd, directory) : null,
			);
		} else if (name === "apply_patch") {
			const patch = str(args["input"]) ?? str(args["patch"]) ?? "";
			const sections = patch
				.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m)
				.filter((p) => /^\*\*\* (?:Add|Update|Delete) File: /m.test(p));
			for (const p of sections.length ? sections : [patch]) {
				const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/m.exec(p);
				const target = m?.[2] ? lineagePath(m[2], cwd, directory) : null;
				add(
					own.find((n) => n.target === target)?.action ??
						(m?.[1] === "Add" ? "write" : "edit"),
					target,
					{ patch: p },
					status === "ok" && step.attributes[ATTR.PATCH_CONFIRMED] !== true
						? "unknown"
						: status,
				);
			}
		} else if (shellCommand(args) !== undefined) {
			const fullCommand = shellCommand(args) as string;
			const allowed = shellEvidence(fullCommand);
			const invalidArgs = (args["env"] && Object.keys(Object(args["env"])).length) ||
				["workdir", "working_directory", "cwd"].some((key) => key in args && typeof args[key] !== "string");
			const unparsed = !SHELL_TOOLS.has(name) || !allowed || invalidArgs ? fullCommand || name || "empty shell command" : undefined;
			const stages = splitStages(fullCommand);
			if (!stages.length) stages.push(fullCommand);
			const consumed = new Set<number>();
			const directoryStages: string[] = [];
			const workdir =
				str(args["workdir"]) ??
				str(args["working_directory"]) ??
				str(args["cwd"]);
			if (workdir !== undefined)
				directoryStages.push(`cd ${JSON.stringify(workdir)}`);
			for (const stage of stages) {
				const classes = classifyCommand(
					[...directoryStages, stage].join(" && "),
					cwd,
				);
				for (const c of classes.length
					? classes
					: [{ action: "other" as const, target: stage }]) {
					const sameAction = (action: DiffAction) =>
						action === c.action || (c.action === "write" && action === "edit");
					let at = own.findIndex(
						(l, i) =>
							!consumed.has(i) && sameAction(l.action) && l.target === c.target,
					);
					if (at < 0 && c.target)
						at = own.findIndex(
							(l, i) =>
								!consumed.has(i) &&
								sameAction(l.action) &&
								Boolean(l.target?.endsWith(`/${c.target}`)),
						);
					if (at >= 0) consumed.add(at);
					add(
						own[at]?.action ?? c.action,
						at >= 0 ? (own[at]?.target ?? null) : c.target,
						{ command: stage, evidence: shellEvidence(stage) ?? undefined, unparsed },
						own[at]?.status ?? (stages.length === 1 ? status : "unknown"),
					);
				}
				if (/^\s*cd\s/.test(stage)) directoryStages.push(stage);
			}
			for (let i = 0; i < own.length; i++) {
				const label = own[i];
				if (!consumed.has(i) && label)
					add(label.action, label.target, { unparsed }, label.status);
			}
		} else if (own.length) {
			for (const label of own)
				add(label.action, label.target, { unparsed: READ_TOOLS.has(name) ? undefined : name || "unknown tool" }, label.status);
		} else if (step.kind === "tool_call" || step.kind === "agent") {
			add("other", name || null, { unparsed: READ_TOOLS.has(name) ? undefined : name || "unknown tool" });
		}
	}
	return out;
}

/** Track character origins, not matching substrings in the final file. */
export function buildBranchGraph(
	trace: Trace,
	base: FileSnapshot,
): BranchGraph {
	const ops = operations(trace);
	const files = new Map<string, FileState>();
	const unknown = new Set<string>();
	for (const [file, text] of Object.entries(base)) {
		if (text === null) unknown.add(file);
		else
			files.set(file, {
				text,
				owners: Array<string | null>(text.length).fill(null),
			});
	}
	const effects: Effect[] = [];
	const backtracks: Array<{ at: BranchNode; undone: Set<string> }> = [];
	const oldTexts = new Map<string, Set<string>>();
	const removedAt = new Map<string, BranchNode>();
	let headChanged = false;
	let indexChanged = false;
	let endStateComplete = true;
	const unparsedReasons = new Set<string>();
	let claim: BranchGraph["claim"] = {
		commitShort: null,
		stepId: null,
		part: null,
		tree: null,
		files: [],
	};
	const touched = new Set<string>();
	const claimedSteps = new Set<string>();
	const invalidate = (file: string) => {
		unknown.add(file);
		touched.add(file);
	};
	const invalidateTree = () => {
		endStateComplete = false;
		for (const path of new Set([
			...Object.keys(base),
			...files.keys(),
			...touched,
		]))
			invalidate(path);
	};
	const effectFor = (op: Operation, file: string): Effect => {
		const effect: Effect = {
			node: ref(op.node),
			file,
			introducedSpans: [],
			payload: null,
			lineage: "unknown",
			endState: {},
			total: 0,
			applied: false,
		};
		effects.push(effect);
		touched.add(file);
		return effect;
	};
	const splice = (
		state: FileState,
		at: number,
		length: number,
		text: string,
		effect: Effect,
	): Set<string> => {
		const removed = state.text.slice(at, at + length);
		if (!effect.payload) effect.payload = { inserted: [], removed: [] };
		if (removed) effect.payload.removed.push(removed);
		if (text) effect.payload.inserted.push(text);
		const undone = new Set(
			state.owners
				.slice(at, at + length)
				.filter((o): o is string => o !== null),
		);
		for (const owner of undone) {
			const node = ops.find((o) => key(o.node) === key(effect.node))?.node;
			if (node) removedAt.set(owner, node);
		}
		state.text = state.text.slice(0, at) + text + state.text.slice(at + length);
		state.owners = state.owners
			.slice(0, at)
			.concat(
				Array<string>(text.length).fill(key(effect.node)),
				state.owners.slice(at + length),
			);
		for (const span of effect.introducedSpans) {
			if (span.start >= at + length) {
				span.start += text.length - length;
				span.end += text.length - length;
			}
		}
		if (text.length)
			effect.introducedSpans.push({ start: at, end: at + text.length, text });
		effect.total += text.length;
		effect.applied = true;
		return undone;
	};
	const applyEdit = (op: Operation, file: string): void => {
		const effect = effectFor(op, file);
		if (file.startsWith("external:")) {
			invalidate(file);
			return;
		}
		if (op.node.status === "error" || op.node.status === "interrupted") {
			effect.lineage = "abandoned";
			return;
		}
		if (op.node.status !== "ok" || unknown.has(file) || !endStateComplete) {
			invalidate(file);
			return;
		}
		const state = files.get(file) ?? { text: "", owners: [] };
		const write = op.name === "Write" || op.name === "write_file";
		const old = write ? state.text : str(op.args["old_string"]);
		const text = write ? str(op.args["content"]) : str(op.args["new_string"]);
		if (old === undefined || text === undefined || (!write && !old)) {
			invalidate(file);
			return;
		}
		// A no-op has no introduced span and must not steal the earlier edit's owners.
		if (old === text && (!write || files.has(file))) return;
		const positions: number[] = [];
		if (write) positions.push(0);
		else
			for (
				let at = state.text.indexOf(old);
				at >= 0;
				at = state.text.indexOf(old, at + old.length)
			)
				positions.push(at);
		if (
			!positions.length ||
			(op.args["replace_all"] !== true && positions.length !== 1)
		) {
			invalidate(file);
			return;
		}
		const undone = new Set<string>();
		const prior = oldTexts.get(file) ?? new Set<string>();
		const restoring = old !== text && prior.has(text);
		prior.add(old);
		oldTexts.set(file, prior);
		for (const at of [...positions].reverse())
			for (const owner of splice(state, at, old.length, text, effect))
				undone.add(owner);
		files.set(file, state);
		if (restoring && undone.size) backtracks.push({ at: op.node, undone });
	};
	const applyPatch = (op: Operation, file: string): void => {
		const effect = effectFor(op, file);
		const movePath = /^\*\*\* Move to: (.+)$/m.exec(op.patch ?? "")?.[1];
		const move = movePath ? lineagePath(movePath, trace.run.workspace?.cwd, op.directory) : undefined;
		if (file.startsWith("external:") || move?.startsWith("external:") || (movePath && !move)) {
			invalidate(file);
			if (move) invalidate(move);
			return;
		}
		if (op.node.status === "error" || op.node.status === "interrupted") {
			effect.lineage = "abandoned";
			return;
		}
		if (op.node.status !== "ok" || unknown.has(file) || !endStateComplete) {
			invalidate(file);
			if (move) invalidate(move);
			return;
		}
		const patch = op.patch as string;
		const body = patch
			.split("\n")
			.slice(1)
			.filter((l) => !l.startsWith("*** End Patch") && !l.startsWith("*** Move to:"));
		if (move && (files.has(move) || unknown.has(move))) {
			invalidate(file);
			invalidate(move);
			return;
		}
		// Keep both destinations uncertain if any hunk cannot be reconstructed.
		if (move) invalidate(move);
		if (patch.startsWith("*** Add File:")) {
			if (files.has(file) || body.some((l) => l && !l.startsWith("+"))) {
				invalidate(file);
				return;
			}
			const state: FileState = { text: "", owners: [] };
			const lines = body
				.filter((l) => l.startsWith("+"))
				.map((l) => l.slice(1));
			splice(state, 0, 0, lines.length ? lines.join("\n") + "\n" : "", effect);
			files.set(file, state);
			return;
		}
		if (patch.startsWith("*** Delete File:")) {
			if (!files.has(file)) {
				invalidate(file);
				return;
			}
			for (const owner of files.get(file)?.owners ?? [])
				if (owner) removedAt.set(owner, op.node);
			effect.applied = true;
			files.delete(file);
			return;
		}
		const original = files.get(file);
		if (!original) {
			invalidate(file);
			return;
		}
		const state: FileState = {
			text: original.text,
			owners: [...original.owners],
		};
		const hunks = body
			.join("\n")
			.split(/^@@[^\n]*\n/m)
			.filter((h) => h.trim());
		let cursor = 0;
		for (const hunk of hunks) {
			const lines = hunk
				.split("\n")
				.filter((l) => l !== "" && l !== "*** End of File");
			if (!lines.length || lines.some((l) => !/^[ +\-]/.test(l))) {
				invalidate(file);
				return;
			}
			const old =
				lines
					.filter((l) => l[0] !== "+")
					.map((l) => l.slice(1))
					.join("\n") + "\n";
			const at = state.text.indexOf(old, cursor);
			if (at < 0 || state.text.indexOf(old, at + 1) >= 0) {
				invalidate(file);
				return;
			}
			let pos = at;
			// Context lines keep their original owners; only '+' lines introduce text.
			for (const line of lines) {
				const text = line.slice(1) + "\n";
				if (line[0] === " ") pos += text.length;
				else if (line[0] === "-") splice(state, pos, text.length, "", effect);
				else {
					splice(state, pos, 0, text, effect);
					pos += text.length;
				}
			}
			cursor = pos;
		}
		if (!hunks.length && !move) {
			invalidate(file);
			return;
		}
		if (move) {
			files.delete(file);
			unknown.delete(move);
			effect.file = move;
		}
		files.set(move ?? file, state);
	};
	for (const op of ops) {
		const { node, name } = op;
		const file = node.target;
		const before = file ? files.get(file)?.text : undefined;
		const beforeOwners = file ? (files.get(file)?.owners ?? []) : [];
		if (op.unparsed) {
			unparsedReasons.add(`Unparsed writer: ${op.unparsed}.`);
			invalidateTree();
		} else if ((op.patch !== undefined || ["Edit", "MultiEdit", "Write", "write_file"].includes(name)) && !file) {
			// Preserve the operation as unknown without inventing a repository path.
			effectFor(op, `unknown:${key(node)}`);
			invalidateTree();
		} else if (op.patch !== undefined && file) applyPatch(op, file);
		else if (
			["Edit", "MultiEdit", "Write", "write_file"].includes(name) &&
			file
		)
			applyEdit(op, file);
		else if (op.command) {
			const evidence = op.evidence;
			const location = lineagePath(".", trace.run.workspace?.cwd, op.directory);
			if (!location) invalidateTree();
			// A command in another directory cannot restore or claim this repository.
			if (!location || location.startsWith("external:")) continue;
			if (evidence?.staged) indexChanged = true;
			const restore = evidence?.kind === "restore" ? evidence.paths : undefined;
			const whole = evidence?.kind === "whole-restore";
			if (restore || whole) {
				const paths = restore
					? restore
					: [...new Set([...Object.keys(base), ...files.keys(), ...touched])];
				const undone = new Set<string>();
				const resolved: string[] = [];
				for (const raw of paths) {
					const target = whole
						? raw
						: lineagePath(raw, trace.run.workspace?.cwd, op.directory);
					if (!target) {
						for (const path of new Set([
							...Object.keys(base),
							...files.keys(),
							...touched,
						]))
							invalidate(path);
						continue;
					}
					const children = Object.keys(base).filter(
						(p) => target === "." || p.startsWith(`${target}/`),
					);
					resolved.push(...(children.length ? children : [target]));
				}
				for (const p of new Set(resolved)) {
					for (const owner of files.get(p)?.owners ?? [])
						if (owner) undone.add(owner);
					touched.add(p);
					if (
						node.status !== "ok" ||
						headChanged ||
						indexChanged ||
						unknown.has(p)
					) {
						invalidate(p);
						continue;
					}
					const original = Object.hasOwn(base, p) ? base[p] : undefined;
					if (original === null || original === undefined) invalidate(p);
					else {
						for (const owner of files.get(p)?.owners ?? [])
							if (owner) removedAt.set(owner, node);
						files.set(p, {
							text: original,
							owners: Array<string | null>(original.length).fill(null),
						});
					}
				}
				if (
					undone.size &&
					node.status === "ok" &&
					!headChanged &&
					!indexChanged
				)
					backtracks.push({ at: node, undone });
			} else if (evidence?.kind === "move") {
				const [source, destination] = (evidence.paths ?? []).map((path) => lineagePath(path, trace.run.workspace?.cwd, op.directory));
				// Only a proven single-file move to an absent literal path preserves owners.
				if (!source || !destination || source.startsWith("external:") || destination.startsWith("external:") ||
					node.status !== "ok" || !endStateComplete || unknown.has(source) || unknown.has(destination) ||
					!files.has(source) || files.has(destination) ||
					[...files.keys(), ...unknown].some((path) => path.startsWith(`${destination}/`) || destination.startsWith(`${path}/`))) {
					invalidateTree();
				} else {
					files.set(destination, files.get(source)!);
					files.delete(source);
					touched.add(source);
					touched.add(destination);
					indexChanged = true;
				}
			} else if (evidence?.kind === "add") indexChanged = true;
		} else if (!READ_TOOLS.has(name)) {
			unparsedReasons.add(`Unparsed writer: ${name || "unknown tool"}.`);
			invalidateTree();
		}

		if (file && before !== undefined && !unknown.has(file)) {
			const prior = oldTexts.get(file) ?? new Set<string>();
			const after = files.get(file)?.text;
			if (after !== undefined && before !== after && prior.has(after)) {
				const survivors = new Set(files.get(file)?.owners);
				const undone = new Set(
					beforeOwners.filter(
						(owner): owner is string => owner !== null && !survivors.has(owner),
					),
				);
				if (undone.size && !backtracks.some((b) => key(b.at) === key(node)))
					backtracks.push({ at: node, undone });
			}
			prior.add(before);
			oldTexts.set(file, prior);
		}
		const step = trace.steps.find((s) => s.step_id === node.stepId);
		const git = obj(step?.attributes[ATTR.GIT_COMMIT]);
		if (typeof git["short"] === "string" && !claimedSteps.has(node.stepId) &&
			op.evidence?.kind === "commit" && !op.unparsed && node.status === "ok" &&
			(op.call === undefined || op.call === step?.attributes[ATTR.GIT_COMMIT_CALL])) {
			claim = {
				commitShort: git["short"],
				stepId: node.stepId,
				part: node.part,
				tree: Object.fromEntries([
					...[...files].map(([path, state]) => [path, { text: state.text, owners: [...state.owners] }]),
					...[...unknown].map((path) => [path, null]),
				]),
				files: [...touched].sort(),
			};
			headChanged = true;
			claimedSteps.add(node.stepId);
		}
		if (op.evidence?.kind === "commit" && !op.unparsed)
			headChanged = true;
	}
	const endState: FileSnapshot = Object.fromEntries([
		...[...files].map(([file, state]) => [file, state.text]),
		...[...unknown].map((file) => [file, null]),
	]);
	const survivors = new Map<string, number>();
	const uncertainOwners = new Set<string>();
	for (const [file, state] of files)
		for (const owner of state.owners) {
			if (!owner) continue;
			if (unknown.has(file)) uncertainOwners.add(owner);
			else survivors.set(owner, (survivors.get(owner) ?? 0) + 1);
		}
	for (const effect of effects) {
		const surviving = survivors.get(key(effect.node)) ?? 0;
		if (unknown.has(effect.file) || uncertainOwners.has(key(effect.node))) effect.lineage = "unknown";
		else if (effect.applied)
			effect.lineage =
				effect.total === 0
					? "unknown"
					: surviving === effect.total
						? "retained"
						: surviving
							? "partial"
							: "abandoned";
		effect.endState = Object.hasOwn(endState, effect.file)
			? { [effect.file]: endState[effect.file] ?? null }
			: {};
	}
	const branches: Branch[] = [
		{
			id: "main",
			kind: "main",
			parentId: null,
			forkAfterStepId: null,
			rejoinAtStepId: null,
			nodes: [],
			structuralStatus: "retained",
			reasons: ["Run end-state lineage; artifact claim not checked.", ...unparsedReasons],
		},
	];
	const byKey = new Map(ops.map((op) => [key(op.node), op.node]));
	const branch = (
		kind: Branch["kind"],
		nodes: BranchNode[],
		rejoin: BranchNode | null,
		reason: string,
	): Branch => {
		const first = nodes[0];
		const b: Branch = {
			id: `${kind}-${branches.length}`,
			kind,
			parentId: "main",
			forkAfterStepId: first
				? (ops[first.index - 1]?.node.stepId ?? null)
				: null,
			rejoinAtStepId: rejoin?.stepId ?? null,
			nodes: [],
			structuralStatus: "abandoned",
			reasons: [reason],
		};
		for (const n of nodes) n.branchId = b.id;
		branches.push(b);
		return b;
	};
	const attempts = new Map<string, BranchNode>();
	for (const { node } of ops) {
		if (
			(node.action !== "test" && node.action !== "run") ||
			node.target === null
		)
			continue;
		const signature = `${node.action}:${node.target ?? ""}`;
		const prior = attempts.get(signature);
		if (prior && prior.status !== "ok") {
			const barrier =
				ops
					.slice(0, prior.index)
					.reverse()
					.find((o) => o.node.action === "test" || o.node.action === "run")
					?.node.index ?? -1;
			const dead = effects
				.filter((e) => e.lineage === "abandoned")
				.map((e) => byKey.get(key(e.node)))
				.filter(
					(n): n is BranchNode =>
						n !== undefined && n.index > barrier && n.index < node.index,
				);
			const nested = branches.filter(
				(b) =>
					b.kind === "retry" &&
					b.rejoinAtStepId &&
					ops.some(
						(o) =>
							o.node.stepId === b.rejoinAtStepId &&
							o.node.index > prior.index &&
							o.node.index < node.index,
					),
			);
			const candidates = [prior, ...dead]
				.filter((n) => n.branchId === "main")
				.sort((a, b) => a.index - b.index);
			const b = branch(
				"retry",
				candidates,
				node,
				"Repeated signature after failed or unknown attempt; only adjacent, proven dead edits join it.",
			);
			for (const inner of nested)
				if (inner.parentId === "main") inner.parentId = b.id;
		}
		attempts.set(signature, node);
	}
	for (const { at, undone } of backtracks) {
		const nodes = [...undone]
			.map((k) => byKey.get(k))
			.filter(
				(n): n is BranchNode =>
					n !== undefined &&
					effects.some(
						(e) => key(e.node) === key(n) && e.lineage === "abandoned",
					),
			);
		if (!nodes.length) continue;
		const parent =
			nodes.map((n) => n.branchId).find((id) => id !== "main") ?? "main";
		const b = branch(
			"backtrack",
			nodes,
			at,
			"Successful operation restored earlier file content.",
		);
		b.parentId = parent;
	}
	for (const effect of effects) {
		const n = byKey.get(key(effect.node));
		if (!n || n.branchId !== "main") continue;
		if (
			effect.applied &&
			(effect.lineage === "abandoned" || effect.lineage === "partial")
		) {
			const b = branch(
				"superseded",
				[n],
				removedAt.get(key(n)) ?? null,
				"Introduced spans were removed or replaced before run end.",
			);
			b.structuralStatus = effect.lineage;
		} else if (effect.lineage === "unknown" || !effect.applied) {
			const b = branch(
				"main",
				[n],
				null,
				effect.lineage === "unknown"
					? ["Edit lineage cannot be reconstructed from recorded evidence.", ...unparsedReasons].join(" ")
					: "The failed edit introduced no proven text.",
			);
			b.structuralStatus = effect.lineage;
		}
	}
	for (const { node } of ops)
		branches.find((b) => b.id === node.branchId)?.nodes.push(ref(node));
	return {
		nodes: ops.map((o) => o.node),
		branches,
		editEffects: effects.map(({ total: _total, applied: _applied, ...e }) => e),
		endState,
		endStateComplete,
		claim,
	};
}
