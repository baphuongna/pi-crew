import { appendEvent } from "../state/event-log/event-log.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";

export interface SupervisorContactPayload {
	runId: string;
	taskId: string;
	reason: "decision_needed" | "clarification" | "approval" | "error_escalation" | "custom";
	message: string;
	data?: Record<string, unknown>;
	timestamp: string;
}

/**
 * Record a supervisor contact event from a child task.
 * This represents a child→parent communication where the child needs
 * a decision, clarification, or approval to continue.
 */
export function recordSupervisorContact(manifest: TeamRunManifest, payload: Omit<SupervisorContactPayload, "timestamp">): void {
	const fullPayload: SupervisorContactPayload = {
		...payload,
		timestamp: new Date().toISOString(),
	};
	try {
		appendEvent(manifest.eventsPath, {
			type: "supervisor.contact",
			runId: manifest.runId,
			taskId: payload.taskId,
			data: fullPayload as unknown as Record<string, unknown>,
		});
	} catch (error) {
		logInternalError("supervisor-contact.record", error, `runId=${manifest.runId} taskId=${payload.taskId}`);
	}
}

/**
 * Parse a supervisor contact request from child Pi stdout.
 * Detects structured JSON lines with type "supervisor_contact".
 */
const SUPERVISOR_CONTACT_REASONS = ["decision_needed", "clarification", "approval", "error_escalation", "custom"] as const;

/**
 * Validate a parsed event object as a supervisor-contact payload. Shared by the
 * event-based (current) and line-based (deprecated) entry points. Returns the
 * normalized payload, or undefined if the event is not a supervisor contact.
 */
export function supervisorContactFromEvent(event: unknown): Omit<SupervisorContactPayload, "timestamp" | "runId"> | undefined {
	if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
	const record = event as Record<string, unknown>;
	if (record.type !== "supervisor_contact" && record.type !== "crew_supervisor_contact") return undefined;
	return {
		taskId: typeof record.taskId === "string" ? record.taskId : "",
		reason:
			typeof record.reason === "string" && (SUPERVISOR_CONTACT_REASONS as readonly string[]).includes(record.reason)
				? (record.reason as SupervisorContactPayload["reason"])
				: "custom",
		message: typeof record.message === "string" ? record.message : String(record.message ?? ""),
		data:
			record.data && typeof record.data === "object" && !Array.isArray(record.data)
				? (record.data as Record<string, unknown>)
				: undefined,
	};
}
