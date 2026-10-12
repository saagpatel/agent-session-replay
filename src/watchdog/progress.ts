import type { PostResult } from "./sink.ts";

export interface StatePublicationProgress {
	/** saveState calls that returned successfully, excluding staging writes. */
	readonly completed_writes: number;
	readonly attempted_writes: number;
	readonly last_attempt: "not_started" | "in_progress" | "succeeded" | "failed";
}

export interface TickFailureProgress {
	/** Adapter requests include sends and status lookups, not OS attempts. */
	readonly adapter_requests: number;
	readonly send_requests: number;
	readonly status_requests: number;
	readonly unresolved_adapter_requests: number;
	readonly failed_adapter_requests: number;
	readonly accepted_event_ids: readonly string[];
	readonly state_publication: StatePublicationProgress;
}

/** A distinct carrier per failed tick; the original error remains its cause. */
export class TickFailure extends Error {
	readonly progress: TickFailureProgress;
	readonly code?: string;

	constructor(cause: unknown, progress: TickFailureProgress) {
		let message = "watchdog tick failed (diagnostic unavailable)";
		try {
			const value = cause instanceof Error ? cause.message : String(cause);
			if (typeof value === "string") message = value;
		} catch { /* A throwing formatter must not erase captured progress. */ }
		super(message, { cause });
		try {
			if (cause instanceof Error && typeof cause.name === "string") this.name = cause.name;
		} catch { /* Preserve the default Error name when diagnosis is unavailable. */ }
		try {
			const code = (cause as { code?: unknown } | null)?.code;
			if (typeof code === "string") this.code = code;
		} catch { /* Diagnostic getters must not erase the original failure. */ }
		this.progress = Object.freeze({
			adapter_requests: progress.adapter_requests,
			send_requests: progress.send_requests,
			status_requests: progress.status_requests,
			unresolved_adapter_requests: progress.unresolved_adapter_requests,
			failed_adapter_requests: progress.failed_adapter_requests,
			accepted_event_ids: Object.freeze([...progress.accepted_event_ids]),
			state_publication: Object.freeze({ ...progress.state_publication }),
		});
		Object.defineProperty(this, "progress", {
			writable: false, configurable: false, enumerable: false,
		});
	}
}

export function tickFailureProgress(error: unknown): TickFailureProgress | undefined {
	try { return error instanceof TickFailure ? error.progress : undefined; }
	catch { return undefined; }
}

export function failureDiagnostic(error: unknown): string {
	try { return String(error); }
	catch { return "watchdog tick failed (diagnostic unavailable)"; }
}

/** Records only observations; no payloads, transcript paths or delivery claims. */
export class TickProgress {
	private adapterRequests = 0;
	private sendRequests = 0;
	private statusRequests = 0;
	private unresolvedRequests = 0;
	private failedRequests = 0;
	private acceptedIds: string[] = [];
	private publication: StatePublicationProgress = {
		completed_writes: 0, attempted_writes: 0, last_attempt: "not_started",
	};

	async request(run: () => Promise<PostResult>, kind: "send" | "status" = "send"): Promise<PostResult> {
		this.adapterRequests += 1;
		if (kind === "send") this.sendRequests += 1;
		else this.statusRequests += 1;
		this.unresolvedRequests += 1;
		const result = await run();
		// Record handled receipts BEFORE any caller logging or state processing.
		if (result.ok && result.eventId) {
			this.acceptedIds.push(result.eventId);
			this.unresolvedRequests -= 1;
		} else if (result.status === 0 && result.eventId && result.state === "failed") {
			this.failedRequests += 1;
			this.unresolvedRequests -= 1;
		} else if (result.status === 0 && result.eventId && result.state === "not_found") {
			this.unresolvedRequests -= 1;
		}
		// Missing/malformed/transport or terminal-unknown receipts cannot prove
		// a zero outcome. Retry disposition is separate from outcome knowledge.
		return result;
	}

	publish(run: () => void): void {
		this.publication = { ...this.publication,
			attempted_writes: this.publication.attempted_writes + 1,
			last_attempt: "in_progress" };
		try {
			run();
			this.publication = { ...this.publication,
				completed_writes: this.publication.completed_writes + 1,
				last_attempt: "succeeded" };
		} catch (error) {
			this.publication = { ...this.publication, last_attempt: "failed" };
			throw error;
		}
	}

	snapshot(): TickFailureProgress {
		return Object.freeze({
			adapter_requests: this.adapterRequests,
			send_requests: this.sendRequests,
			status_requests: this.statusRequests,
			unresolved_adapter_requests: this.unresolvedRequests,
			failed_adapter_requests: this.failedRequests,
			accepted_event_ids: Object.freeze([...this.acceptedIds]),
			state_publication: Object.freeze({ ...this.publication }),
		});
	}

	failure(cause: unknown): TickFailure {
		return new TickFailure(cause, this.snapshot());
	}
}
