/**
 * Alert sink: invoke the daemonless local notification adapter.
 *
 * Never throws. The adapter owns durable attempt identity and never retries an
 * OS attempt; only a transient transport/receipt failure merits a replay.
 */

import { spawn } from "node:child_process";

import type { NotificationEvent } from "./types.ts";

export interface PostResult {
	ok: boolean;
	/** Process exit status, separate from the adapter's receipt state. */
	status?: number;
	state?: string;
	eventId?: string;
	error?: string;
}

const HANDLED_STATES: ReadonlySet<string> = new Set([
	"accepted_by_os",
	"delivered",
	"deduped",
	"held_for_digest",
	"suppressed_quiet_hours",
	"suppressed_hourly_cap",
]);
const TERMINAL_STATES: ReadonlySet<string> = new Set([
	"failed", "unknown", "abandoned_no_retry",
]);
export const DEFAULT_SINK_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;

export function isTerminalFailure(result: PostResult): boolean {
	return (result.status === 0 && result.eventId !== undefined &&
		TERMINAL_STATES.has(result.state ?? "")) ||
		/stable event id was reused with a changed payload/i.test(result.error ?? "");
}

function jsonObject(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

async function adapterRequest(
	adapterPath: string,
	receiptStore: string,
	eventId: string | undefined,
	payload: string | undefined,
	timeoutMs: number,
): Promise<PostResult> {
	try {
		return await new Promise<PostResult>((resolve) => {
			let settled = false;
			let timedOut = false;
			let stdout = "";
			let stderr = "";
			let stdoutOverflow = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const args = ["--store", receiptStore];
			if (payload === undefined) args.push("--status", eventId!);
			const child = spawn(adapterPath, args, { stdio: ["pipe", "pipe", "pipe"] });
			const timeoutResult: PostResult = {
				ok: false, error: "local notification adapter result unknown",
			};
			const finish = (result: PostResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearTimeout(killTimer);
				resolve(result);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					child.kill("SIGKILL");
					finish(timeoutResult);
				}, KILL_GRACE_MS);
			}, timeoutMs);
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdoutOverflow ||= stdout.length + chunk.length > 10000;
				stdout = (stdout + chunk).slice(0, 10000);
			});
			child.stderr.on("data", (chunk: string) => {
				stderr = (stderr + chunk).slice(0, 2000);
			});
			child.once("error", () =>
				finish({ ok: false, error: "local notification adapter unavailable" }),
			);
			// An adapter can exit before reading stdin. Consume EPIPE; close supplies
			// its exit/error receipt rather than crashing the daemon.
			child.stdin.on("error", () => {});
			child.once("close", (code) => {
				if (settled) return;
				if (timedOut) {
					finish(timeoutResult);
					return;
				}
				if (code !== 0) {
					const rejection = jsonObject(stderr);
					finish({
						ok: false,
						status: code ?? undefined,
						...(typeof rejection?.["state"] === "string" ? { state: rejection["state"] } : {}),
						error: typeof rejection?.["error"] === "string"
							? rejection["error"]
							: "local notification adapter failed",
					});
					return;
				}
				const receipt = stdoutOverflow ? null : jsonObject(stdout);
				if (!receipt) {
					finish({ ok: false, status: code, error: "invalid local adapter receipt" });
					return;
				}
				const state = typeof receipt["state"] === "string" ? receipt["state"] : undefined;
				const id = receipt["stable_event_id"];
				if (state !== undefined &&
					(HANDLED_STATES.has(state) || TERMINAL_STATES.has(state) ||
						(payload === undefined && state === "not_found")) &&
					typeof id === "string" && id.trim().length > 0 &&
					(eventId === undefined || id === eventId)) {
					const ok = HANDLED_STATES.has(state);
					finish({ ok, status: code, state, eventId: id,
						...(ok || (payload === undefined && state === "not_found") ? {} : {
							error: "local adapter receipt did not confirm a handled stable_event_id",
						}),
					});
					return;
				}
				finish({
					ok: false, status: code,
					...(state === undefined ? {} : { state }),
					error: "local adapter receipt did not confirm a handled stable_event_id",
				});
			});
			child.stdin.end(payload);
		});
	} catch {
		return { ok: false, error: "local notification adapter unavailable" };
	}
}

export async function postEvent(
	adapterPath: string,
	event: NotificationEvent | string,
	receiptStore: string,
	timeoutMs = DEFAULT_SINK_TIMEOUT_MS,
): Promise<PostResult> {
	try {
		// Serialize before spawning; retries supply the durable first payload.
		const payload = typeof event === "string" ? event : JSON.stringify(event);
		const id = jsonObject(payload)?.["event_id"];
		return await adapterRequest(adapterPath, receiptStore,
			typeof id === "string" ? id : undefined, payload, timeoutMs);
	} catch {
		return { ok: false, error: "local notification adapter unavailable" };
	}
}

/** Query only this ID; not_found must not be inferred from a failed lookup. */
export function eventStatus(
	adapterPath: string, eventId: string, receiptStore: string,
	timeoutMs = DEFAULT_SINK_TIMEOUT_MS,
): Promise<PostResult> {
	return adapterRequest(adapterPath, receiptStore, eventId, undefined, timeoutMs);
}
