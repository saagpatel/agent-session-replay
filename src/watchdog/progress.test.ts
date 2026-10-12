import assert from "node:assert/strict";
import { test } from "node:test";
import { TickFailure, TickProgress, tickFailureProgress } from "./progress.ts";
import { terminalStateForFailure } from "./terminal.ts";
import type { PostResult } from "./sink.ts";

function terminal(error: unknown) {
	return terminalStateForFailure(error, "/fixture/adapter", "2026-01-01T00:00:00Z", 1);
}

test("generic errors have unknown outcomes, even when reused as a tick cause", async () => {
	const original = Object.freeze(Object.assign(new Error("synthetic failure"), { code: "EIO" }));
	const first = new TickProgress();
	await first.request(async () => ({ ok: true, status: 0, state: "accepted_by_os", eventId: "event-one" }));
	const a = first.failure(original);
	const b = new TickProgress().failure(original);
	assert.notEqual(a, b);
	assert.equal(a.cause, original);
	assert.equal(b.cause, original);
	assert.equal(a.message, original.message);
	assert.equal(a.code, "EIO");
	assert.deepEqual(a.progress.accepted_event_ids, ["event-one"]);
	assert.deepEqual(b.progress.accepted_event_ids, []);
	assert.equal(terminal(a).mutation_count, 1);
	assert.equal(terminal(b).mutation_count, 0);
	const generic = terminal(original);
	assert.equal(tickFailureProgress(original), undefined);
	assert.equal(generic.mutation_count, null);
	assert.equal(generic.mutation_count_certainty, "unknown");
	assert.equal(generic.destination_readback.required, null);
	assert.equal(generic.destination_readback.evidence.write_result, "unknown");
});

test("failure snapshots own immutable IDs and publication observations", async () => {
	const progress = new TickProgress();
	const ids = ["event-one"];
	const publication = { attempted_writes: 1, completed_writes: 1, last_attempt: "succeeded" as const };
	const failure = new TickFailure(new Error("synthetic"), {
		adapter_requests: 1, send_requests: 1, status_requests: 0, unresolved_adapter_requests: 0, failed_adapter_requests: 0,
		accepted_event_ids: ids, state_publication: publication,
	});
	ids.push("foreign"); publication.completed_writes = 2;
	assert.deepEqual(failure.progress.accepted_event_ids, ["event-one"]);
	assert.equal(failure.progress.state_publication.completed_writes, 1);
	assert.ok(Object.isFrozen(failure.progress));
	assert.ok(Object.isFrozen(failure.progress.accepted_event_ids));
	assert.ok(Object.isFrozen(failure.progress.state_publication));
	assert.throws(() => Object.assign(failure, { progress: {} }), TypeError);
	const earlier = progress.failure(new Error("earlier"));
	await progress.request(async () => ({ ok: true, eventId: "later", status: 0, state: "delivered" }));
	assert.deepEqual(earlier.progress.accepted_event_ids, []);
});

test("an in-flight or terminal-unknown request is a lower bound, never exact zero", async () => {
	const progress = new TickProgress();
	let resolve!: (result: PostResult) => void;
	const pending = progress.request(() => new Promise<PostResult>(done => { resolve = done; }));
	const inFlight = terminal(progress.failure(new Error("synthetic interruption")));
	assert.equal(inFlight.mutation_count, 0);
	assert.equal(inFlight.mutation_count_certainty, "lower_bound");
	assert.equal(inFlight.destination_readback.evidence.write_result, "unknown");
	assert.equal(inFlight.destination_readback.required, true);
	resolve({ ok: false, status: 0, state: "unknown", eventId: "opaque" });
	await pending;
	assert.equal(terminal(progress.failure(new Error("later"))).mutation_count_certainty, "lower_bound");
	await progress.request(async () => ({ ok: true, status: 0, state: "delivered", eventId: "handled" }));
	const partial = terminal(progress.failure(new Error("later")));
	assert.equal(partial.mutation_count, 1);
	assert.equal(partial.mutation_count_certainty, "lower_bound");
	assert.equal(partial.destination_readback.evidence.adapter_handled, null);
	assert.equal(partial.destination_readback.evidence.readback_result, "unknown");
	assert.deepEqual(partial.destination_readback.evidence.accepted_event_ids, ["handled"]);
});

test("status absence resolves a lookup without claiming a failed notification write", async () => {
	const progress = new TickProgress();
	await progress.request(async () => ({ ok: false, status: 0, state: "not_found", eventId: "absent" }), "status");
	const event = terminal(progress.failure(new Error("synthetic publication failure")));
	assert.equal(event.mutation_count_certainty, "exact");
	assert.equal(event.destination_readback.evidence.write_result, "not_performed");
	assert.equal(event.destination_readback.evidence.failed_adapter_requests, 0);
	assert.equal(event.destination_readback.evidence.send_requests, 0);
	assert.equal(event.destination_readback.evidence.status_requests, 1);
});

test("mixed handled and definite failed requests retain partial adapter outcome", async () => {
	const progress = new TickProgress();
	await progress.request(async () => ({ ok: true, status: 0, state: "delivered", eventId: "handled" }));
	await progress.request(async () => ({ ok: false, status: 0, state: "failed", eventId: "failed" }));
	const event = terminal(progress.failure(new Error("synthetic crash")));
	assert.equal(event.destination_readback.evidence.write_result, "partial");
	assert.equal(event.destination_readback.evidence.adapter_handled, false);
	assert.equal(event.destination_readback.evidence.readback_result, "failed");
	assert.equal(event.mutation_count, 1);
	assert.equal(event.mutation_count_certainty, "exact");
});

test("diagnostic getters, formatters and primitive causes do not lose progress", () => {
	const cause = new Error("synthetic failure");
	for (const property of ["message", "name", "code"])
		Object.defineProperty(cause, property, { get() { throw new Error("getter failure"); } });
	const failure = new TickProgress().failure(cause);
	assert.equal(failure.cause, cause);
	assert.equal(failure.progress.adapter_requests, 0);
	assert.match(terminal(failure).message, /diagnostic unavailable/);
	const opaque = { toString() { throw new Error("formatter failure"); } };
	assert.equal(new TickProgress().failure(opaque).cause, opaque);
	assert.equal(terminal(opaque).mutation_count, null);
	assert.equal(new TickProgress().failure("primitive failure").cause, "primitive failure");
});
