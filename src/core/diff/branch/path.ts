/** Lexical POSIX identities only; no filesystem or symlink claims. */
function absolute(path: string): string | null {
	if (!path.startsWith("/")) return null;
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return `/${parts.join("/")}`;
}

export function workingDirectory(root: string | null | undefined, args: Record<string, unknown>): string | null {
	const base = root ? absolute(root) : null;
	const field = ["workdir", "working_directory", "cwd"].find((name) => name in args);
	if (!field) return base;
	const value = args[field];
	if (typeof value !== "string" || !value || /[$`~*]/.test(value)) return null;
	return absolute(value.startsWith("/") ? value : base ? `${base}/${value}` : "");
}

/** External absolute paths never alias workspace-relative paths. */
export function lineagePath(path: string, root: string | null | undefined, directory = root): string | null {
	const base = root ? absolute(root) : null;
	const dir = directory ? absolute(directory) : null;
	if (!base || !dir || !path) return null;
	const resolved = absolute(path.startsWith("/") ? path : `${dir}/${path}`);
	if (!resolved) return null;
	if (resolved === base) return ".";
	const prefix = base === "/" ? base : `${base}/`;
	return resolved.startsWith(prefix) ? resolved.slice(prefix.length) : `external:${resolved}`;
}
