import { ATTR, type Step } from "../../types.ts";
import { classifyCommand, relPath, splitStages } from "../normalize.ts";
import { isFailure, type DiffStep } from "../types.ts";
import { canCommute } from "./rules.ts";
import type { CanonicalEvent, EquivalentNormalization, ReadRange } from "./types.ts";

type Json = Record<string, unknown>;
interface Replacement { old: string; next: string }
interface Evidence {
	target?: string | null;
	range?: ReadRange | null;
	key: string;
	edit?: Replacement[];
}
const object = (v: unknown): Json => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Json : {};

/** Collision-free, browser-safe structural encoding, also used for unknown args. */
function stable(v: unknown): string {
	if (v === undefined) return "undefined";
	if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
	if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(object(v)[k])}`).join(",")}}`;
	return JSON.stringify(v);
}
const key = (...parts: unknown[]) => stable(parts);
const readKey = (target: string | null, range: ReadRange) => key("read", target, range);
const editKey = (target: string | null, edits: Replacement[]) => key("edit", target, edits);

/** Non-cryptographic content fingerprint; exact content also guards collisions. */
function contentHash(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 0x01000193);
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Unlike display relPath, never shorten a path outside the workspace. */
function fileKey(path: string, cwd?: string | null): string {
	const base = cwd?.replace(/\/$/, "");
	if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
	if (base && path === base) return ".";
	return path.replace(/^\.\//, "");
}

function unique(haystack: string, needle: string): boolean {
	const at = haystack.indexOf(needle);
	return needle.length > 0 && at >= 0 && haystack.indexOf(needle, at + 1) < 0;
}

/**
 * Compose only one provably connected touched region. Disjoint replacements,
 * empty anchors, replace-all, or ambiguous repeated substrings are not guessed.
 */
function compose(a: Replacement, b: Replacement): Replacement | undefined {
	if (unique(a.next, b.old)) return { old: a.old, next: a.next.replace(b.old, () => b.next) };
	return undefined;
}

/**
 * Preserve unconnected operations in their exact order. Identical operation
 * lists prove identical sequential composition, including disjoint MultiEdits;
 * they do not claim a guessed preimage for the text between touched regions.
 */
function composition(edits: Replacement[]): Replacement[] {
	const result: Replacement[] = [];
	for (const edit of edits) {
		const previous = result.at(-1);
		const combined = previous && compose(previous, edit);
		if (combined) result[result.length - 1] = combined;
		else result.push(edit);
	}
	return result;
}

function replacement(v: unknown): Replacement | undefined {
	const a = object(v);
	if (Object.keys(a).some((k) => !["old_string", "new_string", "replace_all", "file_path", "path"].includes(k))) return undefined;
	return typeof a.old_string === "string" && a.old_string.length > 0 &&
		typeof a.new_string === "string" && (a.replace_all === undefined || a.replace_all === false)
		? { old: a.old_string, next: a.new_string } : undefined;
}

function editEvidence(name: unknown, args: Json): Replacement[] | undefined {
	if (name === "Edit") { const edit = replacement(args); return edit ? [edit] : undefined; }
	if (name !== "MultiEdit" || !Array.isArray(args.edits) || args.edits.length === 0 ||
		Object.keys(args).some((k) => !["file_path", "path", "edits"].includes(k))) return undefined;
	const result: Replacement[] = [];
	for (const raw of args.edits) {
		const next = replacement(raw);
		if (!next) return undefined;
		result.push(next);
	}
	return composition(result);
}

function command(args: Json): string | undefined {
	const cmd = args.cmd ?? args.command;
	if (typeof cmd === "string") return cmd;
	if (!Array.isArray(cmd) || !cmd.every((x) => typeof x === "string")) return undefined;
	if (cmd.length === 3 && /sh$/.test(cmd[0] ?? "") && /^-l?c$/.test(cmd[1] ?? "")) return cmd[2];
	return cmd.join(" ");
}

/** Potential effects/scope hidden behind a file-only shell classification. */
function unknownShellScope(text: string): boolean {
	if (/^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function)\b/.test(text.trim())) return true;
	let quote: string | null = null;
	for (const char of text) {
		if (quote === "'") { if (char === "'") quote = null; continue; }
		if (char === "$" || char === "`" || char === "\\") return true;
		if (quote === '"') { if (char === '"') quote = null; continue; }
		if (char === "'" || char === '"') quote = char;
		else if (/[|<>&;*?\[\]]/.test(char)) return true;
	}
	return quote !== null;
}

