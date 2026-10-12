import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { DEFAULT_SINK_TIMEOUT_MS, eventStatus, isTerminalFailure, postEvent } from "./sink.ts";
import type { NotificationEvent } from "./types.ts";

const event: NotificationEvent = {
	event_id: "agent-watchdog:fixture-event",
	source: "codex",
	level: "normal",
	title: "fixture",
	body: "fixture",
	context: { detector: "grind_loop" },
	intent: "needs_attention",
};

function fixture(t: TestContext, response: string): { adapter: string; store: string } {
	const root = mkdtempSync(join(tmpdir(), "watchdog-adapter-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const adapter = join(root, "adapter.cjs");
	const store = join(root, "receipts.sqlite3");
	writeFileSync(adapter, `#!/usr/bin/env node
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ["--store", ${JSON.stringify(store)}]);
let text = "";
process.stdin.on("data", chunk => text += chunk).on("end", () => {
  const payload = JSON.parse(text);
  assert.deepEqual(payload, ${JSON.stringify(event)});
  ${response}
});
`, { mode: 0o700 });
	chmodSync(adapter, 0o700);
	return { adapter, store };
}

// Enumerate the protocol independently from the implementation.
for (const state of [
	"accepted_by_os", "delivered", "deduped", "held_for_digest",
	"suppressed_quiet_hours", "suppressed_hourly_cap",
]) {
	test(`local adapter handled state ${state} returns the stable event ID`, async (t) => {
		const { adapter, store } = fixture(t,
			`console.log(JSON.stringify({state: ${JSON.stringify(state)}, stable_event_id: payload.event_id}));`);
		assert.deepEqual(await postEvent(adapter, event, store),
			{ ok: true, status: 0, state, eventId: event.event_id });
	});
}

test("exit 2 rejection surfaces stderr JSON error even with accepted-looking stdout", async (t) => {
	const { adapter, store } = fixture(t, `
		console.log(JSON.stringify({state: "accepted_by_os", stable_event_id: payload.event_id}));
		console.error(JSON.stringify({state: "rejected", error: "detector is not approved"}));
		process.exitCode = 2;
	`);
	assert.deepEqual(await postEvent(adapter, event, store), {
		ok: false, status: 2, state: "rejected", error: "detector is not approved",
	});
});

test("missing local adapter fails without throwing", async () => {
	assert.deepEqual(await postEvent("/definitely/missing/local-notifier", event, "/unused/receipts.sqlite3"),
		{ ok: false, error: "local notification adapter unavailable" });
});

for (const output of ["not-json", "null", "[]", "{}\n{}"]) {
	test(`malformed adapter stdout ${JSON.stringify(output)} fails closed`, async (t) => {
		const { adapter, store } = fixture(t, `console.log(${JSON.stringify(output)});`);
		assert.deepEqual(await postEvent(adapter, event, store),
			{ ok: false, status: 0, error: "invalid local adapter receipt" });
	});
}

for (const receipt of [
	{ state: "rejected", stable_event_id: event.event_id },
	{ state: "failed" },
	{ state: "unknown", stable_event_id: "another-id" },
	{ state: "accepted_by_os" },
	{ state: "delivered", stable_event_id: "" },
	{ state: "deduped", stable_event_id: 123 },
	{ state: "held_for_digest", stable_event_id: " " },
]) {
	test(`unconfirmed receipt ${JSON.stringify(receipt)} fails closed`, async (t) => {
		const { adapter, store } = fixture(t,
			`console.log(JSON.stringify(${JSON.stringify(receipt)}));`);
		const result = await postEvent(adapter, event, store);
		assert.equal(result.ok, false);
		assert.equal(result.status, 0);
		assert.equal(result.eventId, undefined);
	});
}

test("stdout beyond the receipt bound cannot masquerade as a valid receipt", async (t) => {
	const { adapter, store } = fixture(t, `
		console.log(JSON.stringify({state: "accepted_by_os", stable_event_id: payload.event_id}));
		process.stdout.write(" ".repeat(20000));
	`);
	assert.equal((await postEvent(adapter, event, store)).error, "invalid local adapter receipt");
});

test("unstructured or oversized rejection stderr falls back to a bounded failure", async (t) => {
	const { adapter, store } = fixture(t, `
		process.stderr.write("x".repeat(10000));
		process.exitCode = 2;
	`);
	assert.deepEqual(await postEvent(adapter, event, store),
		{ ok: false, status: 2, error: "local notification adapter failed" });
});

test("adapter timeout preserves an unknown attempt result", async (t) => {
	const { adapter, store } = fixture(t, "setInterval(() => {}, 1000);");
	assert.deepEqual(await postEvent(adapter, event, store, 300),
		{ ok: false, error: "local notification adapter result unknown" });
});

test("an adapter that exits before reading a large payload cannot crash the sink", async (t) => {
	const { adapter, store } = fixture(t, "");
	writeFileSync(adapter, "#!/usr/bin/env node\nprocess.exit(2);\n");
	const result = await postEvent(adapter, { ...event, body: "x".repeat(1000000) }, store);
	assert.equal(result.ok, false);
	assert.equal(result.status, 2);
});

for (const state of ["failed", "unknown", "abandoned_no_retry"]) {
	test(`terminal receipt ${state} exposes its state and is never retried`, async (t) => {
		const { adapter, store } = fixture(t,
			`console.log(JSON.stringify({state: ${JSON.stringify(state)}, stable_event_id: payload.event_id}));`);
		const result = await postEvent(adapter, event, store);
		assert.equal(result.ok, false);
		assert.equal(result.state, state);
		assert.equal(result.eventId, event.event_id);
		assert.equal(isTerminalFailure(result), true);
	});
}

test("changed-payload rejection is terminal but other non-zero exits are transient", async (t) => {
	const { adapter, store } = fixture(t, `
		console.error(JSON.stringify({state: "rejected", error: "stable event id was reused with a changed payload"}));
		process.exitCode = 2;
	`);
	const result = await postEvent(adapter, event, store);
	assert.equal(result.state, "rejected");
	assert.equal(isTerminalFailure(result), true);
	assert.equal(isTerminalFailure({ ok: false, status: 2, state: "failed" }), false);
	assert.equal(isTerminalFailure({ ok: false, state: "unknown" }), false);
	assert.equal(isTerminalFailure({ ok: false, status: 0, state: "failed" }), false);
});

test("status queries use the exact ID and accept the adapter's not_found response", async (t) => {
	const { adapter, store } = fixture(t, "");
	writeFileSync(adapter, `#!/usr/bin/env node
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ["--store", ${JSON.stringify(store)}, "--status", ${JSON.stringify(event.event_id)}]);
console.log(JSON.stringify({stable_event_id: process.argv[5], state: "not_found"}));
`);
	assert.deepEqual(await eventStatus(adapter, event.event_id!, store), {
		ok: false, status: 0, state: "not_found", eventId: event.event_id,
	});
});

test("status never interprets wrong-ID or failed lookups as safe eviction", async (t) => {
	const { adapter, store } = fixture(t, "");
	writeFileSync(adapter, `#!/usr/bin/env node
console.log(JSON.stringify({stable_event_id: "wrong-id", state: "not_found"}));
`);
	assert.equal((await eventStatus(adapter, event.event_id!, store)).eventId, undefined);
	writeFileSync(adapter, `#!/usr/bin/env node
console.log(JSON.stringify({stable_event_id: process.argv[5], state: "not_found"}));
process.exitCode = 2;
`);
	const result = await eventStatus(adapter, event.event_id!, store);
	assert.equal(result.status, 2);
	assert.equal(result.eventId, undefined);
});

test("default sink deadline is 30 seconds", async (t) => {
	const delays: number[] = [];
	const original = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
		delays.push(args[1]!);
		return original(...args);
	});
	const { adapter, store } = fixture(t,
		'console.log(JSON.stringify({state: "delivered", stable_event_id: payload.event_id}));');
	assert.equal((await postEvent(adapter, event, store)).ok, true);
	assert.deepEqual(delays, [30_000]);
	assert.equal(DEFAULT_SINK_TIMEOUT_MS, 30_000);
});

