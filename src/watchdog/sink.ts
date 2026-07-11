/**
 * Alert sink: POST one event to notification-hub.
 *
 * Never throws — a hub outage must not take the watchdog down, and an
 * unposted finding is not marked alerted, so it retries on the next tick
 * for free.
 */

import type { HubEvent } from "./types.ts";

export interface PostResult {
	ok: boolean;
	status?: number;
	error?: string;
}

export async function postEvent(
	hubUrl: string,
	event: HubEvent,
	timeoutMs = 5000,
): Promise<PostResult> {
	try {
		const res = await fetch(new URL("/events", hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.ok) return { ok: true, status: res.status };
		const detail = (await res.text()).slice(0, 300);
		return { ok: false, status: res.status, error: detail };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}
