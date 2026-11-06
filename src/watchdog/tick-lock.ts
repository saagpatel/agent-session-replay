import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Own the state-path lock for one tick. The lock is deliberately never
 * reclaimed automatically: after a crash, an operator must confirm the PID
 * is no longer running before removing the stale sibling `.lock` file.
 */
export function acquireTickLock(statePath: string): () => void {
	const lockPath = `${resolve(statePath)}.lock`;
	mkdirSync(dirname(lockPath), { recursive: true });
	const token = randomUUID();
	const contents = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token })}\n`;
	let fd: number;
	try {
		fd = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`watchdog tick already owns state path; inspect ${lockPath}`);
		}
		throw error;
	}
	let createdIdentity: ReturnType<typeof fstatSync> | undefined;
	try {
		createdIdentity = fstatSync(fd);
		writeFileSync(fd, contents, "utf8");
		closeSync(fd);
	} catch (error) {
		try { closeSync(fd); } catch { /* already closed or descriptor state unknown */ }
		if (createdIdentity) {
			try {
				const current = lstatSync(lockPath);
				if (current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) {
					unlinkSync(lockPath);
				}
			} catch { /* preserve the original failure; an unknown lock stays fail-closed */ }
		}
		throw error;
	}
	return () => {
		// Do not unlink a path whose ownership changed while this tick ran.
		let current: string;
		try {
			current = readFileSync(lockPath, "utf8");
		} catch {
			throw new Error("watchdog tick lost state lock ownership before release");
		}
		if (current !== contents) {
			throw new Error("watchdog tick lost state lock ownership before release");
		}
		unlinkSync(lockPath);
	};
}