/**
 * Associate simple shell stages only when the full classified sequence matches.
 * Exec cells, dynamic directories, pipelines and capped/multi-source mappings
 * retain exact raw arguments instead of borrowing another stage's range/query.
 */
function shellStages(source: Step, members: DiffStep[], cwd?: string | null): Map<DiffStep, string> {
	const args = object(source.attributes[ATTR.TOOL_ARGS]);
	const cmd = command(args);
	const found = new Map<DiffStep, string>();
	if (!cmd || args.workdir !== undefined || args.cwd !== undefined || args.working_directory !== undefined) return found;
	const stages = splitStages(cmd);
	if (stages.some((s) => /^(?:cd|pushd|popd)\b/.test(s.trim()) ||
		unknownShellScope(s) && classifyCommand(s, cwd).length === 0)) return found;
	const parts = stages.flatMap((stage) => classifyCommand(stage, cwd).map((part) => ({ part, stage })));
	if (parts.length !== members.length || parts.some(({ part }, i) => part.action !== members[i]?.action || part.target !== members[i]?.target)) return found;
	parts.forEach(({ stage }, i) => { const member = members[i]; if (member) found.set(member, stage); });
	return found;
}

function bounds(start: unknown, count: unknown): ReadRange | null {
	return typeof start === "number" && typeof count === "number" && Number.isSafeInteger(start) &&
		Number.isSafeInteger(count) && start > 0 && count > 0 && Number.isSafeInteger(start + count - 1)
		? { start, end: start + count - 1 } : null;
}

