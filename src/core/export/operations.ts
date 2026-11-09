import { classifyCommand, execLiteralCalls } from "../diff/normalize.ts";
import { ATTR, type Step } from "../types.ts";

/** A recorded file access or test invocation, without a claim about its result. */
export interface FileOperation {
	kind: "write" | "read" | "test";
	path?: string;
}

function canonicalPath(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
		else if (part === ".." && !path.startsWith("/")) parts.push(part);
		else if (part !== "..") parts.push(part);
	}
	return `${path.startsWith("/") ? "/" : ""}${parts.join("/")}` || ".";
}

/** Normalize lexical paths against the workspace without collapsing outside paths. */
export function normalizeFilePath(path: string, cwd?: string | null): string {
	const base = cwd ? canonicalPath(cwd) : undefined;
	const full = canonicalPath(base && !path.startsWith("/") ? `${base}/${path}` : path);
	if (full === base) return ".";
	const prefix = base === "/" ? "/" : `${base}/`;
	return base && full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

function argumentsOf(step: Step): Record<string, unknown> {
	const args = step.attributes[ATTR.TOOL_ARGS];
	return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function commandOf(args: Record<string, unknown>): string | undefined {
	return string(args.command) ?? string(args.cmd);
}

// Only literal one-file reads are recognized. Compound commands, expansion,
// options and other sed programs remain unknown rather than guessed.
const FILE_WORD = String.raw`(?:'([^'\n]+)'|"([^"$\x60\\\n]+)"|([^\s'"$\x60\\;|&<>()*?\[\]{}!#~]+))`;
const CAT_READ = new RegExp(String.raw`^\s*cat\s+(?:<\s*)?${FILE_WORD}\s*$`);
const SED_READ = new RegExp(String.raw`^\s*sed\s+-n\s+(?:'\d+(?:,\d+)?p'|"\d+(?:,\d+)?p")\s+${FILE_WORD}\s*$`);

/** Extract evidenced accesses from full tool arguments, never normalized DiffSteps. */
export function fileOperations(step: Step, cwd?: string | null): FileOperation[] {
	return operationEvidence(step, cwd).operations;
}

/** Unknown exec cells remain explicit rather than proving independence. */
export function operationEvidence(step: Step, cwd?: string | null): { operations: FileOperation[]; unresolved: boolean } {
	if (step.kind === "tool_call" && step.attributes[ATTR.TOOL_NAME] === "exec") {
		const calls = execLiteralCalls(string(argumentsOf(step).input) ?? "");
		// Without completion, a prior call could have thrown before later calls
		// were invoked. Literal source alone cannot prove those accesses occurred.
		if (!calls || step.attributes[ATTR.EXEC_COMPLETED] !== true) return { operations: [], unresolved: true };
		const operations: FileOperation[] = [];
		let unresolved = false;
		for (const call of calls) {
			let args: Record<string, unknown>;
			if (call.tool === "apply_patch") {
				const patch = call.argument(null).value;
				if (patch === undefined) { unresolved = true; continue; }
				args = { input: patch };
			} else if (call.tool === "exec_command") {
				const command = call.argument("cmd").value;
				const workdir = call.argument("workdir");
				if (command === undefined || (workdir.found && workdir.value === undefined)) {
					unresolved = true;
					continue;
				}
				args = { cmd: command, ...(workdir.found ? { workdir: workdir.value } : {}) };
			} else {
				unresolved = true;
				continue;
			}
			const extracted = directOperations({ ...step, attributes: { [ATTR.TOOL_NAME]: call.tool, [ATTR.TOOL_ARGS]: args } }, cwd);
			if (!extracted.length) unresolved = true;
			// A recognized test inside a compound shell command does not resolve
			// the other stages' accesses. Retain the invocation, flag the gap.
			const command = commandOf(args);
			if (command && extracted.some((op) => op.kind === "test") &&
				(/[;&|<>`$()\n]/.test(command) || classifyCommand(command, cwd).some((part) => part.action !== "test"))) {
				unresolved = true;
			}
			operations.push(...extracted);
		}
		return { operations, unresolved };
	}
	return { operations: directOperations(step, cwd), unresolved: false };
}

function directOperations(step: Step, cwd?: string | null): FileOperation[] {
	if (step.kind !== "tool_call") return [];
	const name = string(step.attributes[ATTR.TOOL_NAME]) ?? "";
	const args = argumentsOf(step);
	const path = string(args.file_path) ?? string(args.path);
	if (/^(write|write_file|edit|edit_file|multiedit)$/i.test(name) && path) {
		return [{ kind: "write", path: normalizeFilePath(path, cwd) }];
	}
	if (/^(read|read_file)$/i.test(name) && path) {
		return [{ kind: "read", path: normalizeFilePath(path, cwd) }];
	}
	if (name === "apply_patch") {
		const input = string(args.input) ?? "";
		return [...input.matchAll(/^\*\*\* (?:(?:Update|Add) File|Move to): ([^\r\n]+)\r?$/gm)]
			.map((match) => ({ kind: "write", path: normalizeFilePath(match[1]!, cwd) }));
	}
	if (/^(test|run_tests)$/i.test(name)) return [{ kind: "test" }];
	if (!/^(bash|shell|exec_command)$/i.test(name)) return [];
	const command = commandOf(args);
	if (!command) return [];
	const operations: FileOperation[] = [];
	if (classifyCommand(command, cwd).some((part) => part.action === "test")) {
		operations.push({ kind: "test" });
	}
	const match = CAT_READ.exec(command) ?? SED_READ.exec(command);
	const target = match?.[1] ?? match?.[2] ?? match?.[3];
	const workdir = args.workdir ?? args.working_directory ?? args.cwd;
	if (target && !target.startsWith("-") && (workdir === undefined || string(workdir))) {
		const directory = typeof workdir === "string"
			? canonicalPath(workdir.startsWith("/") || !cwd ? workdir : `${cwd}/${workdir}`)
			: cwd;
		const full = directory && !target.startsWith("/") ? `${directory}/${target}` : target;
		operations.push({ kind: "read", path: normalizeFilePath(full, cwd) });
	}
	return operations;
}

/** Short human label for diagnostics; raw identifiers stay in structured fields. */
export function stepLabel(step: Step | undefined, cwd?: string | null): string {
	if (!step) return "Unknown step";
	const name = string(step.attributes[ATTR.TOOL_NAME]) ?? step.kind;
	const args = argumentsOf(step);
	const paths = fileOperations(step, cwd).flatMap((op) => op.path ? [op.path] : []);
	const target = commandOf(args) ?? (paths.length ? paths.join(", ") : undefined);
	const label = `${name}${target ? ` ${target}` : ""}`.replace(/\s+/g, " ").trim();
	return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}
