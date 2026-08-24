import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { postEvent } from "./sink.ts";
import type { HubEvent } from "./types.ts";

const event: HubEvent = {
	source: "codex",
	level: "normal",
	title: "fixture",
	body: "fixture",
	context: {},
};

async function withServer(
	handler: Parameters<typeof createServer>[0],
	run: (url: string) => Promise<void>,
): Promise<void> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no address");
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => error ? reject(error) : resolve()),
		);
	}
}

function tokenFixture(mode = 0o600): { path: string; token: string } {
	const root = mkdtempSync(join(tmpdir(), "watchdog-token-"));
	const path = join(root, "agent-watchdog.token");
	const token = "fixture-secret-token";
	writeFileSync(path, `${token}\n`, { mode });
	chmodSync(path, mode);
	return { path, token };
}

test("authenticated post binds the exact producer and accepted receipt", async () => {
	const fixture = tokenFixture();
	await withServer((req, res) => {
		assert.equal(req.headers.authorization, `Bearer ${fixture.token}`);
		assert.equal(
			req.headers["x-notification-hub-producer"],
			"agent-watchdog",
		);
		res.statusCode = 201;
		res.end(JSON.stringify({ accepted: true, event_id: "evt-1" }));
	}, async (url) => {
		const result = await postEvent(url, event, {
			producerId: "agent-watchdog",
			tokenFile: fixture.path,
		});
		assert.deepEqual(result, { ok: true, status: 201, eventId: "evt-1" });
	});
});

test("missing credential fails closed without exposing a path or token", async () => {
	const result = await postEvent("http://127.0.0.1:1", event, {
		producerId: "agent-watchdog",
		tokenFile: "/definitely/missing/fixture-secret-token",
	});
	assert.equal(result.ok, false);
	assert.equal(
		result.error,
		"notification-hub request or producer credential failed",
	);
	assert.doesNotMatch(JSON.stringify(result), /fixture-secret-token/);
});

test("cleartext non-loopback hub URLs fail before any request", async () => {
	const fixture = tokenFixture();
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (async () => {
		requests += 1;
		throw new Error("unexpected cleartext request");
	}) as typeof fetch;
	try {
		const result = await postEvent("http://example.com", event, {
			producerId: "agent-watchdog",
			tokenFile: fixture.path,
		});
		assert.equal(result.ok, false);
		assert.equal(
			result.error,
			"notification-hub request or producer credential failed",
		);
		assert.equal(requests, 0);
		assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.token));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("authenticated posts do not follow redirects", async () => {
	const fixture = tokenFixture();
	let requests = 0;
	await withServer((_req, res) => {
		requests += 1;
		res.statusCode = 307;
		res.setHeader("location", "http://example.com/events");
		res.end("redirect");
	}, async (url) => {
		const result = await postEvent(url, event, {
			producerId: "agent-watchdog",
			tokenFile: fixture.path,
		});
		assert.equal(result.ok, false);
		assert.equal(
			result.error,
			"notification-hub request or producer credential failed",
		);
		assert.equal(requests, 1);
		assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.token));
	});
});

test("broad or symlinked token files fail before a request", async () => {
	const broad = tokenFixture(0o644);
	const root = mkdtempSync(join(tmpdir(), "watchdog-token-link-"));
	const link = join(root, "token-link");
	symlinkSync(broad.path, link);
	let requests = 0;
	await withServer((_req, res) => {
		requests += 1;
		res.statusCode = 201;
		res.end(JSON.stringify({ accepted: true, event_id: "unexpected" }));
	}, async (url) => {
		for (const tokenFile of [broad.path, link]) {
			const result = await postEvent(url, event, {
				producerId: "agent-watchdog",
				tokenFile,
			});
			assert.equal(result.ok, false);
			assert.equal(
				result.error,
				"notification-hub request or producer credential failed",
			);
		}
	});
	assert.equal(requests, 0);
});

test("an authentication rejection cannot become a successful receipt", async () => {
	const fixture = tokenFixture();
	await withServer((_req, res) => {
		res.statusCode = 401;
		res.end("producer authentication failed");
	}, async (url) => {
		const result = await postEvent(url, event, {
			producerId: "agent-watchdog",
			tokenFile: fixture.path,
		});
		assert.equal(result.ok, false);
		assert.equal(result.status, 401);
		assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.token));
	});
});
