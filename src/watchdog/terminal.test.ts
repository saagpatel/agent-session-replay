import assert from "node:assert/strict";
import { test } from "node:test";

import {
	invocationProvenance,
	terminalStateForFailure,
	terminalStateForReport,
} from "./terminal.ts";
import type { TickReport } from "./types.ts";

const clean: TickReport = {
	scannedSessions: 2,
	windowedSessions: 0,
	skippedOversize: 0,
	skippedUnchanged: 3,
	parseFailures: 0,
	findings: 1,
	alertsPosted: 0,
	alertsDeduped: 1,
	alertsHeld: 0,
	postFailures: 0,
	acceptedEventIds: [],
};

test("clean tick emits exact succeeded terminal contract without destination mutation", () => {
	const event = terminalStateForReport(
		clean,
		"http://127.0.0.1:9199",
		false,
		"2026-07-14T10:00:00.000Z",
		25,
	);
	assert.deepEqual(Object.keys(event).sort(), [
		"automation_id",
		"can_auto_archive",
		"completed",
		"destination_readback",
		"duration_ms",
		"exit_code",
		"invocation",
		"message",
		"mutation_count",
		"observed_at",
		"operator_action_required",
		"partial",
		"schema",
		"skipped",
		"state",
	]);
	assert.equal(event.state, "succeeded");
	assert.equal(event.mutation_count, 0);
	assert.equal(event.destination_readback.required, false);
	assert.equal(event.destination_readback.verified, false);
	assert.equal(event.destination_readback.evidence.windowed_sessions, 0);
});

test("windowed coverage remains successful and explicit", () => {
	const event = terminalStateForReport(
		{ ...clean, windowedSessions: 1 },
		"http://127.0.0.1:9199",
		false,
		"2026-07-14T10:00:00.000Z",
		25,
	);
	assert.equal(event.state, "succeeded");
	assert.equal(event.operator_action_required, false);
	assert.equal(event.destination_readback.evidence.windowed_sessions, 1);
	assert.equal(event.destination_readback.evidence.skipped_oversize, 0);
});

test("post or coverage failures emit operator-actionable partial state", () => {
	const event = terminalStateForReport(
		{ ...clean, postFailures: 1, skippedOversize: 1 },
		"http://127.0.0.1:9199",
		false,
		"2026-07-14T10:00:00.000Z",
		40,
	);
	assert.equal(event.state, "partial");
	assert.equal(event.completed, true);
	assert.equal(event.partial, true);
	assert.equal(event.operator_action_required, true);
	assert.equal(event.can_auto_archive, false);
	assert.equal(event.destination_readback.required, true);
	assert.equal(event.destination_readback.verified, false);
});

test("launchd invocation records exact service and measured scheduler signals", () => {
	const invocation = invocationProvenance(
		"com.saagar.agent-watchdog",
		{ XPC_SERVICE_NAME: "com.saagar.agent-watchdog" },
		1,
	);
	assert.deepEqual(invocation, {
		scheduled: true,
		source: "launchd",
		service_name: "com.saagar.agent-watchdog",
		parent_pid: 1,
		signals: {
			xpc_service_name_matches: true,
			parent_is_launchd: true,
		},
	});
});

test("parent-only launchd detection never fabricates an XPC match", () => {
	const invocation = invocationProvenance(
		"com.saagar.agent-watchdog",
		{},
		1,
	);
	assert.equal(invocation.scheduled, true);
	assert.equal(invocation.service_name, "com.saagar.agent-watchdog");
	assert.equal(invocation.signals.xpc_service_name_matches, false);
	assert.equal(invocation.signals.parent_is_launchd, true);
});

test("terminal receipts retain caller-supplied invocation provenance", () => {
	const invocation = invocationProvenance(
		"com.saagar.agent-watchdog",
		{ XPC_SERVICE_NAME: "com.saagar.agent-watchdog" },
		1,
	);
	const event = terminalStateForReport(
		clean,
		"http://127.0.0.1:9199",
		false,
		"2026-07-14T10:00:00.000Z",
		25,
		invocation,
	);
	assert.equal(event.invocation, invocation);
});

test("accepted destination receipts preserve every notification-hub event id", () => {
	const event = terminalStateForReport(
		{ ...clean, alertsPosted: 2, acceptedEventIds: ["event-1", "event-2"] },
		"http://127.0.0.1:9199",
		false,
		"2026-07-14T10:00:00.000Z",
		30,
	);
	assert.equal(event.state, "succeeded");
	assert.equal(event.destination_readback.required, true);
	assert.equal(event.destination_readback.verified, true);
	assert.deepEqual(event.destination_readback.evidence.accepted_event_ids, [
		"event-1",
		"event-2",
	]);
});

test("dry run is machine-readable skipped state with zero mutations", () => {
	const event = terminalStateForReport(
		clean,
		"http://127.0.0.1:9199",
		true,
		"2026-07-14T10:00:00.000Z",
		10,
	);
	assert.equal(event.state, "skipped");
	assert.equal(event.skipped, true);
	assert.equal(event.mutation_count, 0);
});

test("crashed tick emits failed completion state", () => {
	const event = terminalStateForFailure(
		new Error("ENOSPC"),
		"http://127.0.0.1:9199",
		"2026-07-14T10:00:00.000Z",
		12,
	);
	assert.equal(event.state, "failed");
	assert.equal(event.completed, false);
	assert.equal(event.exit_code, 1);
	assert.match(event.message, /ENOSPC/);
});
