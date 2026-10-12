/**
 * Alert sink: invoke the daemonless local notification adapter.
 *
 * Never throws. Failed attempts stay pending in watchdog state; the adapter
 * owns durable attempt identity and decides whether a replay is safe.
 */

import { spawn } from "node:child_process";

import type { NotificationEvent } from "./types.ts";

export interface PostResult {
	ok: boolean;
	status?: number;
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

export async function postEvent(
	adapterPath: string,
	event: NotificationEvent,
	receiptStore: string,
	timeoutMs = 15000,
): Promise<PostResult> {
	try {
		// Serialize before spawning so an invalid payload cannot strand a child.
		const payload = JSON.stringify(event);
		return await new Promise<PostResult>((resolve) => {
			let settled = false;
			let stdout = "";
			let stderr = "";
			let stdoutOverflow = false;
			const child = spawn(adapterPath, ["--store", receiptStore], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			const finish = (result: PostResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				finish({ ok: false, error: "local notification adapter result unknown" });
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
			// An adapter can exit before reading stdin. Consume EPIPE rather than
			// crashing the daemon; close still supplies its exit/error receipt.
			child.stdin.on("error", () => {});
			child.once("close", (code) => {
				if (settled) return;
				if (code !== 0) {
					const rejection = jsonObject(stderr);
					finish({
						ok: false,
						status: code ?? undefined,
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
				if (
					typeof receipt["state"] === "string" &&
					HANDLED_STATES.has(receipt["state"]) &&
					typeof receipt["stable_event_id"] === "string" &&
					receipt["stable_event_id"].trim().length > 0
				) {
					finish({ ok: true, status: code, eventId: receipt["stable_event_id"] });
					return;
				}
				finish({
					ok: false,
					status: code,
					error: "local adapter receipt did not confirm a handled stable_event_id",
				});
			});
			child.stdin.end(payload);
		});
	} catch {
		return { ok: false, error: "local notification adapter unavailable" };
	}
}
