/**
 * Alert sink: POST one event to notification-hub.
 *
 * Never throws — a hub outage must not take the watchdog down, and an
 * unposted finding is not marked alerted, so it retries on the next tick
 * for free.
 */

import { lstatSync, readFileSync } from "node:fs";

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
	const metadata = lstatSync(tokenFile);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("producer token file must be a regular non-symlink file");
	}
	if ((metadata.mode & 0o077) !== 0) {
		throw new Error("producer token file must be owner-private");
	}
	const token = readFileSync(tokenFile, "utf8").trim();
	if (token.length === 0 || token.length > 512 || /\s/.test(token)) {
		throw new Error("producer token file is invalid");
	}
	return token;
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
		const token = loadBearerToken(credential.tokenFile);
		const res = await fetch(new URL("/events", hubUrl), {
			method: "POST",
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
