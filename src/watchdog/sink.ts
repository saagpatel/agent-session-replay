/**
 * Alert sink: POST one event to notification-hub.
 *
 * Never throws — a hub outage must not take the watchdog down, and an
 * unposted finding is not marked alerted, so it retries on the next tick
 * for free.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

import type { HubEvent } from "./types.ts";

export interface PostResult {
	ok: boolean;
	status?: number;
	eventId?: string;
	error?: string;
}

interface HubReceipt {
	event_id?: unknown;
	accepted?: unknown;
}

export interface ProducerCredential {
	producerId: string;
	tokenFile: string;
}

function loadBearerToken(tokenFile: string): string {
	const descriptor = openSync(
		tokenFile,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const metadata = fstatSync(descriptor);
		if (!metadata.isFile()) {
			throw new Error("producer token file must be a regular file");
		}
		if ((metadata.mode & 0o077) !== 0) {
			throw new Error("producer token file must be owner-private");
		}
		const token = readFileSync(descriptor, "utf8").trim();
		if (token.length === 0 || token.length > 512 || /\s/.test(token)) {
			throw new Error("producer token file is invalid");
		}
		return token;
	} finally {
		closeSync(descriptor);
	}
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "[::1]";
}

function notificationHubEventsUrl(hubUrl: string): URL {
	const base = new URL(hubUrl);
	if (
		base.protocol === "https:" ||
		(base.protocol === "http:" && isLoopbackHostname(base.hostname))
	) {
		return new URL("/events", base);
	}
	throw new Error("notification-hub URL must use https or loopback http");
}

export async function postEvent(
	hubUrl: string,
	event: HubEvent,
	credential: ProducerCredential,
	timeoutMs = 5000,
): Promise<PostResult> {
	try {
		if (!/^[A-Za-z0-9._:-]{1,100}$/.test(credential.producerId)) {
			return { ok: false, error: "producer identity is invalid" };
		}
		const endpoint = notificationHubEventsUrl(hubUrl);
		const token = loadBearerToken(credential.tokenFile);
		// codeql[js/file-access-to-http]
		// HTTP endpoints are admitted only after notificationHubEventsUrl restricts them to loopback hosts.
		const res = await fetch(endpoint, {
			method: "POST",
			redirect: "error",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				"x-notification-hub-producer": credential.producerId,
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const detail = (await res.text()).slice(0, 300);
		if (!res.ok) return { ok: false, status: res.status, error: detail };

		let receipt: HubReceipt;
		try {
			receipt = JSON.parse(detail) as HubReceipt;
		} catch {
			return {
				ok: false,
				status: res.status,
				error: "invalid notification-hub JSON receipt",
			};
		}
		if (
			receipt.accepted !== true ||
			typeof receipt.event_id !== "string" ||
			receipt.event_id.length === 0
		) {
			return {
				ok: false,
				status: res.status,
				error: "notification-hub receipt did not confirm accepted event_id",
			};
		}
		return { ok: true, status: res.status, eventId: receipt.event_id };
	} catch {
		return {
			ok: false,
			error: "notification-hub request or producer credential failed",
		};
	}
}
