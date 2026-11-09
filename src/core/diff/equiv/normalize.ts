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
	const full = path.startsWith("/") ? path : cwd?.startsWith("/") ? `${cwd}/${path.replace(/^\.\//, "")}` : null;
	if (full === null) return null;
	if (hasParent(full)) return null;
	const parts: string[] = [];
	for (const part of full.split("/")) {
		if (!part) continue;
		parts.push(part);
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
const hasParent = (path: string) => path.replace(/^\.\//, "").split("/").includes("..");

/** Extract only path positions, not search patterns or arbitrary command arguments. */
function pathIssue(source: Step, cwd?: string | null, execution = false): string | undefined {
	const args = source.attributes[ATTR.TOOL_ARGS];
	if (!plainObject(args)) return execution && !fileIdentity(cwd ?? "") ? "unresolved-root" : undefined;
	const name = source.attributes[ATTR.TOOL_NAME];
	let paths: unknown[] = [];
	if (["Read", "read_file", "Edit", "MultiEdit", "Write", "write_file"].includes(String(name))) {
		paths = [args.path ?? args.file_path];
	} else if (name === "Grep" || name === "Glob") {
		paths = [args.path ?? "."];
	} else if (["Bash", "shell", "shell_command", "exec_command"].includes(String(name))) {
		const { workdir: _workdir, cwd: _cwd, ...command } = args;
		const cmd = literalCommand(command);
		if (cmd !== undefined) {
			const read = /^(?:cat |head -n [0-9]+ |sed -n '[0-9]+(?:,[0-9]+)?p' )(.+)$/.exec(cmd);
			if (read) paths = (read[1] as string).split(" ").filter(plainToken).map(unquote);
			else if (/^(?:cat|head -n [0-9]+|sed -n '[0-9]+(?:,[0-9]+)?p')$/.test(cmd)) paths = ["."];
			else {
				const words = cmd.split(" ");
				if (words.shift() === "rg") {
					while (words[0] && RG_FLAGS.has(unquote(words[0]))) words.shift();
					if (words[0] && plainToken(words[0])) paths = words.length === 1 ? ["."] : words.slice(1).filter(plainToken).map(unquote);
				} else if (cmd.startsWith("grep -rn ")) paths = words.length === 2 ? ["."] : words.slice(2).filter(plainToken).map(unquote);
			}
		}
	}
	if (paths.some((path) => typeof path === "string" && (hasParent(path) || !path.startsWith("/") && !!cwd && hasParent(cwd)))) return "unresolved-path";
	if (!fileIdentity(cwd ?? "") && (execution || paths.some((path) => typeof path !== "string" || !path.startsWith("/")))) return "unresolved-root";
	return undefined;
}

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
	const scope = typeof path === "string" ? path : cwd;
	if (!scope || !fileIdentity(scope, cwd)) return undefined;
	return { action: "search", key: key("search", name, fileKey(scope, cwd), options) };
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
	if (cmd === undefined) return undefined;
	const words = cmd.split(" ");
	if (!plainToken(words[0] as string)) return undefined;
	for (const word of words.slice(1)) {
		const literal = unquote(word);
		if (literal !== "--" && !plainToken(word) &&
			!(literal.startsWith("-") && LITERAL_TOKEN.test(literal.replace(/^--?/, "")))) return undefined;
	}
	if (["cd", "export", "env", "sh", "bash", "zsh", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac"].includes(unquote(words[0] as string))) return undefined;
	return { key: key("execution", command.cmd ?? command.command) };
}

// Remove exactly one single-quote pair, then require the same narrow alphabet
// even for quoted data. Option prefixes are allowed only in flag positions.
const unquote = (v: string) => v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1) : v;
const LITERAL_TOKEN = /^[A-Za-z0-9_./][A-Za-z0-9_./:@+,-]*$/;
const plainToken = (v: string) => LITERAL_TOKEN.test(unquote(v));
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
		file = unquote(file);
		const target = fileIdentity(file, cwd);
		return { action: "read", target, range, key: range && target !== null ? readKey(target, range, cwd) : key("read-shell", fileKey(file, cwd)) };
	}
	const words = cmd.split(" ");
	const name = words.shift();
	const flags: string[] = [];
	if (name === "rg") {
		while (words[0] && unquote(words[0]).startsWith("-")) {
			const flag = unquote(words.shift() as string);
			if (!RG_FLAGS.has(flag)) return undefined;
			flags.push(flag);
		}
	} else if (name === "grep" && words.shift() === "-rn") {
		// grep has exactly one supported option spelling.
	} else return undefined;
	if (words.length === 0 || !words.every(plainToken)) return undefined;
	const pattern = unquote(words[0] as string);
	const scopes = words.length === 1 ? [cwd] : words.slice(1).map(unquote);
	if (!scopes.every((path) => typeof path === "string" && fileIdentity(path, cwd) !== null)) return undefined;
	return { action: "search", key: key("search-shell", name, flags, pattern, scopes.map((path) => fileKey(path as string, cwd))) };
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
		const { file_path: _file, path: _path, ...options } = args;
		return { action: "read", target, range, key: range && target !== null ? readKey(target, range, cwd) : key("read-native", name, fileKey(file, cwd), options) };
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

const NORMALIZATION_BUDGET = 2_000_000;
type Spend = (steps?: number) => boolean;

/**
 * Keep only candidates with the same file/range kind or exact search key.
 * Barriers close affected buckets; distinct-file edits leave reads open.
 * A bridging range revisits its own bucket, never the entire event stream.
 */
function coalesceObservations(
	events: CanonicalEvent[],
	sameSegment: (a: CanonicalEvent, b: CanonicalEvent) => boolean,
	cwd: string | null | undefined,
	spend: Spend,
): CanonicalEvent[] {
	const slots: Array<CanonicalEvent | null> = [...events];
	const buckets = new Map<string, Set<number>>();
	for (let i = 0; i < slots.length; i++) {
		if (!spend()) break;
		const event = slots[i] as CanonicalEvent;
		if (i > 0 && !sameSegment(events[i - 1] as CanonicalEvent, event)) buckets.clear();
		if (event.action !== "read" && event.action !== "search") {
			for (const [bucketKey, candidates] of buckets) {
				if (!spend()) return slots.filter((e): e is CanonicalEvent => e !== null);
				const representative = slots[candidates.values().next().value as number] as CanonicalEvent;
				if (!canCommute(event, representative)) buckets.delete(bucketKey);
			}
			continue;
		}
		if (event.status !== "ok") {
			buckets.clear();
			continue;
		}
		if (event.range && event.target === null) continue;
		const bucketKey = key(event.action, event.target, event.range ? "range" : event.key);
		let candidates = buckets.get(bucketKey);
		if (!candidates) {
			candidates = new Set();
			buckets.set(bucketKey, candidates);
		}
		let position = i;
		let changed = true;
		while (changed) {
			changed = false;
			for (const candidate of candidates) {
				if (!spend()) return slots.filter((e): e is CanonicalEvent => e !== null);
				if (candidate === position) continue;
				const a = slots[candidate] as CanonicalEvent;
				const b = slots[position] as CanonicalEvent;
				const range = a.range && b.range
					? a.range.start <= b.range.end + 1 && b.range.start <= a.range.end + 1
						? { start: Math.min(a.range.start, b.range.start), end: Math.max(a.range.end, b.range.end) } : null
					: undefined;
				if (range === null) continue;
				// Charge member copying as well as candidate checks so a single
				// enormous group cannot hide quadratic work behind cheap lookups.
				if (!spend(a.members.length + b.members.length)) return slots.filter((e): e is CanonicalEvent => e !== null);
				const first = Math.min(candidate, position);
				const last = Math.max(candidate, position);
				const merged = merge(slots[first] as CanonicalEvent, slots[last] as CanonicalEvent,
					range ? readKey(a.target, range, cwd) : a.key, a.action === "read" ? "read-coalesce" : "search-dedupe");
				if (range) merged.range = range;
				slots[first] = merged;
				slots[last] = null;
				candidates.delete(candidate);
				candidates.delete(position);
				position = first;
				changed = true;
				break;
			}
		}
		candidates.add(position);
	}
	return slots.filter((e): e is CanonicalEvent => e !== null);
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
	for (const step of steps) {
		const members = grouped.get(step.stepId);
		if (members) members.push(step);
		else grouped.set(step.stepId, [step]);
	}
	const evidenceBySource = new Map<string, Evidence>();
	const edits = new Map<string, Replacement[]>();
	const reasons = new Set<string>();
	const normalizedRuns = new Set<string>();
	const unresolved = new Set<string>();
	const segments = new Map<string, number>();
	let segment = 0;
	// Map iteration follows source trace order, including calls with no DiffSteps.
	// Omitted opaque calls divide the retained events without inventing members,
	// so expansion still returns exactly the caller's original DiffStep array.
	for (const [id, source] of sources) {
		if (source.subagent_id || source.kind !== "tool_call") continue;
		const members = grouped.get(id) ?? [];
		const normalizedRun = members.length > 0 && members.every((step) => step.action === "test" || step.action === "run") &&
			!["exec", "write_stdin"].includes(String(source.attributes[ATTR.TOOL_NAME]));
		const issue = pathIssue(source, cwd, normalizedRun);
		if (issue) {
			unresolved.add(id);
			reasons.add(issue);
			if (members.length === 0) segment++;
		}
		if (sourceNormalizationTruncated(source, cwd)) reasons.add("normalizer-cap-or-unsupported-shape");
		const member = members[0];
		let evidence = allowlistedEvidence(source, cwd, member?.status === "ok");
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
			reasons.add("unsupported-source");
			if (members.length === 0) segment++;
		}
		segments.set(id, segment);
	}
	const sameSegment = (a: CanonicalEvent, b: CanonicalEvent) =>
		segments.get(a.memberStepIds[0] as string) === segments.get(b.memberStepIds[0] as string);
	let events = steps.map((step, index): CanonicalEvent => {
		const source = sources.get(step.stepId);
		const allowed = evidenceBySource.get(step.stepId);
		const delegate = step.action === "delegate";
		// Every retained member needs evidence, including non-tool/sidechain
		// sources skipped above and polls that normally produce no DiffSteps.
		if (!allowed) reasons.add(!source ? "missing-source" : delegate ? "unsupported-delegate" : "unsupported-source");
		const opaque = !allowed && !normalizedRuns.has(step.stepId);
		const action = opaque || unresolved.has(step.stepId) ? "other" : allowed?.action ?? step.action;
		if ((action === "read" || action === "edit" || action === "write") && allowed?.target === null) reasons.add("unclassified-step");
		if (["edit", "write", "test", "run", "delegate", "blocked"].includes(action) && step.status === "unknown") reasons.add("unknown-mutator-status");
		const evidence: Evidence = unresolved.has(step.stepId)
			? { target: null, key: key("unresolved-path", source?.attributes[ATTR.TOOL_NAME], source?.attributes[ATTR.TOOL_ARGS]) }
			: opaque
			? { target: null, range: null, key: delegate
				// Retain a position, never an agent-type signature as work evidence.
				? key("unsupported-delegate", index)
				: key("unsupported-source", step.signature, source?.attributes, grouped.get(step.stepId)?.indexOf(step)) }
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
	// Bound additional rewrite work after evidence enrichment: event visits,
	// candidate/barrier checks, replacements and copied members.
	let remaining = NORMALIZATION_BUDGET;
	const spend: Spend = (count = 1) => {
		if (count <= remaining) {
			remaining -= count;
			return true;
		}
		reasons.add("normalization-budget");
		return false;
	};
	// A consecutive edit chain is one candidate. Never partially collapse it when
	// comparison cannot verify the complete chain against the other lane.
	editBatches:
	for (let i = 0; i < events.length; i++) {
		if (!spend()) break;
		const first = events[i] as CanonicalEvent;
		let composed = edits.get(first.id);
		if (!composed) continue;
		let end = i;
		for (let j = i + 1; j < events.length; j++) {
			if (!spend()) break editBatches;
			const next = events[j] as CanonicalEvent;
			const edit = edits.get(next.id);
			if (!edit || !sameSegment(first, next) || next.target !== first.target || next.status !== "ok") break;
			if (!spend(composed.length + edit.length)) break editBatches;
			composed = composition([...composed, ...edit]);
			end = j;
		}
		const composedKey = editKey(first.target, composed, cwd);
		if (end === i || editKeys && !editKeys.has(composedKey)) continue;
		const memberCount = events.slice(i, end + 1).reduce((sum, e) => sum + e.members.length, 0);
		if (!spend(memberCount * (end - i + 1))) break;
		let combined = first;
		for (let j = i + 1; j <= end; j++) combined = merge(combined, events[j] as CanonicalEvent, composedKey, "edit-batch");
		events.splice(i, end - i + 1, combined);
	}
	if (!reasons.has("normalization-budget")) events = coalesceObservations(events, sameSegment, cwd, spend);
	return { steps, events, sourceSegments: segments, incomplete: reasons.size > 0, incompleteReasons: [...reasons] };
}
