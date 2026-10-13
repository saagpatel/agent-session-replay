import type { DiscoveryDiagnostic, TickReport } from "./types.ts";
import { failureDiagnostic, tickFailureProgress, type StatePublicationProgress } from "./progress.ts";

interface DestinationReadback {
	required: boolean | null;
	verified: boolean;
	destination_id: string | null;
	observed_at: string | null;
	evidence: Record<
		string,
		| string
		| number
		| boolean
		| null
		| string[]
		| StatePublicationProgress
		| {
				kind: string;
				value: string | number | boolean;
		  }
	>;
}

export interface AutomationInvocation {
	scheduled: boolean;
	source: "launchd" | "manual";
	service_name: string | null;
	parent_pid: number;
	signals: {
		xpc_service_name_matches: boolean;
		parent_is_launchd: boolean;
	};
}

const WATCHDOG_AUTOMATION_ID = "com.saagar.agent-watchdog" as const;

export function invocationProvenance(
	label: string = WATCHDOG_AUTOMATION_ID,
	environment: Record<string, string | undefined> = process.env,
	parentPid: number = process.ppid,
): AutomationInvocation {
	const rawServiceName = environment["XPC_SERVICE_NAME"] ?? "";
	const byLabel = rawServiceName === label;
	const byParent = parentPid === 1;
	const scheduled = byLabel;

	return {
		scheduled,
		source: scheduled ? "launchd" : "manual",
		service_name: rawServiceName || null,
		parent_pid: parentPid,
		signals: {
			xpc_service_name_matches: byLabel,
			parent_is_launchd: byParent,
		},
	};
}

export interface AutomationTerminalState {
	schema: "AutomationTerminalStateV2";
	automation_id: typeof WATCHDOG_AUTOMATION_ID;
	state: "succeeded" | "failed" | "partial" | "skipped";
	completed: boolean;
	partial: boolean;
	skipped: boolean;
	/** Handled adapter receipts, excluding state/staging writes or OS display. */
	mutation_count: number | null;
	mutation_count_certainty: "exact" | "lower_bound" | "unknown";
	destination_readback: DestinationReadback;
	operator_action_required: boolean;
	can_auto_archive: boolean;
	observed_at: string;
	invocation: AutomationInvocation;
	message: string;
	discovery_diagnostics: DiscoveryDiagnostic[];
	exit_code: number;
	duration_ms: number;
}

export function terminalStateForReport(
	report: TickReport,
	adapterPath: string,
	dryRun: boolean,
	observedAt: string,
	durationMs: number,
	invocation: AutomationInvocation = invocationProvenance(),
): AutomationTerminalState {
	const coverageFailure =
		report.parseFailures > 0 || report.skippedOversize > 0;
	const readbackFailure =
		report.alertsPosted !== report.acceptedEventIds.length;
	const notificationFailures = report.postFailures + report.terminalFailures;
	const unresolvedRequests = report.progress?.unresolved_adapter_requests ?? notificationFailures;
	const discoveryFailure = report.discoveryDiagnostics.length > 0;
	const partial =
		discoveryFailure || (!dryRun && (coverageFailure || notificationFailures > 0 || unresolvedRequests > 0 || readbackFailure || report.retentionCapReached));
	const deliveryRequired =
		!dryRun && (report.alertsPosted > 0 || notificationFailures > 0 || unresolvedRequests > 0);
	const adapterHandled =
		deliveryRequired && unresolvedRequests > 0 ? null
			: deliveryRequired && notificationFailures === 0 && !readbackFailure;
	// A handled receipt may mean accepted, deduped, held, or suppressed.
	// None of those proves Notification Center display or a human read.
	const deliveryVerified = false;
	const writeResult = !deliveryRequired
		? "not_applicable"
		: unresolvedRequests > 0
			? "unknown"
		: notificationFailures > 0
			? report.alertsPosted > 0
				? "partial"
				: "failed"
			: "succeeded";
	const readbackResult = !deliveryRequired
		? "not_required"
		: unresolvedRequests > 0 ? "unknown"
		: adapterHandled
			? "handled_by_adapter_no_display_proof"
			: "failed";
	const state = dryRun ? "skipped" : partial ? "partial" : "succeeded";

	return {
		schema: "AutomationTerminalStateV2",
		automation_id: "com.saagar.agent-watchdog",
		state,
		completed: true,
		partial,
		skipped: dryRun,
		mutation_count: dryRun ? 0 : report.acceptedEventIds.length,
		mutation_count_certainty: !dryRun && unresolvedRequests > 0 ? "lower_bound" : "exact",
		destination_readback: {
			required: deliveryRequired,
			verified: deliveryVerified,
			destination_id: deliveryRequired ? adapterPath : null,
			observed_at: deliveryRequired ? observedAt : null,
			evidence: {
				dry_run: dryRun,
				accepted_receipt_count: dryRun ? 0 : report.acceptedEventIds.length,
				accepted_event_ids: dryRun ? [] : [...report.acceptedEventIds],
				write_result: writeResult,
				readback_result: readbackResult,
				adapter_handled: adapterHandled,
				displayed: null,
				read: null,
				observed_result: {
					kind: "count",
					value: dryRun ? 0 : report.acceptedEventIds.length,
				},
				post_failures: report.postFailures,
				terminal_failures: report.terminalFailures,
				unresolved_adapter_requests: dryRun ? 0 : unresolvedRequests,
				state_publication: report.progress ? { ...report.progress.state_publication } : null,
				retained_payloads: report.retainedPayloads,
				retained_payload_bytes: report.retainedPayloadBytes,
				retention_cap_reached: report.retentionCapReached,
				parse_failures: report.parseFailures,
				windowed_sessions: report.windowedSessions,
				skipped_oversize: report.skippedOversize,
			},
		},
		operator_action_required: partial || report.retentionCapReached,
		can_auto_archive: false,
		observed_at: observedAt,
		invocation,
		message: report.retentionCapReached
			? "watchdog retention cap reached; operator action required"
			: discoveryFailure
				? `watchdog discovery incomplete; ${report.discoveryDiagnostics.length} filesystem diagnostic(s) require operator review`
				: partial
					? "watchdog tick completed with delivery or coverage failures"
				: dryRun
					? "watchdog dry run completed without adapter invocation or state writes"
					: "watchdog tick completed",
		exit_code: partial ? 1 : 0,
		discovery_diagnostics: report.discoveryDiagnostics.map((item) => ({ ...item })),
		duration_ms: durationMs,
	};
}

