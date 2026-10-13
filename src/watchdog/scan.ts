/** Session discovery with explicit reporting for incomplete filesystem coverage. */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DiscoveryDiagnostic, SessionFile, SessionScanResult } from "./types.ts";

type FileSystem = Pick<typeof import("node:fs"), "readdirSync" | "statSync">;
const expectedAbsence = new Set(["ENOENT", "ENOTDIR"]);

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error &&
		typeof error.code === "string" ? error.code : "UNKNOWN";
}

function diagnostic(operation: "readdir" | "stat", path: string, error: unknown): DiscoveryDiagnostic | null {
	const code = errorCode(error);
	if (expectedAbsence.has(code)) return null;
	return { operation, code, path, message: String(error) };
}

function listDir(path: string, fs: FileSystem, diagnostics: DiscoveryDiagnostic[], recursive = false): string[] {
	try {
		return (fs.readdirSync as typeof readdirSync)(path, recursive ? { recursive: true } : undefined) as string[];
	} catch (error) {
		const row = diagnostic("readdir", path, error);
		if (row) diagnostics.push(row);
		return [];
	}
}

function mtimeAndSize(path: string, fs: FileSystem, diagnostics: DiscoveryDiagnostic[]): { mtimeMs: number; size: number } | null {
	try {
		const st = fs.statSync(path);
		return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
	} catch (error) {
		const row = diagnostic("stat", path, error);
		if (row) diagnostics.push(row);
		return null;
	}
}

export function scanClaudeProjects(root: string, cutoffMs: number, fs: FileSystem = { readdirSync, statSync }): SessionScanResult {
	const sessions: SessionFile[] = [];
	const diagnostics: DiscoveryDiagnostic[] = [];
	for (const project of listDir(root, fs, diagnostics)) {
		const projectDir = join(root, project);
		for (const entry of listDir(projectDir, fs, diagnostics)) {
			if (!entry.endsWith(".jsonl")) continue;
			const main = join(projectDir, entry);
			const mainStat = mtimeAndSize(main, fs, diagnostics);
			if (!mainStat) continue;
			const sidechainDir = join(projectDir, entry.slice(0, -6), "subagents");
			const subagentPaths: string[] = [];
			let mtimeMs = mainStat.mtimeMs;
			let sizeBytes = mainStat.size;
			for (const sub of listDir(sidechainDir, fs, diagnostics)) {
				if (!sub.endsWith(".jsonl")) continue;
				const subPath = join(sidechainDir, sub);
				const subStat = mtimeAndSize(subPath, fs, diagnostics);
				if (!subStat || subStat.mtimeMs < cutoffMs) continue;
				subagentPaths.push(subPath);
				mtimeMs = Math.max(mtimeMs, subStat.mtimeMs);
				sizeBytes += subStat.size;
			}
			if (mtimeMs >= cutoffMs) sessions.push({ harness: "claude-code", path: main, subagentPaths, mtimeMs, sizeBytes });
		}
	}
	return { sessions, diagnostics };
}

export function scanCodexSessions(root: string, cutoffMs: number, fs: FileSystem = { readdirSync, statSync }): SessionScanResult {
	const diagnostics: DiscoveryDiagnostic[] = [];
	// Codex resumes can revisit older date directories, so inspect the full session tree.
	const entries = listDir(root, fs, diagnostics, true);
	const sessions: SessionFile[] = [];
	for (const rel of entries) {
		if (!rel.endsWith(".jsonl")) continue;
		const path = join(root, rel);
		const st = mtimeAndSize(path, fs, diagnostics);
		if (!st || st.mtimeMs < cutoffMs) continue;
		sessions.push({ harness: "codex", path, subagentPaths: [], mtimeMs: st.mtimeMs, sizeBytes: st.size });
	}
	return { sessions, diagnostics };
}

export function scanSessions(claudeRoot: string, codexRoot: string, cutoffMs: number, fs: FileSystem = { readdirSync, statSync }): SessionScanResult {
	const claude = scanClaudeProjects(claudeRoot, cutoffMs, fs);
	const codex = scanCodexSessions(codexRoot, cutoffMs, fs);
	return { sessions: [...claude.sessions, ...codex.sessions], diagnostics: [...claude.diagnostics, ...codex.diagnostics] };
}
