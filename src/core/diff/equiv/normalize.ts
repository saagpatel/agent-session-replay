import { ATTR, type Step } from "../../types.ts";
import { sourceNormalizationTruncated } from "../normalize.ts";
import type { DiffAction, DiffStep } from "../types.ts";
import { canCommute } from "./rules.ts";
import type { CanonicalEvent, EquivalentNormalization, ReadRange } from "./types.ts";

type Json = Record<string, unknown>;
interface Replacement {
	old: string;
	next: string;
}
interface Evidence {
	action?: DiffAction;
	target?: string | null;
	range?: ReadRange | null;
	key: string;
	edit?: Replacement[];
}
/** Tool arguments must be plain data objects, never arrays or class instances. */
function plainObject(v: unknown): v is Json {
	if (v === null || typeof v !== "object") return false;
	const prototype = Object.getPrototypeOf(v);
	return prototype === Object.prototype || prototype === null;
}
const object = (v: unknown): Json => plainObject(v) ? v : {};
const onlyKeys = (args: Json, keys: readonly string[]) => Object.keys(args).every((k) => keys.includes(k));

/** Collision-free, browser-safe structural encoding, also used for unknown args. */
function stable(v: unknown): string {
	if (v === undefined) return "undefined";
	if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
	if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(object(v)[k])}`).join(",")}}`;
	return JSON.stringify(v);
}
const key = (...parts: unknown[]) => stable(parts);
const readKey = (target: string | null, range: ReadRange, cwd?: string | null) => key("read", target === null ? null : fileKey(target, cwd), range);
const editKey = (target: string | null, edits: Replacement[], cwd?: string | null) => key("edit", target === null ? null : fileKey(target, cwd), edits);

