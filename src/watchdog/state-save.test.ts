import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { saveState, type WatchdogState } from "./state.ts";

const state: WatchdogState = { sessions: {
	"/synthetic/session.jsonl": { findings: ["grind_loop@warning"], updatedMs: 2 },
} };
const serialized = JSON.stringify(state, null, "\t");

function fixture() {
	const root = fs.mkdtempSync(join(tmpdir(), "watchdog-owned-stage-"));
	const path = join(root, "state.json");
	fs.writeFileSync(path, '{"sessions":{},"before":"A"}');
	return { root, path, staging: `${path}.owned-stage.tmp` };
}

function readRegular(path: string, expected?: fs.BigIntStats) {
	const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd, { bigint: true });
		assert.equal(stat.isFile(), true);
		if (expected) {
			assert.equal(stat.dev, expected.dev);
			assert.equal(stat.ino, expected.ino);
		}
		return fs.readFileSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function snapshot(path: string) {
	const stat = fs.lstatSync(path, { bigint: true });
	return {
		dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink,
		size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
		content: stat.isFile() ? readRegular(path, stat) : undefined,
		link: stat.isSymbolicLink() ? fs.readlinkSync(path) : undefined,
		entries: stat.isDirectory() ? fs.readdirSync(path).sort() : undefined,
	};
}

function restoreExportsAfterTest(t: TestContext) {
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
		restoreExportsAfterTest(t);
		assert.throws(() => saveState(path, state), { code: "EEXIST" });
		assert.deepEqual([snapshot(path), snapshot(staging), snapshot(witness)], before);
		assert.deepEqual(fs.readdirSync(root).sort(), entries);
		if (kind === "directory") assert.equal(readRegular(join(staging, "foreign-child")).toString("utf8"), "protected child");
	});
}

test("a complete successful replacement leaves a regular B and protects legacy PID staging", (t) => {
	const { root, path, staging } = fixture();
	const legacy = `${path}.${process.pid}.tmp`;
	const witness = join(root, "witness");
	fs.writeFileSync(witness, "protected legacy witness");
	fs.symlinkSync(witness, legacy);
	const before = [snapshot(legacy), snapshot(witness)];
	restoreExportsAfterTest(t);
	saveState(path, state);
	assert.equal(readRegular(path).toString("utf8"), serialized);
	assert.equal(fs.existsSync(staging), false);
	assert.deepEqual([snapshot(legacy), snapshot(witness)], before);
	assert.deepEqual(fs.readdirSync(root).sort(), ["state.json", `state.json.${process.pid}.tmp`, "witness"].sort());
});

test("fresh state creates nested parents and leaves no staging", (t) => {
	const root = fs.mkdtempSync(join(tmpdir(), "watchdog-owned-fresh-"));
	const parent = join(root, "nested", "deeper");
	const path = join(parent, "state.json");
	restoreExportsAfterTest(t);
	saveState(path, state);
	assert.equal(readRegular(path).toString("utf8"), serialized);
	assert.deepEqual(fs.readdirSync(parent), ["state.json"]);
});

test("a partial write failure closes its descriptor and retains private staging with A unchanged", (t) => {
	const { path, staging } = fixture();
	const before = snapshot(path);
	const nativeWrite = fs.writeFileSync;
	const failure = new Error("synthetic partial write failure");
	let descriptor: number | undefined;
	restoreExportsAfterTest(t);
	t.mock.method(fs, "writeFileSync", (fd: number, bytes: string) => {
		descriptor = fd;
		nativeWrite(fd, bytes.slice(0, 11));
		throw failure;
	});
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), error => error === failure);
	assert.deepEqual(snapshot(path), before);
	assert.equal(readRegular(staging).toString("utf8"), serialized.slice(0, 11));
	assert.equal(snapshot(staging).mode & 0o777n, 0o600n);
	assert.equal(typeof descriptor, "number");
	assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
	const retainedInode = snapshot(staging).ino;
	t.mock.restoreAll();
	syncBuiltinESMExports();
	saveState(path, state);
	assert.equal(snapshot(path).ino, retainedInode);
	assert.equal(readRegular(path).toString("utf8"), serialized);
	assert.equal(fs.existsSync(staging), false);
});

