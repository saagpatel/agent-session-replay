import { classifyCommand, execLiteralCalls, maskCode } from "../diff/normalize.ts";
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

// This is an allowlist, not a general shell parser. New forms stay unresolved.
const FILE_WORD = String.raw`(?:'([^'\n]+)'|"([^"$\x60\\\n]+)"|([^\s'"$\x60\\;|&<>()*?\[\]{}!#~]+))`;
const CAT_READ = new RegExp(String.raw`^cat[ \t]+${FILE_WORD}$`);
const SED_READ = new RegExp(String.raw`^sed[ \t]+-n[ \t]+'\d+,\d+p'[ \t]+${FILE_WORD}$`);
const HEAD_READ = new RegExp(String.raw`^head[ \t]+-n[ \t]+\d+[ \t]+${FILE_WORD}$`);
const PATH_TOOLS: Record<string, { kind: "read" | "write"; keys: string[] }> = {
	Read: { kind: "read", keys: ["file_path", "path"] },
	Edit: { kind: "write", keys: ["file_path", "path"] },
	MultiEdit: { kind: "write", keys: ["file_path", "path"] },
	Write: { kind: "write", keys: ["file_path", "path"] },
	NotebookEdit: { kind: "write", keys: ["notebook_path"] },
	read_file: { kind: "read", keys: ["path", "file_path"] },
	write_file: { kind: "write", keys: ["path", "file_path"] },
};
const SHELL_TOOLS = new Set(["Bash", "exec_command", "shell"]);
const CONTENT_EDITS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

export interface OperationEvidence {
	operations: FileOperation[];
	unresolved: boolean;
	reason?: string;
}

const unknown = (reason: string, operations: FileOperation[] = []): OperationEvidence =>
	({ operations, unresolved: true, reason });
const known = (operations: FileOperation[]): OperationEvidence => ({ operations, unresolved: false });