/** Non-cryptographic content fingerprint; exact content also guards collisions. */
function contentHash(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 0x01000193);
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Full lexical identity for order guards; unknown relative roots stay unknown. */
function fileIdentity(path: string, cwd?: string | null): string | null {
	if (!path) return null;
	const full = path.startsWith("/") ? path : cwd?.startsWith("/") ? `${cwd}/${path}` : null;
	if (full === null) return null;
	const parts: string[] = [];
	for (const part of full.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/** Workspace-relative equality key, preserving full identities outside it. */
function fileKey(path: string, cwd?: string | null): string {
	const full = fileIdentity(path, cwd);
	const base = cwd ? fileIdentity(cwd) : null;
	if (full && base && full.startsWith(`${base === "/" ? "" : base}/`)) return full.slice(base === "/" ? 1 : base.length + 1);
	if (full && full === base) return ".";
	return full ?? path;
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

/** Only single-occurrence, literal structured replacements are allowlisted. */
function replacement(v: unknown): Replacement | undefined {
	if (!plainObject(v) || !onlyKeys(v, ["old_string", "new_string", "replace_all"])) return undefined;
	return typeof v.old_string === "string" && v.old_string.length > 0 &&
		typeof v.new_string === "string" && (v.replace_all === undefined || v.replace_all === false)
		? { old: v.old_string, next: v.new_string } : undefined;
}

function editEvidence(name: unknown, args: Json, successful: boolean): Replacement[] | undefined {
	if (name === "Edit" && onlyKeys(args, ["file_path", "old_string", "new_string", "replace_all"])) {
		const { file_path: _file, ...body } = args;
		const edit = replacement(body);
		return edit ? [edit] : undefined;
	}
	if (name !== "MultiEdit" || !onlyKeys(args, ["file_path", "edits"]) ||
		!Array.isArray(args.edits) || args.edits.length === 0) return undefined;
	const edits = args.edits.map(replacement);
	if (!edits.every((edit) => edit !== undefined)) return undefined;
	return successful ? composition(edits) : edits;
}

function bounds(start: unknown, count: unknown): ReadRange | null {
	return typeof start === "number" && typeof count === "number" && Number.isSafeInteger(start) &&
		Number.isSafeInteger(count) && start > 0 && count > 0 && Number.isSafeInteger(start + count - 1)
		? { start, end: start + count - 1 } : null;
}

const positiveInteger = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const pathValue = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Fixed Claude search schemas: unknown options are unsupported, not equality data. */
function nativeSearch(name: unknown, args: Json, cwd?: string | null): Evidence | undefined {
	const strings = ["pattern", "path", "glob", "type"];
	const booleans = ["-n", "-i", "multiline"];
	const counts = ["-A", "-B", "-C", "context", "head_limit", "offset"];
	const keys = name === "Glob" ? ["pattern", "path"] : [...strings, ...booleans, ...counts, "output_mode"];
	if (!onlyKeys(args, keys) || typeof args.pattern !== "string") return undefined;
	if (strings.some((k) => args[k] !== undefined && typeof args[k] !== "string")) return undefined;
	if (booleans.some((k) => args[k] !== undefined && typeof args[k] !== "boolean")) return undefined;
	if (counts.some((k) => args[k] !== undefined && !(typeof args[k] === "number" && Number.isSafeInteger(args[k]) && args[k] >= 0))) return undefined;
	if (args.output_mode !== undefined && (typeof args.output_mode !== "string" ||
		!["content", "files_with_matches", "count"].includes(args.output_mode))) return undefined;
	const { path, ...options } = args;
	if (path !== undefined && !pathValue(path)) return undefined;
	return { action: "search", key: key("search", name, typeof path === "string" ? fileKey(path, cwd) : ".", options) };
}

/** No string wrappers or arbitrary argv joins: unwrap exactly these three shells. */
function literalCommand(args: Json): string | undefined {
	if (!onlyKeys(args, ["cmd", "command"]) || Object.keys(args).length !== 1) return undefined;
	const cmd = args.cmd ?? args.command;
	if (typeof cmd === "string") return cmd;
	if (!Array.isArray(cmd) || cmd.length !== 3 ||
		!["sh", "bash", "zsh"].includes(cmd[0]) || !["-c", "-lc"].includes(cmd[1]) || typeof cmd[2] !== "string") return undefined;
	return cmd[2];
}

/** Literal execution only; scope options must name this run's exact root. */
function executionEvidence(args: Json, cwd?: string | null): Evidence | undefined {
	const { workdir, cwd: directory, ...command } = args;
	for (const option of ["workdir", "cwd"]) {
		if (option in args && (typeof args[option] !== "string" || !cwd || args[option] !== cwd)) return undefined;
	}
	const cmd = literalCommand(command);
	// Match the read allowlist's narrow literal alphabet, allowing option words.
	// No shell parsing, expansion, quoting, assignments, or stage splitting.
	if (cmd === undefined || cmd.trim() !== cmd || !/^[A-Za-z0-9_./:@%+,-]+(?: [A-Za-z0-9_./:@%+,=-]+)*$/.test(cmd)) return undefined;
	if (["cd", "export", "env", "sh", "bash", "zsh", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac"].includes(cmd.split(" ")[0] as string)) return undefined;
	return { key: key("execution", command.cmd ?? command.command) };
}

// An intentionally narrow token alphabet excludes expansion, quoting, comments,
// shell operators and globbing. Paths cannot start with an option or tilde.
const plainToken = (v: string) => /^[A-Za-z0-9_./:@%+,=-]+$/.test(v) && !v.startsWith("-");
const RG_FLAGS = new Set(["-n", "-i", "-w", "-l", "-F", "--no-heading"]);

/** Recognize entire literal read/search commands; never split shell stages. */
function shellEvidence(args: Json, cwd?: string | null): Evidence | undefined {
	const cmd = literalCommand(args);
	if (cmd === undefined) return undefined;
	let file: string | undefined;
	let range: ReadRange | null = null;
	const sed = /^sed -n '([0-9]+)(?:,([0-9]+))?p' ([^ ]+)$/.exec(cmd);
	const head = /^head -n ([0-9]+) ([^ ]+)$/.exec(cmd);
	const cat = /^cat ([^ ]+)$/.exec(cmd);
	if (sed) {
		file = sed[3];
		range = bounds(Number(sed[1]), Number(sed[2] ?? sed[1]) - Number(sed[1]) + 1);
		if (!range) return undefined;
	} else if (head) {
		file = head[2];
		range = bounds(1, Number(head[1]));
		if (!range) return undefined;
	} else if (cat) file = cat[1];
	if (file !== undefined) {
		if (!plainToken(file)) return undefined;
		const target = fileIdentity(file, cwd);
		return { action: "read", target, range, key: range && target !== null ? readKey(target, range, cwd) : key("read-shell", fileKey(file, cwd)) };
	}
	const words = cmd.split(" ");
	const name = words.shift();
	if (name === "rg") {
		while (words[0]?.startsWith("-")) {
			if (!RG_FLAGS.has(words.shift() as string)) return undefined;
		}
	} else if (name === "grep" && words.shift() === "-rn") {
		// grep has exactly one supported option spelling.
	} else return undefined;
	if (words.length === 0 || !words.every(plainToken)) return undefined;
	return { action: "search", key: key("search-shell", cmd) };
}

/** The only sources eligible for enrichment and subsequent merging. */
function allowlistedEvidence(source: Step, cwd?: string | null, successful = false): Evidence | undefined {
	const args = source.attributes[ATTR.TOOL_ARGS];
	if (!plainObject(args)) return undefined;
	const name = source.attributes[ATTR.TOOL_NAME];
	if (name === "Grep" || name === "Glob") return nativeSearch(name, args, cwd);
	if (["Bash", "shell", "shell_command", "exec_command"].includes(String(name))) return shellEvidence(args, cwd);
	const codex = name === "read_file" || name === "write_file";
	const file = codex ? args.path ?? args.file_path : args.file_path;
	if (!pathValue(file) || codex && args.path !== undefined && args.file_path !== undefined) return undefined;
	const target = fileIdentity(file, cwd);
	if (name === "Read" || name === "read_file") {
		if (!onlyKeys(args, codex ? ["path", "file_path", "offset", "limit"] : ["file_path", "offset", "limit"]) ||
			args.offset !== undefined && !positiveInteger(args.offset) || args.limit !== undefined && !positiveInteger(args.limit)) return undefined;
		const range = bounds(args.offset ?? 1, args.limit);
		if (args.limit !== undefined && range === null) return undefined;
		return { action: "read", target, range, key: range && target !== null ? readKey(target, range, cwd) : key("read-native", name, fileKey(file, cwd), args) };
	}
	if (name === "Edit" || name === "MultiEdit") {
		const edits = editEvidence(name, args, successful);
		return edits ? { action: "edit", target, key: editKey(target, edits, cwd), edit: target !== null ? edits : undefined } : undefined;
	}
	if ((name === "Write" || name === "write_file") &&
		onlyKeys(args, codex ? ["path", "file_path", "content"] : ["file_path", "content"]) && typeof args.content === "string") {
		return { action: "write", target, key: key("write-content", fileKey(file, cwd), contentHash(args.content), args.content) };
	}
	return undefined;
}

/** Only explicitly empty input with known poll fields is harmless. */
function statusPoll(source: Step): boolean {
	const args = source.attributes[ATTR.TOOL_ARGS];
	return source.attributes[ATTR.TOOL_NAME] === "write_stdin" && plainObject(args) && args.chars === "" &&
		onlyKeys(args, ["session_id", "chars", "yield_time_ms", "max_output_tokens"]) &&
		(typeof args.session_id === "number" || typeof args.session_id === "string");
}

function merge(a: CanonicalEvent, b: CanonicalEvent, evidenceKey: string, rule: CanonicalEvent["rule"]): CanonicalEvent {
	const pairs = [...a.members.map((index, i) => ({ index, id: a.memberStepIds[i] as string })),
		...b.members.map((index, i) => ({ index, id: b.memberStepIds[i] as string }))].sort((x, y) => x.index - y.index);
	return {
		...a,
		key: evidenceKey,
		signature: evidenceKey,
		rule,
		members: pairs.map((p) => p.index),
		memberStepIds: pairs.map((p) => p.id),
		status: "ok",
	};
}

/**
 * Additive normalization over existing DiffSteps. No input is removed or mutated.
 * Supply sources in trace order so omitted opaque calls retain their barriers.
 * Omit editKeys to obtain all locally provable batches; the aligner supplies
 * counterpart keys to restrict edit-batch to verified cross-run compositions.
 */
export function normalizeEquivalent(
	steps: DiffStep[],
	sources: ReadonlyMap<string, Step>,
	cwd?: string | null,
	editKeys?: ReadonlySet<string>,
): EquivalentNormalization {
	const grouped = new Map<string, DiffStep[]>();
	for (const step of steps) grouped.set(step.stepId, [...(grouped.get(step.stepId) ?? []), step]);
	const evidenceBySource = new Map<string, Evidence>();
	const edits = new Map<string, Replacement[]>();
	const reasons = new Set<string>();
	const opaqueSources = new Set<string>();
	const normalizedRuns = new Set<string>();
	const segments = new Map<string, number>();
	let segment = 0;
	// Map iteration follows source trace order, including calls with no DiffSteps.
	// Omitted opaque calls divide the retained events without inventing members,
	// so expansion still returns exactly the caller's original DiffStep array.
	for (const [id, source] of sources) {
		if (source.subagent_id || source.kind !== "tool_call") continue;
		const members = grouped.get(id) ?? [];
		if (sourceNormalizationTruncated(source, cwd)) reasons.add("normalizer-cap-or-unsupported-shape");
		const member = members[0];
		let evidence = allowlistedEvidence(source, cwd, member?.status === "ok");
		const normalizedRun = members.length > 0 && members.every((step) => step.action === "test" || step.action === "run") &&
			!["exec", "write_stdin"].includes(String(source.attributes[ATTR.TOOL_NAME]));
		if (normalizedRun) normalizedRuns.add(id);
		// Test classification alone is not source evidence. Generic run sources
		// retain their existing unsupported accounting even when plainly literal.
		if (members.length === 1 && member?.action === "test" &&
			["Bash", "shell", "shell_command", "exec_command"].includes(String(source.attributes[ATTR.TOOL_NAME]))) {
			const args = source.attributes[ATTR.TOOL_ARGS];
			const execution = plainObject(args) ? executionEvidence(args, cwd) : undefined;
			if (execution) evidence = { ...execution, action: "test" };
		}
		// Preserve guard/blocked classification. Write may already be classified
		// as an edit; write_file is deliberately additive over Run Diff's other.
		const compatible = member && (member.action === evidence?.action || evidence?.action === "write" &&
			(member.action === "edit" || member.action === "other" && source.attributes[ATTR.TOOL_NAME] === "write_file"));
		if (evidence && members.length === 1 && compatible) evidenceBySource.set(id, evidence);
		else if (!statusPoll(source)) {
			// `run` is also the base normalizer's catch-all for arbitrary shell
			// syntax (awk, xargs, wrappers). Keep its signature, but do not treat
			// that classification alone as proof of supported source coverage.
			opaqueSources.add(id);
			reasons.add("unsupported-source");
			if (members.length === 0) segment++;
		}
		segments.set(id, segment);
	}
	const sameSegment = (a: CanonicalEvent, b: CanonicalEvent) =>
		segments.get(a.memberStepIds[0] as string) === segments.get(b.memberStepIds[0] as string);
	const events = steps.map((step, index): CanonicalEvent => {
		const source = sources.get(step.stepId);
		if (!source) reasons.add("missing-source");
		const allowed = evidenceBySource.get(step.stepId);
		const opaque = !source || opaqueSources.has(step.stepId) && !normalizedRuns.has(step.stepId);
		const action = opaque ? "other" : allowed?.action ?? step.action;
		if ((action === "read" || action === "edit" || action === "write") && allowed?.target === null) reasons.add("unclassified-step");
		if (["edit", "write", "test", "run", "delegate", "blocked"].includes(action) && step.status === "unknown") reasons.add("unknown-mutator-status");
		const evidence: Evidence = opaque
			? { target: null, range: null, key: key("unsupported-source", step.signature, source?.attributes, grouped.get(step.stepId)?.indexOf(step)) }
			: allowed ?? { key: step.signature };
		const id = `event-${index}`;
		if (evidence.edit && step.status === "ok") edits.set(id, evidence.edit);
		return {
			id,
			action,
			target: "target" in evidence ? evidence.target ?? null : step.target,
			...("range" in evidence ? { range: evidence.range } : {}),
			key: evidence.key,
			signature: evidence.key,
			rule: null,
			members: [index],
			memberStepIds: [step.stepId],
			status: step.status,
		};
	});
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
			if (!edit || !sameSegment(first, next) || next.target !== first.target || next.status !== "ok") break;
			composed = composition([...composed, ...edit]);
			end = j;
		}
		const composedKey = editKey(first.target, composed, cwd);
		if (end === i || editKeys && !editKeys.has(composedKey)) continue;
		let combined = first;
		for (let j = i + 1; j <= end; j++) combined = merge(combined, events[j] as CanonicalEvent, composedKey, "edit-batch");
		events.splice(i, end - i + 1, combined);
	}
	// Iterate to a fixed point: a later range may bridge two earlier ranges.
	let changed = true;
	while (changed) {
		changed = false;
		outer:
		for (let i = 0; i < events.length; i++) {
			const a = events[i] as CanonicalEvent;
			if (a.status !== "ok" || a.action !== "read" && a.action !== "search") continue;
			for (let j = i + 1; j < events.length; j++) {
				const b = events[j] as CanonicalEvent;
				if (!sameSegment(a, b) || !canCommute(a, b)) break;
				if (b.status !== "ok" || b.action !== a.action || a.target !== b.target) continue;
				const range = a.range && b.range && a.range.start <= b.range.end + 1 && b.range.start <= a.range.end + 1
					? { start: Math.min(a.range.start, b.range.start), end: Math.max(a.range.end, b.range.end) } : null;
				if (a.action === "read" ? !(a.target !== null && range || !a.range && !b.range && a.key === b.key) : a.key !== b.key) continue;
				if (!events.slice(i + 1, j).every((e) => canCommute(b, e))) continue;
				const merged = merge(a, b, range ? readKey(a.target, range, cwd) : a.key, a.action === "read" ? "read-coalesce" : "search-dedupe");
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
