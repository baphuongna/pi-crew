import type { AgentProgress } from "../runtime/progress-tracker.ts";
import { logInternalError } from "../utils/internal-error.ts";

export type CrewEventType = "agent:progress" | "agent:complete" | "agent:error" | "run:start" | "run:complete";

export interface CrewEvent {
	type: CrewEventType;
	runId: string;
	agentId?: string;
	payload?: AgentProgress | string;
	timestamp: number;
}

type CrewEventListener = (event: CrewEvent) => void;

class EventBus {
	private static readonly MAX_LISTENERS_PER_EVENT = 100;
	private listeners = new Map<CrewEventType, Set<CrewEventListener>>();
	private static _instance?: EventBus;

	static getInstance(): EventBus {
		if (!EventBus._instance) {
			EventBus._instance = new EventBus();
		}
		return EventBus._instance;
	}

	/**
	 * Dispose of the EventBus instance and clear all listeners.
	 * Resets the singleton so a new instance can be created.
	 */
	dispose(): void {
		this.listeners.clear();
		EventBus._instance = undefined;
	}

	emit(event: CrewEvent): void {
		const listeners = this.listeners.get(event.type);
		if (listeners) {
			for (const listener of listeners) {
				try {
					listener(event);
				} catch (e) {
					// FIX (Round 15, L1): Use logInternalError for consistency with
					// the rest of the codebase. Previously console.error may not be
					// visible in all environments (e.g. JSON-RPC mode, redirected
					// stderr).
					logInternalError("event-bus.listener", e, `type=${event.type} runId=${event.runId}`);
				}
			}
		}
	}

	on(type: CrewEventType, listener: CrewEventListener): () => void {
		if (!this.listeners.has(type)) {
			this.listeners.set(type, new Set());
		}
		const set = this.listeners.get(type)!;
		if (set.size >= EventBus.MAX_LISTENERS_PER_EVENT) {
			logInternalError(
				"event-bus.listener-cap",
				new Error(`Max ${EventBus.MAX_LISTENERS_PER_EVENT} listeners reached for event type '${type}'`),
				`type=${type} currentCount=${set.size}`,
			);
		}
		set.add(listener);

		return () => {
			this.listeners.get(type)?.delete(listener);
		};
	}

	off(type: CrewEventType, listener: CrewEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}
}

/**
 * Global event bus for crew lifecycle events.
 *
 * NOTE: Currently only emits — no production subscribers yet.
 * The `runEventBus` (from `ui/run-event-bus.ts`) is the active event system.
 * This bus is retained for future observability/SIEM integration.
 * See also: progress-tracker.ts which emits agent:progress events.
 */
export const crewEventBus = EventBus.getInstance();
