/**
 * Session discovery: which transcripts were written recently enough to watch.
 *
 * The corpus is huge (thousands of historical sessions); the mtime cutoff is
 * what keeps a tick cheap — everything older than the window is never opened.
 * CC subagent sidechains count toward a session's liveness because a main
 * transcript can sit silent for minutes while a subagent grinds.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { SessionFile } from "./types.ts";

/** ENOENT/ENOTDIR are expected (file vanished mid-scan, no sidechain dir);
 * anything else (EACCES, EIO) is a real problem worth a trace in the log. */
function logUnexpected(context: string, err: unknown): void {
	const code = (err as { code?: string }).code;
	if (code === "ENOENT" || code === "ENOTDIR") return;
	console.error(`watchdog: ${context}: ${String(err)}`);
}

function mtimeAndSize(path: string): { mtimeMs: number; size: number } | null {
	try {
		const st = statSync(path);
		return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
	} catch (err) {
		logUnexpected(`stat failed for ${path}`, err);
		return null;
	}
}

function listDir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch (err) {
		logUnexpected(`readdir failed for ${path}`, err);
		return [];
	}
}

/**
 * CC layout: <root>/<encoded-project>/<session-uuid>.jsonl with sidechains at
 * <root>/<encoded-project>/<session-uuid>/subagents/agent-*.jsonl.
 */
export function scanClaudeProjects(
	root: string,
	cutoffMs: number,
): SessionFile[] {
	const out: SessionFile[] = [];
	for (const project of listDir(root)) {
		const projectDir = join(root, project);
		for (const entry of listDir(projectDir)) {
			if (!entry.endsWith(".jsonl")) continue;
			const main = join(projectDir, entry);
			const mainStat = mtimeAndSize(main);
			if (!mainStat) continue;

			const sidechainDir = join(projectDir, entry.slice(0, -6), "subagents");
			const subagentPaths: string[] = [];
			let mtimeMs = mainStat.mtimeMs;
			let sizeBytes = mainStat.size;
			for (const sub of listDir(sidechainDir)) {
				if (!sub.endsWith(".jsonl")) continue;
				const subPath = join(sidechainDir, sub);
				const subStat = mtimeAndSize(subPath);
				if (!subStat) continue;
				if (subStat.mtimeMs < cutoffMs) continue;
				subagentPaths.push(subPath);
				mtimeMs = Math.max(mtimeMs, subStat.mtimeMs);
				sizeBytes += subStat.size;
			}

			if (mtimeMs >= cutoffMs) {
				out.push({
					harness: "claude-code",
					path: main,
					subagentPaths,
					mtimeMs,
					sizeBytes,
				});
			}
		}
	}
	return out;
}

/** Codex layout: <root>/YYYY/MM/DD/rollout-*.jsonl.
 *
 * Deliberately walks the whole tree every tick rather than pruning to recent
 * day directories: `codex exec resume` appends to the ORIGINAL rollout file
 * under its start date, so an active session can live in an arbitrarily old
 * day dir. The full walk is a few ms; missing a resumed session is not. */
export function scanCodexSessions(
	root: string,
	cutoffMs: number,
): SessionFile[] {
	let entries: string[];
	try {
		entries = readdirSync(root, { recursive: true }) as string[];
	} catch (err) {
		logUnexpected(`recursive readdir failed for ${root}`, err);
		return [];
	}
	const out: SessionFile[] = [];
	for (const rel of entries) {
		if (!rel.endsWith(".jsonl")) continue;
		const path = join(root, rel);
		const st = mtimeAndSize(path);
		if (!st || st.mtimeMs < cutoffMs) continue;
		out.push({
			harness: "codex",
			path,
			subagentPaths: [],
			mtimeMs: st.mtimeMs,
			sizeBytes: st.size,
		});
	}
	return out;
}

export function scanSessions(
	claudeRoot: string,
	codexRoot: string,
	cutoffMs: number,
): SessionFile[] {
	return [
		...scanClaudeProjects(claudeRoot, cutoffMs),
		...scanCodexSessions(codexRoot, cutoffMs),
	];
}
