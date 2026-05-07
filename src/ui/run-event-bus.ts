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

/** Typed channel names for category-based event subscription. */
export type EventChannel =
	| "worker:progress"
	| "worker:lifecycle"
	| "worker:stream"
	| "run:state"
	| "ui:invalidate";

/** Sets used by classifyEventChannel for O(1) lookup. */
const WORKER_PROGRESS_TYPES = new Set([
	"tool_execution_start", "tool_result", "agent_progress", "worker_status",
]);
const WORKER_LIFECYCLE_TYPES = new Set([
	"task.started", "task.completed", "task.failed",
	"task_started", "task_completed", "task_failed", "task_cancelled",
	"run.started", "run.completed", "run.cancelled", "run.failed",
	"run_started", "run_completed", "run_cancelled", "run_blocked",
]);
const WORKER_STREAM_TYPES = new Set([
	"stdout_chunk", "stderr_chunk", "stream",
]);
const RUN_STATE_TYPES = new Set([
	"manifest.saved", "task.claimed", "task.unclaimed", "mailbox_updated",
]);
const UI_INVALIDATE_TYPES = new Set([
	"effectiveness_changed", "snapshot_stale",
]);

/** Classify an event type string into a typed channel. */
export function classifyEventChannel(type: string): EventChannel {
	if (WORKER_PROGRESS_TYPES.has(type)) return "worker:progress";
	if (WORKER_LIFECYCLE_TYPES.has(type)) return "worker:lifecycle";
	if (WORKER_STREAM_TYPES.has(type)) return "worker:stream";
	if (RUN_STATE_TYPES.has(type)) return "run:state";
	if (UI_INVALIDATE_TYPES.has(type)) return "ui:invalidate";
	return "worker:progress"; // default fallback
}

export interface RunEventPayload {
	type: RunEventType;
	runId: string;
	taskId?: string;
	timestamp?: string;
	data?: unknown;
	channel?: EventChannel;
}

export type RunEventCallback = (event: RunEventPayload) => void;

class RunEventBus {
	#listeners = new Map<string, Set<RunEventCallback>>();
	#globalListeners = new Set<RunEventCallback>();
	#channelListeners = new Map<EventChannel, Set<RunEventCallback>>();
	#channelRunListeners = new Map<string, Map<EventChannel, Set<RunEventCallback>>>();

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

	/** Subscribe to all events on a specific channel. */
	onChannel(channel: EventChannel, callback: RunEventCallback): () => void {
		const listeners = this.#channelListeners.get(channel) ?? new Set();
		listeners.add(callback);
		this.#channelListeners.set(channel, listeners);
		return () => {
			listeners.delete(callback);
			if (listeners.size === 0) this.#channelListeners.delete(channel);
		};
	}

	/** Subscribe to events on a specific channel for a given runId. */
	onChannelForRun(channel: EventChannel, runId: string, callback: RunEventCallback): () => void {
		const runKey = `${channel}::${runId}`;
		const runMap = this.#channelRunListeners.get(runKey) ?? new Map();
		const listeners = runMap.get(channel) ?? new Set();
		listeners.add(callback);
		runMap.set(channel, listeners);
		this.#channelRunListeners.set(runKey, runMap);
		return () => {
			listeners.delete(callback);
			if (listeners.size === 0) runMap.delete(channel);
			if (runMap.size === 0) this.#channelRunListeners.delete(runKey);
		};
	}

	emit(event: RunEventPayload): void {
		// Auto-classify channel if not already set
		if (!event.channel) {
			(event as { channel?: EventChannel }).channel = classifyEventChannel(event.type);
		}

		const channel = event.channel!;

		// Existing: runId-specific listeners
		const listeners = this.#listeners.get(event.runId);
		if (listeners) {
			for (const cb of listeners) {
				try { cb(event); } catch { /* subscriber errors are non-fatal */ }
			}
		}

		// Existing: global listeners
		for (const cb of this.#globalListeners) {
			try { cb(event); } catch { /* subscriber errors are non-fatal */ }
		}

		// New: channel listeners
		const channelListeners = this.#channelListeners.get(channel);
		if (channelListeners) {
			for (const cb of channelListeners) {
				try { cb(event); } catch { /* subscriber errors are non-fatal */ }
			}
		}

		// New: channel+runId listeners
		const runKey = `${channel}::${event.runId}`;
		const runMap = this.#channelRunListeners.get(runKey);
		if (runMap) {
			const runChannelListeners = runMap.get(channel);
			if (runChannelListeners) {
				for (const cb of runChannelListeners) {
					try { cb(event); } catch { /* subscriber errors are non-fatal */ }
				}
			}
		}
	}

	/** Dispose all subscriptions including channel-based ones. */
	dispose(): void {
		this.#listeners.clear();
		this.#globalListeners.clear();
		this.#channelListeners.clear();
		this.#channelRunListeners.clear();
	}

	listenerCount(runId?: string): number {
		if (runId) return this.#listeners.get(runId)?.size ?? 0;
		let total = this.#globalListeners.size;
		for (const set of this.#listeners.values()) total += set.size;
		for (const set of this.#channelListeners.values()) total += set.size;
		for (const runMap of this.#channelRunListeners.values()) {
			for (const set of runMap.values()) total += set.size;
		}
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