export function terminalStateForFailure(
	error: unknown,
	adapterPath: string,
	observedAt: string,
	durationMs: number,
	invocation: AutomationInvocation = invocationProvenance(),
): AutomationTerminalState {
	const diagnostic = failureDiagnostic(error);
	const progress = tickFailureProgress(error);
	const acceptedIds = progress ? [...progress.accepted_event_ids] : null;
	const acceptedCount = acceptedIds?.length ?? null;
	const unresolved = progress?.unresolved_adapter_requests ?? null;
	const knownZero = progress?.adapter_requests === 0;
	const handled = acceptedCount !== null && acceptedCount > 0;
	const writeResult = !progress || (unresolved !== null && unresolved > 0) ? "unknown"
		: progress.failed_adapter_requests > 0 ? handled ? "partial" : "failed"
			: handled ? "succeeded" : "not_performed";
	return {
		schema: "AutomationTerminalStateV2",
		automation_id: "com.saagar.agent-watchdog",
		state: "failed",
		completed: false,
		partial: false,
		skipped: false,
		mutation_count: acceptedCount,
		mutation_count_certainty: !progress ? "unknown"
			: unresolved !== null && unresolved > 0 ? "lower_bound" : "exact",
		destination_readback: {
			required: progress ? !knownZero : null,
			verified: false,
			destination_id: progress && !knownZero ? adapterPath : null,
			observed_at: progress && !knownZero ? observedAt : null,
			evidence: {
				adapter_path: adapterPath,
				tick_crashed: true,
				write_result: writeResult,
				readback_result: !progress || (unresolved !== null && unresolved > 0) ? "unknown"
					: progress.failed_adapter_requests > 0 ? "failed"
						: handled ? "handled_by_adapter_no_display_proof"
							: knownZero ? "not_required" : "no_handled_receipt",
				accepted_receipt_count: acceptedCount,
				accepted_event_ids: acceptedIds,
				adapter_handled: !progress || (unresolved !== null && unresolved > 0) ? null
					: handled && progress.failed_adapter_requests === 0,
				displayed: null,
				read: null,
				adapter_requests: progress?.adapter_requests ?? null,
				send_requests: progress?.send_requests ?? null,
				status_requests: progress?.status_requests ?? null,
				unresolved_adapter_requests: unresolved ?? null,
				failed_adapter_requests: progress?.failed_adapter_requests ?? null,
				state_publication: progress?.state_publication ?? null,
				observed_result: {
					kind: "failure",
					value: diagnostic,
				},
			},
		},
		operator_action_required: true,
		can_auto_archive: false,
		observed_at: observedAt,
		invocation,
		message: `watchdog tick crashed: ${diagnostic}`,
		exit_code: 1,
		discovery_diagnostics: [],
		duration_ms: durationMs,
	};
}

export function terminalLine(event: AutomationTerminalState): string {
	return `automation_completion: ${JSON.stringify(event)}`;
}