/** Consume the whole cell, so unrecognized executable statements cannot hide. */
function onlyLiteralCalls(input: string): boolean {
	// The shared masker hides template interpolation too. Reject it anywhere,
	// including in payload fields that are not used for operation extraction.
	if (input.includes("${")) return false;
	let remaining = maskCode(input).trim();
	while (remaining) {
		const inline = /^text\(\s*(String\(\s*)?await\s+tools\.\w+\s*\(/.exec(remaining);
		const assigned = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.\w+\s*\(/.exec(remaining);
		const prefix = inline ?? assigned;
		if (!prefix) return false;
		let depth = 1;
		let end = prefix[0].length;
		for (; end < remaining.length && depth; end++) {
			if (remaining[end] === "(") depth++;
			if (remaining[end] === ")") depth--;
		}
		if (depth) return false;
		// Non-path fields must also be data: evaluating an ignored expression
		// (e.g. extra: mutate()) would introduce unextracted operations. Strings
		// are already masked; retain only literal containers, keys and scalars.
		const argumentsMask = remaining.slice(prefix[0].length, end - 1)
			.replace(/(["'`])[^"'`]*\1/g, "0")
			.replace(/\b[A-Za-z_$][\w$]*\s*:/g, "")
			.replace(/\b(?:true|false|null)\b/g, "0")
			.replace(/-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, "0");
		if (/[^\s0{}\[\]:,]/.test(argumentsMask)) return false;
		remaining = remaining.slice(end);
		if (inline) {
			const close = inline[1] ? /^\s*\)\s*\)\s*;?/ : /^\s*\)\s*;?/;
			const suffix = close.exec(remaining);
			if (!suffix) return false;
			remaining = remaining.slice(suffix[0].length);
		} else {
			// Match the original variable literally, including legal JS '$' names.
			const print = /^\s*;?\s*text\(\s*(String\(\s*)?([A-Za-z_$][\w$]*)\s*\)(\s*\))?\s*;?/.exec(remaining);
			if (!print || print[2] !== assigned![1] || Boolean(print[1]) !== Boolean(print[3])) return false;
			remaining = remaining.slice(print[0].length);
		}
		remaining = remaining.trim();
	}
	return true;
}

/** Extract evidenced accesses from full tool arguments, never normalized DiffSteps. */
export function fileOperations(step: Step, cwd?: string | null): FileOperation[] {
	return operationEvidence(step, cwd).operations;
}

/** Direct calls and completed, literal exec calls share exactly one allowlist. */
export function operationEvidence(step: Step, cwd?: string | null): OperationEvidence {
	if (step.kind !== "tool_call") return known([]);
	const name = string(step.attributes[ATTR.TOOL_NAME]) ?? "";
	const args = argumentsOf(step);
	if (name !== "exec") return directOperations(name, args, cwd);
	const calls = execLiteralCalls(string(args.input) ?? "");
	// Completion proves invocation, not success or the resulting file contents.
	if (!calls || !onlyLiteralCalls(string(args.input) ?? "") || step.attributes[ATTR.EXEC_COMPLETED] !== true) {
		return unknown("Exec cell is incomplete or is not a supported literal straight-line cell.");
	}
	const operations: FileOperation[] = [];
	const reasons: string[] = [];
	for (const call of calls) {
		const nested: Record<string, unknown> = {};
		const keys = call.tool === "apply_patch" ? [null]
			: Object.hasOwn(PATH_TOOLS, call.tool) ? PATH_TOOLS[call.tool]!.keys
			: SHELL_TOOLS.has(call.tool) ? ["cmd", "command", "workdir", "working_directory", "cwd"] : [];
		let dynamic = false;
		for (const key of keys) {
			const arg = call.argument(key);
			if (!arg.found) continue;
			if (arg.value === undefined) dynamic = true;
			else nested[key ?? "input"] = arg.value;
		}
		const evidence = dynamic ? unknown("Nested call arguments are not fully literal.") : directOperations(call.tool, nested, cwd);
		operations.push(...evidence.operations);
		if (evidence.unresolved) reasons.push(evidence.reason!);
	}
	return reasons.length ? unknown(reasons.join(" "), operations) : known(operations);
}

/** A supplied alias must also be valid and agree; never silently ignore one. */
function literalArgument(args: Record<string, unknown>, keys: string[]): string | undefined {
	const values = keys.filter((key) => Object.hasOwn(args, key)).map((key) => args[key]);
	return values.length && values.every((value) => string(value) && value === values[0])
		? values[0] as string : undefined;
}

function directOperations(name: string, args: Record<string, unknown>, cwd?: string | null): OperationEvidence {
	const tool = Object.hasOwn(PATH_TOOLS, name) ? PATH_TOOLS[name] : undefined;
	if (tool) {
		const path = literalArgument(args, tool.keys);
		if (!path || /[\0\r\n]/.test(path)) return unknown("Allowlisted file tool has no unambiguous literal path.");
		const target = normalizeFilePath(path, cwd);
		return known([
			...(CONTENT_EDITS.has(name) ? [{ kind: "read" as const, path: target }] : []),
			{ kind: tool.kind, path: target },
		]);
	}
	if (name === "apply_patch") {
		const input = string(args.input) ?? "";
		const operations: FileOperation[] = [];
		let unresolved = !/^\*\*\* Begin Patch\r?\n/.test(input) || !input.trimEnd().endsWith("*** End Patch");
		let update = false;
		for (const line of input.split(/\r?\n/)) {
			const header = /^\*\*\* (Update File|Add File|Delete File|Move to): ([^\0\r\n]+)$/.exec(line);
			if (header) {
				if (!header[2]!.trim() || (header[1] === "Move to" && !update)) unresolved = true;
				// Updates (including move sources) require the preceding contents.
				if (header[1] === "Update File") operations.push({ kind: "read", path: normalizeFilePath(header[2]!, cwd) });
				operations.push({ kind: "write", path: normalizeFilePath(header[2]!, cwd) });
				update = header[1] === "Update File";
			} else if (line.startsWith("*** ") && !["*** Begin Patch", "*** End Patch", "*** End of File"].includes(line)) unresolved = true;
		}
		return unresolved || !operations.length ? unknown("Patch is missing targets or contains unsupported directives.", operations) : known(operations);
	}
	if (!SHELL_TOOLS.has(name)) return unknown("Tool is outside the operation allowlist.");
	const command = literalArgument(args, ["command", "cmd"]);
	if (!command || /[\0\r\n]/.test(command)) return unknown("Shell command is missing or is not a single literal stage.");
	const directoryKeys = ["workdir", "working_directory", "cwd"];
	const workdir = literalArgument(args, directoryKeys);
	if (directoryKeys.some((key) => Object.hasOwn(args, key)) && (!workdir || /[\0\r\n]/.test(workdir))) {
		return unknown("Shell working directory is not an unambiguous literal path.");
	}
	const match = CAT_READ.exec(command.trim()) ?? SED_READ.exec(command.trim()) ?? HEAD_READ.exec(command.trim());
	const target = match?.[1] ?? match?.[2] ?? match?.[3];
	if (target && !target.startsWith("-")) {
		const directory = workdir ? canonicalPath(workdir.startsWith("/") || !cwd ? workdir : `${cwd}/${workdir}`) : cwd;
		const full = directory && !target.startsWith("/") ? `${directory}/${target}` : target;
		return known([{ kind: "read", path: normalizeFilePath(full, cwd) }]);
	}
	// Classification alone can hide dropped noise, control flow or redirects.
	const classified = classifyCommand(command, cwd);
	if (!/[;&|<>`$()\\*?\[\]{}!#~]/.test(command) &&
		!/^\s*(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|select)\b/.test(command) &&
		classified.length === 1 && classified[0]!.action === "test" && classified[0]!.last !== false) {
		return known([{ kind: "test" }]);
	}
	return unknown("Shell command is outside the literal read/test allowlist.");
}

/** Short human label for diagnostics; raw identifiers stay in structured fields. */
export function stepLabel(step: Step | undefined, cwd?: string | null): string {
	if (!step) return "Unknown step";
	const name = string(step.attributes[ATTR.TOOL_NAME]) ?? step.kind;
	const args = argumentsOf(step);
	const paths = [...new Set(fileOperations(step, cwd).flatMap((op) => op.path ? [op.path] : []))];
	const target = commandOf(args) ?? (paths.length ? paths.join(", ") : undefined);
	const label = `${name}${target ? ` ${target}` : ""}`.replace(/\s+/g, " ").trim();
	return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}
