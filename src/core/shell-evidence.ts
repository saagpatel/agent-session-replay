/** Narrow, evidence-only shell policy for branch lineage and commit claims. */
type Args = Record<string, unknown>;
export type ShellEvidence = {
	kind: "read" | "restore" | "whole-restore" | "add" | "commit" | "move";
	command: string;
	paths?: string[];
	staged?: boolean;
	/** Defined only for literal staging forms whose coverage is known. */
	stagePaths?: string[];
	/** Pathless -A/--all covers the repository, independently of workdir. */
	stageRepository?: true;
	/** Undefined for pathspec commits or unsupported commit options. */
	commitWorktree?: boolean;
};

type Token = { kind: "word" | "op"; text: string };

/** Literal words and optional && operators; no other shell control or expansion. */
function words(command: string, allowChain = false): Token[] | null {
	const out: Token[] = [];
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
			if (started) out.push({ kind: "word", text: word });
			word = ""; started = false;
		} else if (allowChain && command.slice(i, i + 2) === "&&") {
			if (started) out.push({ kind: "word", text: word });
			out.push({ kind: "op", text: "&&" }); word = ""; started = false; i++;
		} else {
			if (/[|;&<>$`\\(){}*?\[\]~#]/.test(c)) return null;
			word += c; started = true;
		}
	}
	if (quote) return null;
	if (started) out.push({ kind: "word", text: word });
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

/** Bare test forms only; arbitrary test flags can write reports or snapshots. */
function literalTest(tokens: string[]): boolean {
	const exact = (...expected: string[]) => tokens.length === expected.length && tokens.every((token, i) => token === expected[i]);
	if (exact("pnpm", "test") || exact("npm", "test") || exact("npm", "run", "test") ||
		exact("yarn", "test") || exact("pnpm", "vitest", "run") || exact("cargo", "test")) return true;
	if ((tokens[0] === "node" && tokens[1] === "--test") || (tokens[0] === "go" && tokens[1] === "test"))
		return tokens.length > 2 && tokens.slice(2).every(path);
	const args = tokens[0] === "pytest" ? tokens.slice(1)
		: tokens[0] === "python" && tokens[1] === "-m" && tokens[2] === "pytest" ? tokens.slice(3) : null;
	if (!args) return false;
	// Pytest argument files can hide options, so they are not literal path operands.
	if (args.some((arg) => arg.startsWith("@"))) return false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "-q" || arg === "-x") continue;
		if (arg === "-k") {
			if (!path(args[++i] ?? "")) return false;
		} else if (!path(arg)) return false;
	}
	return true;
}

function commitWorktree(args: string[]): boolean | undefined {
	let all = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "-a" || arg === "--all") all = true;
		else if (["-m", "-am"].includes(arg)) {
			if (args[++i] === undefined) return undefined;
			if (arg === "-am") all = true;
		} else if (arg.startsWith("--message=") || (arg.startsWith("-m") && arg.length > 2)) continue;
		else if (arg !== "--allow-empty") return undefined;
	}
	return all;
}

export function shellEvidence(command: string): ShellEvidence | null {
	const parsed = words(command, true);
	if (!parsed) return null;
	const chain = parsed.findIndex((token) => token.kind === "op");
	if (chain >= 0) {
		if (parsed.some((token, i) => token.kind === "op" && i !== chain) || chain < 3) return null;
		const first = parsed.slice(0, chain).map((token) => token.text);
		const last = parsed.slice(chain + 1).map((token) => token.text);
		if (first[0] !== "git" || first[1] !== "add" || last[0] !== "git" || last[1] !== "commit" || commitWorktree(last.slice(2)) === undefined) return null;
		return { kind: "commit", command, staged: true };
	}
	const tokens = parsed.map((token) => token.text);
	if (tokens.length === 3 && /^(?:\/bin\/)?(?:sh|bash|zsh)$/.test(tokens[0]!) && /^-l?c$/.test(tokens[1]!)) return shellEvidence(tokens[2]!);
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
		if (verb === "add") {
			const paths = rest[0] === "--" ? rest.slice(1) : rest;
			if (rest.length === 1 && ["-A", "--all"].includes(rest[0]!)) return { ...result("add"), stageRepository: true };
			const stagePaths = paths.length && paths.every(literalPath) ? paths : undefined;
			return { ...result("add"), ...(stagePaths ? { stagePaths } : {}) };
		}
		if (verb === "mv" && rest.length === 2 && rest.every(literalPath)) return result("move", rest);
		if (verb === "commit") {
			const worktree = commitWorktree(rest);
			return worktree === undefined ? null : { ...result("commit"), commitWorktree: worktree };
		}
		return null;
	}
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd ?? "")) return null;
	return literalTest(tokens) ? result("read") : null;
}

export function isCommitCommand(args: Args): boolean {
	const allowed = new Set(["command", "cmd", "workdir", "description", "timeout", "timeout_ms", "yield_time_ms", "max_output_tokens"]);
	if (Object.keys(args).some((key) => !allowed.has(key))) return false;
	const command = shellCommand(args);
	return command !== undefined && shellEvidence(command)?.kind === "commit";
}

/** A hook can print a lookalike, so multiple headers prove no identity. */
export function commitHeader(output: string): { branch: string; short: string } | undefined {
	const matches = [...output.matchAll(/^\[(.+?)(?: \(root-commit\))? ([0-9a-fA-F]{4,40})\] .+$/gm)];
	if (matches.length !== 1) return undefined;
	return { branch: matches[0]![1]!, short: matches[0]![2]! };
}
