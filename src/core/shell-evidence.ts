/** Narrow, evidence-only shell policy for branch lineage and commit claims. */
import { classifyCommand } from "./diff/normalize.ts";

type Args = Record<string, unknown>;
export type ShellEvidence = {
	kind: "read" | "restore" | "whole-restore" | "add" | "commit" | "move";
	command: string;
	paths?: string[];
	staged?: boolean;
};

/** Literal words only: no shell control, expansion, redirects or assignments. */
function words(command: string, allowChain = false): string[] | null {
	const out: string[] = [];
	let word = "";
	let started = false;
	let quote = "";
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (/[\r\n\u0000]/.test(c)) return null;
		if (quote) {
			if (c === quote) quote = "";
			else {
				if (quote === '"' && /[$`\\]/.test(c)) return null;
				word += c;
			}
		} else if (c === "'" || c === '"') { quote = c; started = true; }
		else if (/\s/.test(c)) {
			if (started) out.push(word);
			word = ""; started = false;
		} else if (allowChain && command.slice(i, i + 2) === "&&") {
			if (started) out.push(word);
			out.push("&&"); word = ""; started = false; i++;
		} else {
			if (/[|;&<>$`\\(){}*?\[\]~#]/.test(c)) return null;
			word += c; started = true;
		}
	}
	if (quote) return null;
	if (started) out.push(word);
	return out.length ? out : null;
}

/** Only a shell argv wrapper can contain shell text; other argv stay literal. */
export function shellCommand(args: Args): string | undefined {
	const value = args["command"] ?? args["cmd"];
	if (typeof value === "string") return value;
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return undefined;
	if (value.length === 3 && /^(?:\/bin\/)?(?:sh|bash|zsh)$/.test(value[0] ?? "") && /^-l?c$/.test(value[1] ?? "")) return value[2];
	return value.map((v: string) => `'${v.replaceAll("'", "'\\''")}'`).join(" ");
}

const SEARCH_FLAGS = new Set(["-n", "-i", "-w", "-l", "-F", "-r", "--no-heading"]);
const path = (s: string) => s.length > 0 && !s.startsWith("-");
// Git interprets pathspec syntax even after the shell removes quotes.
const literalPath = (s: string) => path(s) && !s.startsWith(":") && !/[*?\[]/.test(s);

export function shellEvidence(command: string): ShellEvidence | null {
	const tokens = words(command, true);
	if (!tokens) return null;
	if (tokens.length === 3 && /^(?:\/bin\/)?(?:sh|bash|zsh)$/.test(tokens[0]!) && /^-l?c$/.test(tokens[1]!)) return shellEvidence(tokens[2]!);
	const chain = tokens.indexOf("&&");
	if (chain >= 0) {
		if (tokens.lastIndexOf("&&") !== chain || chain < 3) return null;
		const first = tokens.slice(0, chain);
		const last = tokens.slice(chain + 1);
		if (first[0] !== "git" || first[1] !== "add" || last[0] !== "git" || last[1] !== "commit") return null;
		return { kind: "commit", command, staged: true };
	}
	const [cmd, ...args] = tokens;
	const result = (kind: ShellEvidence["kind"], paths?: string[]): ShellEvidence => ({ kind, command, ...(paths ? { paths } : {}) });
	if (cmd === "cat" && args.length === 1 && path(args[0]!)) return result("read");
	if (cmd === "sed" && args.length === 3 && args[0] === "-n" && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[1]!) && path(args[2]!)) return result("read");
	if (cmd === "head" && args.length === 3 && args[0] === "-n" && /^\d+$/.test(args[1]!) && path(args[2]!)) return result("read");
	if (cmd === "ls" && (args.length === 0 || (args.length === 1 && path(args[0]!)))) return result("read");
	if ((cmd === "rg" || cmd === "grep") && args.some(path) && args.every((a) => !a.startsWith("-") || SEARCH_FLAGS.has(a))) return result("read");
	if (cmd === "git") {
		const [verb, ...rest] = args;
		if (["status", "diff", "log", "show"].includes(verb ?? "") && !rest.some((a) => /^(?:--output(?:=|$)|-o|--ext-diff$|--textconv$)/.test(a))) return result("read");
		if (verb === "checkout" && rest[0] === "--" && rest.length > 1 && rest.slice(1).every(literalPath)) return result("restore", rest.slice(1));
		if (verb === "restore") {
			const paths = rest[0] === "--" ? rest.slice(1) : rest;
			if (paths.length && paths.every(literalPath)) return result("restore", paths);
		}
		if ((verb === "stash" && (rest.length === 0 || (rest.length === 1 && rest[0] === "push"))) || (verb === "reset" && rest.length === 1 && rest[0] === "--hard")) return result("whole-restore");
		if (verb === "add") return result("add");
		if (verb === "mv" && rest.length === 2 && rest.every(literalPath)) return result("move", rest);
		if (verb === "commit") return result("commit");
		return null;
	}
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd ?? "")) return null;
	const classes = classifyCommand(command, undefined);
	return classes.length === 1 && classes[0]?.action === "test" ? result("read") : null;
}

export function isCommitCommand(args: Args): boolean {
	if (args["env"] && Object.keys(Object(args["env"])).length) return false;
	const command = shellCommand(args);
	return command !== undefined && shellEvidence(command)?.kind === "commit";
}
