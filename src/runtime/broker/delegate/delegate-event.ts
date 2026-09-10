/**
 * delegate-event.ts — Event recording for the broker delegate surface.
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * recordDelegateEvent uses ONLY the module-scoped event-log + error helpers;
 * no broker state. Promoted to a top-level function so the class method is
 * a 1-line delegation.
 */

import { appendEventAsync } from "../../../state/event-log/event-log.ts";
import { logInternalError } from "../../../utils/internal-error.ts";

/** Fire-and-forget async append; an append failure is logged, never thrown
 *  (broker handlers must not block the event loop on the sync event-log lock).
 *  See `crew-broker.delegate.event` event scope conventions in ADR-5 §10. */
export function recordDelegateEvent(
	manifest: { eventsPath: string; runId: string },
	type:
		| "delegate.requested"
		| "delegate.admitted"
		| "delegate.rejected"
		| "delegate.completed"
		| "delegate.timed_out"
		| "delegate.rolled_up",
	taskId: string,
	data: Record<string, unknown>,
): void {
	void appendEventAsync(manifest.eventsPath, {
		type,
		runId: manifest.runId,
		taskId,
		message: `${type}: ${JSON.stringify(data).slice(0, 200)}`,
		data,
	}).catch((err) =>
		logInternalError("crew-broker.delegate.event", err instanceof Error ? err : new Error(String(err)), `runId=${manifest.runId}`),
	);
}
