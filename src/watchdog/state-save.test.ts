import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { saveState, type WatchdogState } from "./state.ts";

const uuid = "00000000-0000-4000-8000-000000000001";
const nextUuid = "00000000-0000-4000-8000-000000000002";
const state: WatchdogState = { sessions: {
	"/synthetic/session.jsonl": { findings: ["grind_loop@warning"], updatedMs: 2 },
} };
const serialized = JSON.stringify(state, null, "\t");

function fixture() {
	const root = fs.mkdtempSync(join(tmpdir(), "watchdog-owned-stage-"));
	const path = join(root, "state.json");
	fs.writeFileSync(path, '{"sessions":{},"before":"A"}');
	return { root, path, staging: `${path}.${uuid}.tmp` };
}

function snapshot(path: string) {
	const stat = fs.lstatSync(path, { bigint: true });
	return {
		dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink,
		size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
		content: stat.isFile() ? fs.readFileSync(path) : undefined,
		link: stat.isSymbolicLink() ? fs.readlinkSync(path) : undefined,
		entries: stat.isDirectory() ? fs.readdirSync(path).sort() : undefined,
	};
}

function pinName(t: TestContext) {
	t.mock.method(crypto, "randomUUID", () => uuid);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

for (const kind of ["regular file", "symlink", "directory"] as const) {
	test(`exclusive staging refuses a foreign ${kind} without changing state or witness`, (t) => {
		const { root, path, staging } = fixture();
		const witness = join(root, "witness");
		fs.writeFileSync(witness, "protected witness");
		if (kind === "regular file") fs.writeFileSync(staging, "foreign staging");
		if (kind === "symlink") fs.symlinkSync(witness, staging);
		if (kind === "directory") {
			fs.mkdirSync(staging);
			fs.writeFileSync(join(staging, "foreign-child"), "protected child");
		}
		const before = [snapshot(path), snapshot(staging), snapshot(witness)];
		const entries = fs.readdirSync(root).sort();
		pinName(t);
		assert.throws(() => saveState(path, state), { code: "EEXIST" });
		assert.deepEqual([snapshot(path), snapshot(staging), snapshot(witness)], before);
		assert.deepEqual(fs.readdirSync(root).sort(), entries);
		if (kind === "directory") assert.equal(fs.readFileSync(join(staging, "foreign-child"), "utf8"), "protected child");
	});
}

test("a complete successful replacement leaves a regular B and protects legacy PID staging", (t) => {
	const { root, path, staging } = fixture();
	const legacy = `${path}.${process.pid}.tmp`;
	const witness = join(root, "witness");
	fs.writeFileSync(witness, "protected legacy witness");
	fs.symlinkSync(witness, legacy);
	const before = [snapshot(legacy), snapshot(witness)];
	pinName(t);
	saveState(path, state);
	assert.equal(fs.lstatSync(path).isFile(), true);
	assert.equal(fs.readFileSync(path, "utf8"), serialized);
	assert.equal(fs.existsSync(staging), false);
	assert.deepEqual([snapshot(legacy), snapshot(witness)], before);
	assert.deepEqual(fs.readdirSync(root).sort(), ["state.json", `state.json.${process.pid}.tmp`, "witness"].sort());
});

test("fresh state creates nested parents and leaves no staging", (t) => {
	const root = fs.mkdtempSync(join(tmpdir(), "watchdog-owned-fresh-"));
	const parent = join(root, "nested", "deeper");
	const path = join(parent, "state.json");
	pinName(t);
	saveState(path, state);
	assert.equal(fs.readFileSync(path, "utf8"), serialized);
	assert.equal(fs.lstatSync(path).isFile(), true);
	assert.deepEqual(fs.readdirSync(parent), ["state.json"]);
});

test("a partial write failure closes its descriptor and retains private staging with A unchanged", (t) => {
	const { path, staging } = fixture();
	const before = snapshot(path);
	const nativeWrite = fs.writeFileSync;
	const failure = new Error("synthetic partial write failure");
	let descriptor: number | undefined;
	pinName(t);
	t.mock.method(fs, "writeFileSync", (fd: number, bytes: string) => {
		descriptor = fd;
		nativeWrite(fd, bytes.slice(0, 11));
		throw failure;
	});
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), error => error === failure);
	assert.deepEqual(snapshot(path), before);
	assert.equal(fs.readFileSync(staging, "utf8"), serialized.slice(0, 11));
	assert.equal(fs.statSync(staging).mode & 0o777, 0o600);
	assert.equal(typeof descriptor, "number");
	assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
});

test("a rename failure retains complete staging and a later save uses a fresh name", (t) => {
	const { root, path, staging } = fixture();
	const before = snapshot(path);
	const failure = Object.assign(new Error("synthetic rename failure"), { code: "EACCES" });
	pinName(t);
	t.mock.method(fs, "renameSync", () => { throw failure; });
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), error => error === failure);
	assert.deepEqual(snapshot(path), before);
	assert.equal(fs.readFileSync(staging, "utf8"), serialized);
	assert.equal(fs.statSync(staging).mode & 0o777, 0o600);
	const retained = snapshot(staging);
	t.mock.restoreAll();
	syncBuiltinESMExports();
	t.mock.method(crypto, "randomUUID", () => nextUuid);
	syncBuiltinESMExports();
	saveState(path, state);
	assert.equal(fs.readFileSync(path, "utf8"), serialized);
	assert.deepEqual(snapshot(staging), retained);
	assert.deepEqual(fs.readdirSync(root).sort(), ["state.json", `state.json.${uuid}.tmp`].sort());
});

test("a close failure skips rename and retains complete staging with A unchanged", (t) => {
	const { path, staging } = fixture();
	const before = snapshot(path);
	const nativeClose = fs.closeSync;
	const failure = new Error("synthetic close failure");
	let descriptor: number | undefined;
	pinName(t);
	t.mock.method(fs, "closeSync", (fd: number) => {
		descriptor = fd;
		nativeClose(fd);
		throw failure;
	});
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), error => error === failure);
	t.mock.restoreAll();
	syncBuiltinESMExports();
	assert.deepEqual(snapshot(path), before);
	assert.equal(fs.readFileSync(staging, "utf8"), serialized);
	assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
});

test("exception handling never pathname-deletes a replacement staged during a failed write", (t) => {
	const { path, staging } = fixture();
	const before = snapshot(path);
	const displaced = staging + ".displaced";
	const nativeWrite = fs.writeFileSync;
	const failure = new Error("synthetic write failure after namespace substitution");
	pinName(t);
	t.mock.method(fs, "writeFileSync", (fd: number, bytes: string) => {
		nativeWrite(fd, bytes.slice(0, 11));
		fs.renameSync(staging, displaced);
		nativeWrite(staging, "foreign replacement");
		throw failure;
	});
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), error => error === failure);
	assert.deepEqual(snapshot(path), before);
	assert.equal(fs.readFileSync(staging, "utf8"), "foreign replacement");
	assert.equal(fs.readFileSync(displaced, "utf8"), serialized.slice(0, 11));
});

test("serialization failure creates no parent or staging", () => {
	const root = fs.mkdtempSync(join(tmpdir(), "watchdog-owned-serialize-"));
	const path = join(root, "nested", "state.json");
	const circular: WatchdogState = { sessions: {} };
	Object.assign(circular.sessions, { circular });
	assert.throws(() => saveState(path, circular), TypeError);
	assert.deepEqual(fs.readdirSync(root), []);
});
