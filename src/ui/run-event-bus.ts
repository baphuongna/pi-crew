import type { TeamEvent } from "../state/event-log.ts";
import { readEventsCursor } from "../state/event-log.ts";
import type { RenderSchedulerEventBus } from "./render-scheduler.ts";

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
	| "run_cancelled"
	| "run.cache_invalidated";

/** Typed channel names for category-based event subscription. */
export type EventChannel = "worker:progress" | "worker:lifecycle" | "worker:stream" | "run:state" | "ui:invalidate";

/** Sets used by classifyEventChannel for O(1) lookup. */
const WORKER_PROGRESS_TYPES = new Set(["tool_execution_start", "tool_result", "agent_progress", "worker_status"]);
const WORKER_LIFECYCLE_TYPES = new Set([
	"task.started",
	"task.completed",
	"task.failed",
	"task.needs_attention",
	"task_started",
	"task_completed",
	"task_failed",
	"task_cancelled",
	"run.started",
	"run.completed",
	"run.cancelled",
	"run.failed",
	"run_started",
	"run_completed",
	"run_cancelled",
	"run_blocked",
]);
const WORKER_STREAM_TYPES = new Set(["stdout_chunk", "stderr_chunk", "stream"]);
const RUN_STATE_TYPES = new Set(["manifest.saved", "task.claimed", "task.unclaimed", "mailbox_updated"]);
const UI_INVALIDATE_TYPES = new Set(["effectiveness_changed", "snapshot_stale", "run.cache_invalidated"]);

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
	/**
	 * L1: monotonic sequence from the durable event log
	 * (`TeamEvent.metadata.seq`). Present on events that originated from a
	 * logged TeamEvent (via emitFromTeamEvent). Absent on transient live-only
	 * events (e.g. worker_status from the stream bridge) that are never
	 * persisted and therefore cannot be replayed or deduped.
	 *
	 * Used by onWithReplay() to dedup: a live event with seq <= the last seq
	 * replayed to a subscriber is suppressed (it was already delivered from
	 * the durable log).
	 */
	seq?: number;
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
		return () => {
			listeners.delete(callback);
			if (listeners.size === 0) this.#listeners.delete(runId);
		};
	}

	onAny(callback: RunEventCallback): () => void {
		this.#globalListeners.add(callback);
		return () => {
			this.#globalListeners.delete(callback);
		};
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

	/**
	 * L1: subscribe with a catch-up replay from the durable event log.
	 *
	 * Closes the transient-subscriber-absence gap: when an overlay/widget is
	 * disposed and recreated (toggle, reconnect), live events emitted in that
	 * window are lost as notification triggers. This method replays the
	 * missed TeamEvents from the durable JSONL log BEFORE attaching the live
	 * listener, then dedups so events delivered both ways fire exactly once.
	 *
	 * Unlike deer-flow's 256-event RAM ring buffer (lost on crash), this uses
	 * pi-crew's existing durable `readEventsCursor` — O(new bytes) via
	 * byte-offset incremental reads, monotonic seq, tail-capped. Strictly
	 * better: survives crashes, bounded memory.
	 *
	 * @param runId       Run to subscribe to (live listener scope).
	 * @param eventsPath  Path to the run's events JSONL (manifest.eventsPath).
	 * @param lastSeenSeq Last seq the caller processed; events with seq > this
	 *                    are replayed. Pass 0 to replay everything.
	 * @param callback    Receives both replayed and live events. Replayed
	 *                    events are delivered directly (NOT via emit, so no
	 *                    fan-out to other subscribers).
	 * @returns unsubscribe handle (detaches the live listener).
	 */
	onWithReplay(runId: string, eventsPath: string, lastSeenSeq: number, callback: RunEventCallback): () => void {
		// Phase 1: replay missed events from the durable log directly to this
		// callback. Bounded by limit; readEventsCursor already tail-caps.
		let maxReplayedSeq = lastSeenSeq;
		try {
			const cursor = readEventsCursor(eventsPath, {
				sinceSeq: lastSeenSeq,
				limit: 1000,
			});
			for (const teamEvent of cursor.events) {
				const type = teamEventToRunEventType(teamEvent);
				if (!type) continue; // not all TeamEvents map to a RunEventType
				const payload: RunEventPayload = {
					type,
					runId: teamEvent.runId,
					taskId: teamEvent.taskId,
					timestamp: teamEvent.time,
					data: teamEvent.data,
					channel: classifyEventChannel(type),
					seq: teamEvent.metadata?.seq,
				};
				try {
					callback(payload);
				} catch {
					/* subscriber errors are non-fatal */
				}
				if (typeof teamEvent.metadata?.seq === "number") {
					maxReplayedSeq = Math.max(maxReplayedSeq, teamEvent.metadata.seq);
				}
			}
		} catch {
			// Log read failures are non-fatal — fall through to live-only
			// subscription. The durable log may not exist yet for a brand-new run.
		}

		// Phase 2: attach the live listener with dedup. A live event whose seq
		// was already replayed (seq <= maxReplayedSeq) is suppressed. Events
		// without a seq (transient live-only, e.g. worker_status) always
		// deliver — they are never persisted and thus never replayed.
		const liveCallback: RunEventCallback = (event) => {
			if (typeof event.seq === "number" && event.seq <= maxReplayedSeq) return;
			callback(event);
		};
		return this.on(runId, liveCallback);
	}

	emit(event: RunEventPayload): void {
		// Auto-classify channel if not already set.
		// M2: Use local variable for routing, but also set on event
		// for subscriber API contract (listeners read event.channel).
		if (!event.channel) {
			(event as { channel?: EventChannel }).channel = classifyEventChannel(event.type);
		}
		const channel = event.channel!;

		// Existing: runId-specific listeners
		const listeners = this.#listeners.get(event.runId);
		if (listeners) {
			for (const cb of listeners) {
				try {
					cb(event);
				} catch {
					/* subscriber errors are non-fatal */
				}
			}
		}

		// Existing: global listeners
		for (const cb of this.#globalListeners) {
			try {
				cb(event);
			} catch {
				/* subscriber errors are non-fatal */
			}
		}

		// New: channel listeners
		const channelListeners = this.#channelListeners.get(channel);
		if (channelListeners) {
			for (const cb of channelListeners) {
				try {
					cb(event);
				} catch {
					/* subscriber errors are non-fatal */
				}
			}
		}

		// New: channel+runId listeners
		const runKey = `${channel}::${event.runId}`;
		const runMap = this.#channelRunListeners.get(runKey);
		if (runMap) {
			const runChannelListeners = runMap.get(channel);
			if (runChannelListeners) {
				for (const cb of runChannelListeners) {
					try {
						cb(event);
					} catch {
						/* subscriber errors are non-fatal */
					}
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

/**
 * 1.10 (UI-P1-1): adapt `runEventBus.onChannel` to the
 * `RenderSchedulerEventBus` interface so overlays can route their
 * `run:state` / `worker:lifecycle` / `ui:invalidate` subscriptions through
 * a `RenderScheduler` (debounce + fallback + per-runId coalescing) instead of
 * calling `runEventBus.onChannel(...)` directly three times. Without the
 * scheduler, a single event triggers up to 9 callbacks across the 3 overlays
 * (dashboard + sidebar + widget) and bursts into ~150 invalidate+requestRender
 * /sec under load.
 *
 * Returns a fresh adapter whose `on(event, handler)` is a thin shim over
 * `runEventBus.onChannel`. The channels list is closed-over so we can do a
 * defensive membership check without re-reading the channel set on every
 * subscription.
 */
export function runEventBusAsRenderScheduler(channels: readonly EventChannel[]): RenderSchedulerEventBus {
	const allowed = new Set<EventChannel>(channels);
	return {
		on: (event: string, handler: (payload: unknown) => void): (() => void) | void => {
			if (!allowed.has(event as EventChannel)) return undefined;
			return runEventBus.onChannel(event as EventChannel, handler);
		},
	};
}

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
		// L1: stamp the durable-log seq so onWithReplay() can dedup live
		// delivery against replayed events.
		seq: event.metadata?.seq,
	});
}
