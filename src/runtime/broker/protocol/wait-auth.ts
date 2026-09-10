/**
 * wait-auth.ts — Auth + policy-rejection helpers for the broker wait.*
 * surface.
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * waitAuthError is pure (operates only on conn metadata). recordWaitPolicyRejection
 * uses module-scoped event-log + internal-error helpers — same as the class
 * method did. Both are now top-level functions; the class delegates to them.
 */

import { appendEventAsync } from "../../../state/event-log/event-log.ts";
import { logInternalError } from "../../../utils/internal-error.ts";
import type { ServerConnection } from "./connection-state.ts";

/** Auth failure for the wait.* methods: worker role + task-scoped (compound)
 *  token ONLY (ADR-0 2026-08-17 item 6). Legacy bare-runId fallback match is
 *  REJECTED with a migrate hint; orchestrator token is rejected by role. */
export function waitAuthError(conn: ServerConnection): { code: string; message: string } | null {
	if (conn.role !== "worker" || conn.authMatchKind === undefined) {
		return { code: "forbidden", message: "wait.* requires a worker task-scoped token" };
	}
	if (conn.authMatchKind !== "compound") {
		return {
			code: "forbidden",
			message: "wait.* requires a task-scoped token; re-dispatch with PI_CREW_BROKER_TASK_ID",
		};
	}
	return null;
}

/** ADR-0 item 7: a disabled-gate rejection MUST leave a durable trace in
 *  events.jsonl. The gate fails CLOSED but never SILENTLY. Fire-and-forget
 *  async append (broker handlers must not block the event loop on the sync
 *  event-log lock); an append failure is logged, never thrown. */
export function recordWaitPolicyRejection(manifest: { eventsPath: string; runId: string }, taskId: string, method: string): void {
	const runId = manifest.runId;
	void appendEventAsync(manifest.eventsPath, {
		type: "policy.action",
		runId,
		taskId,
		message: `${method} rejected: waitMethodsEnabled=false (fail-closed)`,
		data: { action: method, reason: "wait-methods-disabled", policy: "broker.waitMethodsEnabled=false" },
	}).catch((err) =>
		logInternalError("crew-broker.wait.policy-event", err instanceof Error ? err : new Error(String(err)), `runId=${runId}`),
	);
}