test("repeated rename failures reuse one owned slot and recover with the latest state", (t) => {
	const { root, path, staging } = fixture();
	const before = snapshot(path);
	const failure = Object.assign(new Error("synthetic rename failure"), { code: "EACCES" });
	restoreExportsAfterTest(t);
	t.mock.method(fs, "renameSync", () => { throw failure; });
	syncBuiltinESMExports();
	for (let attempt = 0; attempt < 20; attempt++) {
		assert.throws(() => saveState(path, state), error => error === failure);
		assert.deepEqual(fs.readdirSync(root).sort(), ["state.json", "state.json.owned-stage.tmp"]);
	}
	assert.deepEqual(snapshot(path), before);
	assert.equal(readRegular(staging).toString("utf8"), serialized);
	assert.equal(snapshot(staging).mode & 0o777n, 0o600n);
	const retained = snapshot(staging);
	assert.throws(() => saveState(path, { sessions: {} }), error => error === failure);
	assert.equal(snapshot(staging).ino, retained.ino);
	assert.equal(readRegular(staging).toString("utf8"), JSON.stringify({ sessions: {} }, null, "\t"));
	t.mock.restoreAll();
	syncBuiltinESMExports();
	saveState(path, state);
	assert.equal(readRegular(path).toString("utf8"), serialized);
	assert.equal(fs.existsSync(staging), false);
	assert.deepEqual(fs.readdirSync(root), ["state.json"]);
	// Success clears ownership memory, allowing a new exclusive creation.
	saveState(path, { sessions: {} });
	assert.equal(readRegular(path).toString("utf8"), JSON.stringify({ sessions: {} }, null, "\t"));
	assert.deepEqual(fs.readdirSync(root), ["state.json"]);
});

test("a close failure skips rename and retains complete staging with A unchanged", (t) => {
	const { path, staging } = fixture();
	const before = snapshot(path);
	const nativeClose = fs.closeSync;
	const failure = new Error("synthetic close failure");
	let descriptor: number | undefined;
	restoreExportsAfterTest(t);
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
	assert.equal(readRegular(staging).toString("utf8"), serialized);
	assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
	const retained = snapshot(staging);
	assert.throws(() => saveState(path, { sessions: {} }), { code: "ESTALE" });
	assert.deepEqual(snapshot(staging), retained);
});

test("exception handling never pathname-deletes a replacement staged during a failed write", (t) => {
	const { path, staging } = fixture();
	const before = snapshot(path);
	const displaced = staging + ".displaced";
	const nativeWrite = fs.writeFileSync;
	const failure = new Error("synthetic write failure after namespace substitution");
	restoreExportsAfterTest(t);
	t.mock.method(fs, "writeFileSync", (fd: number, bytes: string) => {
		nativeWrite(fd, bytes.slice(0, 11));
		fs.renameSync(staging, displaced);
		nativeWrite(staging, "foreign replacement");
		throw failure;
	});
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), error => error === failure);
	assert.deepEqual(snapshot(path), before);
	assert.equal(readRegular(staging).toString("utf8"), "foreign replacement");
	assert.equal(readRegular(displaced).toString("utf8"), serialized.slice(0, 11));
});

test("serialization failure creates no parent or staging", () => {
	const root = fs.mkdtempSync(join(tmpdir(), "watchdog-owned-serialize-"));
	const path = join(root, "nested", "state.json");
	const circular: WatchdogState = { sessions: {} };
	Object.assign(circular.sessions, { circular });
	assert.throws(() => saveState(path, circular), TypeError);
	assert.deepEqual(fs.readdirSync(root), []);
});

