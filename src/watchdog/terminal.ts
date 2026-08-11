import type { TickReport } from "./types.ts";

interface DestinationReadback {
	required: boolean;
	verified: boolean;
	destination_id: string | null;
	observed_at: string | null;
	evidence: Record<
		string,
		| string
		| number
		| boolean
		| string[]
		| {
				kind: string;
				value: string | number | boolean;
		  }
	>;
}

export interface AutomationTerminalState {
	schema: "AutomationTerminalStateV1";
	automation_id: "com.saagar.agent-watchdog";
	state: "succeeded" | "failed" | "partial" | "skipped";
	completed: boolean;
	partial: boolean;
	skipped: boolean;
	mutation_count: number;
	destination_readback: DestinationReadback;
	operator_action_required: boolean;
	can_auto_archive: boolean;
	observed_at: string;
	message: string;
	exit_code: number;
	duration_ms: number;
}

export function terminalStateForReport(
	report: TickReport,
	hubUrl: string,
	dryRun: boolean,
	observedAt: string,
	durationMs: number,
): AutomationTerminalState {
	const coverageFailure =
		report.parseFailures > 0 || report.skippedOversize > 0;
	const readbackFailure =
		report.alertsPosted !== report.acceptedEventIds.length;
	const partial =
		!dryRun && (coverageFailure || report.postFailures > 0 || readbackFailure);
	const deliveryRequired =
		!dryRun && (report.alertsPosted > 0 || report.postFailures > 0);
	const deliveryVerified =
		deliveryRequired && report.postFailures === 0 && !readbackFailure;
	const writeResult = !deliveryRequired
		? "not_applicable"
		: report.postFailures > 0
			? report.alertsPosted > 0
				? "partial"
				: "failed"
			: "succeeded";
	const readbackResult = !deliveryRequired
		? "not_required"
		: deliveryVerified
			? "verified"
			: "failed";
	const state = dryRun ? "skipped" : partial ? "partial" : "succeeded";

	return {
		schema: "AutomationTerminalStateV1",
		automation_id: "com.saagar.agent-watchdog",
		state,
		completed: true,
		partial,
		skipped: dryRun,
		mutation_count: dryRun ? 0 : report.alertsPosted,
		destination_readback: {
			required: deliveryRequired,
			verified: deliveryVerified,
			destination_id: deliveryRequired ? hubUrl : null,
			observed_at: deliveryRequired ? observedAt : null,
			evidence: {
				dry_run: dryRun,
				accepted_receipt_count: dryRun ? 0 : report.alertsPosted,
				accepted_event_ids: dryRun ? [] : report.acceptedEventIds,
				write_result: writeResult,
				readback_result: readbackResult,
				observed_result: {
					kind: "count",
					value: dryRun ? 0 : report.acceptedEventIds.length,
				},
				post_failures: report.postFailures,
				parse_failures: report.parseFailures,
				skipped_oversize: report.skippedOversize,
			},
		},
		operator_action_required: partial,
		can_auto_archive: false,
		observed_at: observedAt,
		message: partial
			? "watchdog tick completed with delivery or coverage failures"
			: dryRun
				? "watchdog dry run completed without network or state mutation"
				: "watchdog tick completed",
		exit_code: partial ? 1 : 0,
		duration_ms: durationMs,
	};
}

export function terminalStateForFailure(
	error: unknown,
	hubUrl: string,
	observedAt: string,
	durationMs: number,
): AutomationTerminalState {
	return {
		schema: "AutomationTerminalStateV1",
		automation_id: "com.saagar.agent-watchdog",
		state: "failed",
		completed: false,
		partial: false,
		skipped: false,
		mutation_count: 0,
		destination_readback: {
			required: false,
			verified: false,
			destination_id: null,
			observed_at: null,
			evidence: {
				hub_url: hubUrl,
				tick_crashed: true,
				write_result: "not_performed",
				readback_result: "not_required",
				observed_result: {
					kind: "failure",
					value: String(error),
				},
			},
		},
		operator_action_required: true,
		can_auto_archive: false,
		observed_at: observedAt,
		message: `watchdog tick crashed: ${String(error)}`,
		exit_code: 1,
		duration_ms: durationMs,
	};
}

export function terminalLine(event: AutomationTerminalState): string {
	return `automation_completion: ${JSON.stringify(event)}`;
}