function shellRead(stage: string, target: string | null, cwd?: string | null): { target: string; range: ReadRange } | undefined {
	// These intentionally narrow forms have no expansions, redirects or options
	// whose effect could be lost by the existing file-only normalizer.
	const m = /^(?:sed -n ['"]?([0-9]+)(?:,([0-9]+))?p['"]?|head -n ([0-9]+))\s+(.+)$/.exec(stage);
	if (!m) return undefined;
	const files = m[4]?.match(/'[^']*'|"[^"]*"|[^\s]+/g) ?? [];
	if (!files.length || files.some((f) => /[$`\\<>|;&*?\[\]]/.test(f) || f.startsWith("-")) ||
		files.filter((f) => relPath(f, cwd) === target).length !== 1) return undefined;
	const file = files.find((f) => relPath(f, cwd) === target) as string;
	const start = Number(m[3] ? 1 : m[1]);
	const end = Number(m[3] ?? m[2] ?? m[1]);
	const range = bounds(start, end - start + 1);
	return range ? { target: fileKey(file.replace(/^["']|["']$/g, ""), cwd), range } : undefined;
}

function enrich(step: DiffStep, source: Step | undefined, ordinal: number, stage: string | undefined, cwd?: string | null): Evidence {
	const args = object(source?.attributes[ATTR.TOOL_ARGS]);
	const name = source?.attributes[ATTR.TOOL_NAME];
	const raw = key(step.action, step.target, "source", name, source?.attributes[ATTR.TOOL_ARGS] ?? source?.attributes, ordinal);
	const file = args.file_path ?? args.path;
	let target = typeof file === "string" && ["Read", "read_file", "Edit", "MultiEdit", "Write"].includes(String(name)) ? fileKey(file, cwd) : step.target;
	if (step.action === "read") {
		let range: ReadRange | null = null;
		if (name === "Read" && Object.keys(args).every((k) => ["file_path", "offset", "limit"].includes(k)))
			range = bounds(args.offset ?? 1, args.limit);
		else if (stage) {
			const read = shellRead(stage, step.target, cwd);
			if (read) { range = read.range; target = read.target; }
		}
		return { target, range, key: range && target !== null ? readKey(target, range) : raw };
	}
	if (step.action === "search" && (name === "Grep" || name === "Glob") && typeof args.pattern === "string") {
		const { path, ...options } = args;
		// Omitted path is the run root. All remaining options, including unknown
		// future options, participate in equality so none silently disappear.
		if (path !== undefined && typeof path !== "string") return { key: raw };
		return { key: key("search", name, typeof path === "string" ? fileKey(path, cwd) : ".", options) };
	}
	if (step.action === "search" && stage && /^(?:rg|grep)\s/.test(stage) && !/[$`\\<>|;&*?\[\]]/.test(stage)) {
		const words = stage.match(/'[^']*'|"[^"]*"|[^\s]+/g);
		const { cmd: _cmd, command: _command, ...options } = args;
		// Keep every token: query, paths, flags, and their ordering. No shell
		// option interpretation is needed to prove identical literal requests.
		return { key: key("search-shell", words, options) };
	}
	if ((step.action === "edit" || step.action === "write") && step.target !== null) {
		const edit = editEvidence(name, args);
		if (edit) return { target, key: editKey(target, edit), edit: step.status === "ok" ? edit : undefined };
		// Keep exact content alongside its fingerprint so a hash collision can
		// never turn different writes into equivalent work.
		if (name === "Write" && typeof args.content === "string" && Object.keys(args).every((k) => ["file_path", "content"].includes(k)))
			return { target, key: key(step.action, "write-content", target, contentHash(args.content), args.content) };
	}
	return { target, key: raw };
}

function merge(a: CanonicalEvent, b: CanonicalEvent, evidenceKey: string, rule: CanonicalEvent["rule"]): CanonicalEvent {
	const pairs = [...a.members.map((index, i) => ({ index, id: a.memberStepIds[i] as string })),
		...b.members.map((index, i) => ({ index, id: b.memberStepIds[i] as string }))].sort((x, y) => x.index - y.index);
	return {
		...a, key: evidenceKey, signature: evidenceKey, rule,
		members: pairs.map((p) => p.index), memberStepIds: pairs.map((p) => p.id),
		status: isFailure(a.status) ? a.status : isFailure(b.status) ? b.status :
			a.status === "unknown" || b.status === "unknown" ? "unknown" : "ok",
	};
}

/**
 * Additive normalization over existing DiffSteps. No input is removed or mutated.
 * Omit editKeys to obtain all locally provable batches; the aligner supplies
 * counterpart keys to restrict edit-batch to verified cross-run compositions.
 */
export function normalizeEquivalent(
	steps: DiffStep[], sources: ReadonlyMap<string, Step>, cwd?: string | null,
	editKeys?: ReadonlySet<string>,
): EquivalentNormalization {
	const grouped = new Map<string, DiffStep[]>();
	for (const step of steps) grouped.set(step.stepId, [...(grouped.get(step.stepId) ?? []), step]);
	const stages = new Map<DiffStep, string>();
	for (const [id, members] of grouped) {
		const source = sources.get(id);
		if (source) for (const [step, stage] of shellStages(source, members, cwd)) stages.set(step, stage);
	}
	const edits = new Map<string, Replacement[]>();
	const reasons = new Set<string>();
	const events = steps.map((step, index): CanonicalEvent => {
		const source = sources.get(step.stepId);
		if (!source) reasons.add("missing-source");
		if (step.action === "other" || ((step.action === "read" || step.action === "edit" || step.action === "write") && step.target === null)) reasons.add("unclassified-step");
		if (["edit", "write", "test", "run", "delegate", "blocked"].includes(step.action) && step.status === "unknown") reasons.add("unknown-mutator-status");
		const stage = stages.get(step);
		const cmd = command(object(source?.attributes[ATTR.TOOL_ARGS]));
		const opaque = (step.action === "read" || step.action === "search") &&
			(source?.attributes[ATTR.TOOL_NAME] === "exec" || cmd !== undefined && unknownShellScope(stage ?? cmd));
		// A pipeline can hide an arbitrary writer after a read; a redirect can
		// write a file omitted by the base normalizer. Keep these as barriers.
		if (opaque) reasons.add("unclassified-shell-scope");
		const evidence = enrich(step, source, grouped.get(step.stepId)?.indexOf(step) ?? 0, stage, cwd);
		const id = `event-${index}`;
		if (evidence.edit) edits.set(id, evidence.edit);
		return { id, action: opaque ? "other" : step.action, target: evidence.target ?? step.target, ...("range" in evidence ? { range: evidence.range } : {}),
			key: evidence.key, signature: evidence.key, rule: null, members: [index], memberStepIds: [step.stepId], status: step.status };
	});
	// Detect known lossy normalizer caps conservatively. These are diagnostic
	// only: expand still round-trips the exact supplied DiffSteps, not raw Steps.
	for (const source of sources.values()) {
		if (source.subagent_id || source.kind !== "tool_call") continue;
		const args = object(source.attributes[ATTR.TOOL_ARGS]);
		const cmd = command(args);
		const patch = args.input ?? args.patch;
		if ((cmd && (splitStages(cmd).length > 6 || (cmd.match(/\S+/g)?.length ?? 0) > 7 && /^(?:cat|head|sed)\b/.test(cmd))) ||
			(typeof patch === "string" && (patch.match(/\*\*\* (?:Update|Add|Delete) File:/g)?.length ?? 0) > 6)) reasons.add("normalizer-cap-or-unsupported-shape");
	}
	// A consecutive edit chain is one candidate. Never partially collapse it when
	// comparison cannot verify the complete chain against the other lane.
	for (let i = 0; i < events.length; i++) {
		const first = events[i] as CanonicalEvent;
		let composed = edits.get(first.id);
		if (!composed) continue;
		let end = i;
		for (let j = i + 1; j < events.length; j++) {
			const next = events[j] as CanonicalEvent;
			const edit = edits.get(next.id);
			if (!edit || next.target !== first.target || next.status !== "ok") break;
			composed = composition([...composed, ...edit]);
			end = j;
		}
		const composedKey = editKey(first.target, composed);
		if (end === i || editKeys && !editKeys.has(composedKey)) continue;
		let combined = first;
		for (let j = i + 1; j <= end; j++) combined = merge(combined, events[j] as CanonicalEvent, composedKey, "edit-batch");
		events.splice(i, end - i + 1, combined);
	}
	// Iterate to a fixed point: a later range may bridge two earlier ranges.
	let changed = true;
	while (changed) {
		changed = false;
		outer: for (let i = 0; i < events.length; i++) {
			const a = events[i] as CanonicalEvent;
			if (a.action !== "read" && a.action !== "search") continue;
			for (let j = i + 1; j < events.length; j++) {
				const b = events[j] as CanonicalEvent;
				if (!canCommute(a, b)) break;
				if (b.action !== a.action || a.target !== b.target) continue;
				const range = a.range && b.range && a.range.start <= b.range.end + 1 && b.range.start <= a.range.end + 1
					? { start: Math.min(a.range.start, b.range.start), end: Math.max(a.range.end, b.range.end) } : null;
				if (a.action === "read" ? !(a.target !== null && range || !a.range && !b.range && a.key === b.key) : a.key !== b.key) continue;
				if (!events.slice(i + 1, j).every((e) => canCommute(b, e))) continue;
				const merged = merge(a, b, range ? readKey(a.target, range) : a.key, a.action === "read" ? "read-coalesce" : "search-dedupe");
				if (range) merged.range = range;
				events[i] = merged;
				events.splice(j, 1);
				changed = true;
				break outer;
			}
		}
	}
	return { steps, events, incomplete: reasons.size > 0, incompleteReasons: [...reasons] };
}
