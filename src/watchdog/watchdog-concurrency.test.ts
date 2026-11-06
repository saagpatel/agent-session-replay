import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tick } from "./watchdog.ts";

function writeGrindSession(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const lines = Array.from({ length: 320 }, (_, i) => JSON.stringify({
		type: "assistant", sessionId: "synthetic", uuid: `u${i}`,
		timestamp: `2026-07-10T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
		cwd: "/fixture/project", message: { role: "assistant", content: [{
			type: "tool_use", id: `tu${i}`, name: i % 2 ? "Write" : "Bash", input: {},
		}] },
	}));
	writeFileSync(path, `${lines.join("\n")}\n`);
}

test("dry-run does not create a persistent state lock", async () => {
	const root = mkdtempSync(join(tmpdir(), "watchdog-dry-run-lock-"));
	const state = join(root, "state.json");
	try {
		mkdirSync(join(root, "projects"));
		mkdirSync(join(root, "codex"));
		await tick({
			claudeProjectsDir: join(root, "projects"), codexSessionsDir: join(root, "codex"),
			localAdapterPath: join(root, "unused-adapter"), localReceiptStore: join(root, "unused-receipts"),
			windowMinutes: 30, stallQuietSeconds: 600, maxSessionBytes: 1000,
			statePath: state, dryRun: true,
		}, Date.now());
		assert.equal(existsSync(`${state}.lock`), false);
		assert.equal(existsSync(state), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lock release failure still clears the in-process tick queue", async () => {
	const root = mkdtempSync(join(tmpdir(), "watchdog-lock-release-"));
	const projects = join(root, "projects");
	const state = join(root, "state.json");
	const adapter = join(root, "adapter.cjs");
	try {
		writeGrindSession(join(projects, "fixture", "session.jsonl"));
		mkdirSync(join(root, "codex"));
		writeFileSync(adapter, `#!/usr/bin/env node
const fs = require("node:fs"); let body = "";
process.stdin.on("data", chunk => body += chunk).on("end", () => {
  const event = JSON.parse(body);
  try { fs.unlinkSync(${JSON.stringify(`${state}.lock`)}); } catch {}
  console.log(JSON.stringify({ state: "accepted_by_os", stable_event_id: event.event_id }));
});
`, { mode: 0o700 });
		chmodSync(adapter, 0o700);
		const config = {
			claudeProjectsDir: projects, codexSessionsDir: join(root, "codex"),
			localAdapterPath: adapter, localReceiptStore: join(root, "receipts"),
			windowMinutes: 30, stallQuietSeconds: 600, maxSessionBytes: 64_000_000,
			statePath: state, dryRun: false,
		};
		await assert.rejects(tick(config, Date.now()), /lost state lock ownership/);
		const next = await tick(config, Date.now());
		assert.equal(next.skippedUnchanged, 1);
		assert.equal(existsSync(`${state}.lock`), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("SIGTERM drains an active CLI tick before exiting", async () => {
	const root = mkdtempSync(join(tmpdir(), "watchdog-signal-drain-"));
	const home = join(root, "home");
	const project = join(home, ".claude", "projects", "fixture");
	const state = join(home, ".local", "state", "watchdog", "state.json");
	const count = join(root, "adapter-count");
	const release = join(root, "release-adapter");
	const adapter = join(root, "adapter.cjs");
	const children: ChildProcess[] = [];
	const childErrors = new Map<ChildProcess, string[]>();
	try {
		writeGrindSession(join(project, "session.jsonl"));
		mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
		writeFileSync(adapter, `#!/usr/bin/env node
const fs = require("node:fs"); let body = "";
process.stdin.on("data", chunk => body += chunk).on("end", () => {
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify({ state: "not_found", stable_event_id: process.argv[process.argv.indexOf("--status") + 1] }));
    return;
  }
  const event = JSON.parse(body);
  fs.writeFileSync(${JSON.stringify(count)}, "1");
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    console.log(JSON.stringify({ state: "accepted_by_os", stable_event_id: event.event_id }));
  }, 5);
});
`, { mode: 0o700 });
		chmodSync(adapter, 0o700);
		const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
		const start = (once: boolean) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", mainPath,
				...(once ? ["--once"] : []), "--interval", "1", "--window", "30",
				"--adapter", adapter, "--receipts", join(root, "receipts"), "--state", state], {
				env: { HOME: home, PATH: process.env.PATH ?? "" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(child);
			const errors: string[] = [];
			childErrors.set(child, errors);
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => errors.push(chunk));
			return child;
		};
		const waitUntil = async (condition: () => boolean) => {
			const deadline = Date.now() + 5000;
			while (!condition()) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for synthetic CLI adapter: ${[...childErrors.values()].flat().join("")}`);
				await new Promise(r => setTimeout(r, 10));
			}
		};
		const waitForClose = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
			const timer = setTimeout(() => reject(new Error(`watchdog CLI did not exit: ${childErrors.get(child)?.join("") ?? ""}`)), 10000);
			child.once("close", (code, signal) => {
				clearTimeout(timer);
				resolveClose({ code, signal });
			});
		});
		const first = start(false);
		await waitUntil(() => existsSync(count));
		assert.equal(existsSync(`${state}.lock`), true);
		first.kill("SIGTERM");
		await new Promise(r => setTimeout(r, 100));
		assert.equal(first.exitCode, null, "SIGTERM should wait for the active tick to finish");
		const firstExitWait = waitForClose(first);
		writeFileSync(release, "go");
		const firstExit = await firstExitWait;
		assert.deepEqual(firstExit, { code: 143, signal: null });
		assert.equal(existsSync(`${state}.lock`), false);
		const restarted = start(true);
		const restartExit = await waitForClose(restarted);
		assert.deepEqual(restartExit, { code: 0, signal: null });
		assert.equal(existsSync(`${state}.lock`), false);
	} finally {
		writeFileSync(release, "go");
		for (const child of children) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const closed = new Promise<void>(resolveClose => child.once("close", () => resolveClose()));
			child.kill("SIGKILL");
			await closed;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("separate normal watchdog callers share one state-path critical section", async () => {
	const root = mkdtempSync(join(tmpdir(), "watchdog-cross-process-"));
	const projectsA = join(root, "projects-a");
	const projectsB = join(root, "projects-b");
	const codex = join(root, "codex");
	const state = join(root, "state.json");
	const count = join(root, "adapter-count");
	const release = join(root, "release-adapter");
	const adapter = join(root, "adapter.cjs");
	const children: ChildProcess[] = [];
	const childErrors: string[] = [];
	try {
		writeGrindSession(join(projectsA, "fixture-a", "session.jsonl"));
		writeGrindSession(join(projectsB, "fixture-b", "session.jsonl"));
		mkdirSync(codex, { recursive: true });
		writeFileSync(adapter, `#!/usr/bin/env node
const fs = require("node:fs"); let body = "";
process.stdin.on("data", chunk => body += chunk).on("end", () => {
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify({ state: "not_found", stable_event_id: process.argv[process.argv.indexOf("--status") + 1] }));
    return;
  }
  const event = JSON.parse(body);
  const n = Number(fs.existsSync(${JSON.stringify(count)}) ? fs.readFileSync(${JSON.stringify(count)}, "utf8") : "0") + 1;
  fs.writeFileSync(${JSON.stringify(count)}, String(n));
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    console.log(JSON.stringify({ state: "accepted_by_os", stable_event_id: event.event_id }));
  }, 5);
});
`, { mode: 0o700 });
		chmodSync(adapter, 0o700);
		const moduleUrl = new URL("./watchdog.ts", import.meta.url).href;
		const source = `import { tick } from ${JSON.stringify(moduleUrl)};
await tick({ claudeProjectsDir: process.env.PROJECTS, codexSessionsDir: process.env.CODEX,
 localAdapterPath: process.env.ADAPTER, localReceiptStore: process.env.RECEIPTS,
 windowMinutes: 30, stallQuietSeconds: 600, maxSessionBytes: 64000000,
 statePath: process.env.STATE, dryRun: false }, Date.now());`;
		const start = (projects: string) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
				env: { PATH: process.env.PATH ?? "", PROJECTS: projects, CODEX: codex,
					ADAPTER: adapter, RECEIPTS: join(root, "receipts"), STATE: state },
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(child);
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => childErrors.push(chunk));
			return child;
		};
		const waitUntil = async (condition: () => boolean) => {
			const deadline = Date.now() + 5000;
			while (!condition()) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for synthetic adapter: ${childErrors.join("")}`);
				await new Promise(r => setTimeout(r, 10));
			}
		};
		const first = start(projectsA);
		await waitUntil(() => existsSync(count));
		const second = start(projectsB);
		await waitUntil(() => second.exitCode !== null ||
			(existsSync(count) && Number(readFileSync(count, "utf8")) >= 2));
		const observed = Number(readFileSync(count, "utf8"));
		writeFileSync(release, "go");
		const exits = await Promise.all(children.map(child => new Promise<number | null>(resolveExit => {
			if (child.exitCode !== null) return resolveExit(child.exitCode);
			child.once("close", resolveExit);
		})));
		assert.equal(exits.filter(code => code === 0).length, 1, childErrors.join(""));
		assert.equal(observed, 1, "overlapping processes must not both invoke the local adapter");
		assert.ok(exits.some(code => code !== 0), "one overlapping tick should fail closed while state is owned");
		assert.equal(existsSync(`${state}.lock`), false, "the successful tick releases its lock");
		assert.equal(Object.keys(JSON.parse(readFileSync(state, "utf8")).sessions).length, 1);
	} finally {
		writeFileSync(release, "go");
		for (const child of children) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const closed = new Promise<void>(resolveClose => child.once("close", () => resolveClose()));
			child.kill("SIGKILL");
			await closed;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
