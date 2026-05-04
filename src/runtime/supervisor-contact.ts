import type { TeamRunManifest } from "../state/types.ts";
import { appendEvent } from "../state/event-log.ts";
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
export function parseSupervisorContactFromLine(line: string): Omit<SupervisorContactPayload, "timestamp" | "runId"> | undefined {
	if (!line.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.type !== "supervisor_contact" && record.type !== "crew_supervisor_contact") return undefined;
	return {
		taskId: typeof record.taskId === "string" ? record.taskId : "",
		reason: typeof record.reason === "string" && ["decision_needed", "clarification", "approval", "error_escalation", "custom"].includes(record.reason)
			? record.reason as SupervisorContactPayload["reason"]
			: "custom",
		message: typeof record.message === "string" ? record.message : String(record.message ?? ""),
		data: record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined,
	};
}
