import type { TeamEvent } from "../state/event-log.ts";

export type RunEventType =
	| "task_started"
	| "task_completed"
	| "task_failed"
	| "task_cancelled"
	| "worker_status"
	| "mailbox_updated"
	| "effectiveness_changed"
	| "run_started"
	| "run_completed"
	| "run_blocked"
	| "run_cancelled";

export interface RunEventPayload {
	type: RunEventType;
	runId: string;
	taskId?: string;
	timestamp?: string;
	data?: unknown;
}

export type RunEventCallback = (event: RunEventPayload) => void;

class RunEventBus {
	#listeners = new Map<string, Set<RunEventCallback>>();
	#globalListeners = new Set<RunEventCallback>();

	on(runId: string, callback: RunEventCallback): () => void {
		const listeners = this.#listeners.get(runId) ?? new Set();
		listeners.add(callback);
		this.#listeners.set(runId, listeners);
		return () => { listeners.delete(callback); if (listeners.size === 0) this.#listeners.delete(runId); };
	}

	onAny(callback: RunEventCallback): () => void {
		this.#globalListeners.add(callback);
		return () => { this.#globalListeners.delete(callback); };
	}

	off(runId: string, callback: RunEventCallback): void {
		const listeners = this.#listeners.get(runId);
		if (listeners) {
			listeners.delete(callback);
			if (listeners.size === 0) this.#listeners.delete(runId);
		}
	}

	emit(event: RunEventPayload): void {
		const listeners = this.#listeners.get(event.runId);
		if (listeners) {
			for (const cb of listeners) {
				try { cb(event); } catch { /* subscriber errors are non-fatal */ }
			}
		}
		for (const cb of this.#globalListeners) {
			try { cb(event); } catch { /* subscriber errors are non-fatal */ }
		}
	}

	listenerCount(runId?: string): number {
		if (runId) return this.#listeners.get(runId)?.size ?? 0;
		let total = this.#globalListeners.size;
		for (const set of this.#listeners.values()) total += set.size;
		return total;
	}
}

/** Global singleton run event bus for UI-first event delivery. */
export const runEventBus = new RunEventBus();

/** Derive a RunEventType from a TeamEvent. */
export function teamEventToRunEventType(event: TeamEvent): RunEventType | undefined {
	const type = event.type;
	if (type === "task.started") return "task_started";
	if (type === "task.completed") return "task_completed";
	if (type === "task.failed") return "task_failed";
	if (type === "run.completed") return "run_completed";
	if (type === "run.blocked") return "run_blocked";
	if (type === "run.running") return "run_started";
	if (type === "run.cancelled") return "run_cancelled";
	if (type === "task.progress" || type === "mailbox.message_queued" || type === "mailbox.message_delivered") return "mailbox_updated";
	if (type === "run.effectiveness" || type === "task.attention") return "effectiveness_changed";
	return undefined;
}

/** Emit a run event from a TeamEvent. */
export function emitFromTeamEvent(event: TeamEvent): void {
	const type = teamEventToRunEventType(event);
	if (!type) return;
	runEventBus.emit({
		type,
		runId: event.runId,
		taskId: event.taskId,
		timestamp: event.time,
		data: event.data,
	});
}