test("a fresh process refuses an unknown retained slot without changing it", (t) => {
	const { root, path, staging } = fixture();
	restoreExportsAfterTest(t);
	t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" }); });
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), { code: "EIO" });
	t.mock.restoreAll();
	syncBuiltinESMExports();
	const before = [snapshot(path), snapshot(staging)];
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
		"const { saveState } = await import(process.argv[1]); saveState(process.argv[2], { sessions: {} });",
		new URL("./state.ts", import.meta.url).href, path], { encoding: "utf8", timeout: 5000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /EEXIST/);
	assert.deepEqual([snapshot(path), snapshot(staging)], before);
	assert.deepEqual(fs.readdirSync(root).sort(), ["state.json", "state.json.owned-stage.tmp"]);
});

test("an identity observation failure leaves one unknown slot and blocks retries", (t) => {
	const { root, path, staging } = fixture();
	restoreExportsAfterTest(t);
	t.mock.method(fs, "fstatSync", () => { throw new Error("synthetic identity failure"); });
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), /synthetic identity failure/);
	t.mock.restoreAll();
	syncBuiltinESMExports();
	const before = [snapshot(path), snapshot(staging)];
	assert.throws(() => saveState(path, state), { code: "ESTALE" });
	assert.deepEqual([snapshot(path), snapshot(staging)], before);
	assert.deepEqual(fs.readdirSync(root).sort(), ["state.json", "state.json.owned-stage.tmp"]);
});

test("an exclusive open failure creates no slot or ownership record", (t) => {
	const { root, path, staging } = fixture();
	const before = snapshot(path);
	restoreExportsAfterTest(t);
	t.mock.method(fs, "openSync", () => { throw Object.assign(new Error("synthetic permission failure"), { code: "EACCES" }); });
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), { code: "EACCES" });
	t.mock.restoreAll();
	syncBuiltinESMExports();
	assert.deepEqual(snapshot(path), before);
	assert.equal(fs.existsSync(staging), false);
	assert.deepEqual(fs.readdirSync(root), ["state.json"]);
	saveState(path, state);
	assert.equal(readRegular(path).toString("utf8"), serialized);
});

for (const kind of ["regular file", "symlink", "directory", "FIFO", "widened mode", "hardlink"] as const) {
	test(`an owned-slot retry refuses a ${kind} change without altering the witness`, { skip: kind === "FIFO" && process.platform === "win32" }, (t) => {
		const { root, path, staging } = fixture();
		const witness = join(root, "witness");
		const displaced = staging + ".displaced";
		fs.writeFileSync(witness, "protected witness");
		restoreExportsAfterTest(t);
		t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" }); });
		syncBuiltinESMExports();
		assert.throws(() => saveState(path, state), { code: "EIO" });
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (kind === "widened mode") fs.chmodSync(staging, 0o644);
		else if (kind === "hardlink") fs.linkSync(staging, displaced);
		else {
			fs.renameSync(staging, displaced);
			if (kind === "regular file") fs.writeFileSync(staging, "foreign staging");
			if (kind === "symlink") fs.symlinkSync(witness, staging);
			if (kind === "directory") fs.mkdirSync(staging);
			if (kind === "FIFO") assert.equal(spawnSync("mkfifo", [staging]).status, 0);
		}
		const paths = [path, staging, witness, ...(kind === "widened mode" ? [] : [displaced])];
		const before = paths.map(snapshot);
		const entries = fs.readdirSync(root).sort();
		assert.throws(() => saveState(path, { sessions: {} }));
		assert.deepEqual(paths.map(snapshot), before);
		assert.deepEqual(fs.readdirSync(root).sort(), entries);
	});
}

test("a missing remembered slot fails closed without creating a replacement", (t) => {
	const { root, path, staging } = fixture();
	restoreExportsAfterTest(t);
	t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" }); });
	syncBuiltinESMExports();
	assert.throws(() => saveState(path, state), { code: "EIO" });
	t.mock.restoreAll();
	syncBuiltinESMExports();
	const displaced = staging + ".displaced";
	fs.renameSync(staging, displaced);
	const before = [snapshot(path), snapshot(displaced)];
	assert.throws(() => saveState(path, state), { code: "ENOENT" });
	assert.deepEqual([snapshot(path), snapshot(displaced)], before);
	assert.deepEqual(fs.readdirSync(root).sort(), ["state.json", "state.json.owned-stage.tmp.displaced"]);
});