test("timeout kills a SIGTERM-resistant adapter after the two-second grace", async (t) => {
	const { adapter, store } = fixture(t, "");
	writeFileSync(adapter, `#!/usr/bin/env node
const fs = require("node:fs");
const store = process.argv[3];
fs.writeFileSync(store + ".pid", String(process.pid));
process.on("SIGTERM", () => fs.writeFileSync(store + ".term", String(Date.now())));
process.stdin.resume();
setInterval(() => {}, 1000);
`);
	const started = Date.now();
	assert.deepEqual(await postEvent(adapter, event, store, 500),
		{ ok: false, error: "local notification adapter result unknown" });
	assert.ok(existsSync(store + ".term"), "SIGTERM was observed");
	assert.ok(Date.now() - Number(readFileSync(store + ".term", "utf8")) >= 1900);
	assert.ok(Date.now() - started < 5000, "the resistant child cannot hold the tick open");
	const pid = Number(readFileSync(store + ".pid", "utf8"));
	// SIGKILL has been sent; allow the close/reap event to reach Node.
	for (let i = 0; i < 20; i++) {
		try { process.kill(pid, 0); } catch { return; }
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.fail("adapter survived SIGKILL");
});

test("a receipt emitted during timeout shutdown stays transient", async (t) => {
	const { adapter, store } = fixture(t, `
		process.on("SIGTERM", () => {
			console.log(JSON.stringify({state: "delivered", stable_event_id: payload.event_id}));
			process.exit(0);
		});
		setInterval(() => {}, 1000);
	`);
	const result = await postEvent(adapter, event, store, 500);
	assert.equal(result.ok, false);
	assert.equal(isTerminalFailure(result), false);
});
