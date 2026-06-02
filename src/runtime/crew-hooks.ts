/**
 * Crew Hook System — a hook-based observation system for pi-crew runtime.
 *
 * Provides a reliable, fire-and-forget event system for observing crew lifecycle events.
 * Hooks are executed synchronously without blocking the emitter.
 *
 * @example
 * ```typescript
 * import { crewHooks } from './runtime/crew-hooks.ts';
 *
 * // Register a hook
 * const myHook = (event) => {
 *   console.log(`Event: ${event.type}`, event);
 * };
 * crewHooks.register('task_started', myHook);
 *
 * // Emit an event
 * crewHooks.emit({ type: 'task_started', timestamp: new Date().toISOString(), runId: 'run-123', taskId: 'task-1' });
 *
 * // Unregister when done
 * crewHooks.unregister('task_started', myHook);
 * ```
 */

import { logInternalError } from "../utils/internal-error.ts";

/** Valid hook event types in the crew lifecycle. */
export type CrewHookEventType =
	| 'task_started'
	| 'task_completed'
	| 'task_failed'
	| 'run_completed'
	| 'run_failed';

/**
 * A hook event emitted by the crew runtime.
 */
export interface CrewHookEvent {
	/** The type of event being emitted. */
	type: CrewHookEventType;
	/** ISO timestamp of when the event occurred. */
	timestamp: string;
	/** The unique identifier of the run that generated this event. */
	runId: string;
	/** Optional task identifier (present for task-scoped events). */
	taskId?: string;
	/** Optional additional event data. */
	data?: Record<string, unknown>;
}

/**
 * A hook function that can be registered to receive crew events.
 * May be synchronous or return a Promise (async hooks are fire-and-forget).
 */
export type CrewHook = (event: CrewHookEvent) => void | Promise<void>;

/**
 * Type guard to check if a value is a valid CrewHookEventType.
 */
export function isValidEventType(type: string): type is CrewHookEventType {
	return (
		type === 'task_started' ||
		type === 'task_completed' ||
		type === 'task_failed' ||
		type === 'run_completed' ||
		type === 'run_failed'
	);
}

/**
 * Type guard to check if an object is a valid CrewHookEvent.
 */
export function isHookEvent(obj: unknown): obj is CrewHookEvent {
	if (typeof obj !== 'object' || obj === null) return false;
	const event = obj as Record<string, unknown>;
	return (
		typeof event.type === 'string' &&
		isValidEventType(event.type) &&
		typeof event.timestamp === 'string' &&
		typeof event.runId === 'string' &&
		(event.taskId === undefined || typeof event.taskId === 'string') &&
		(event.data === undefined || typeof event.data === 'object')
	);
}

/**
 * Registry for managing and emitting crew lifecycle hooks.
 *
 * Hooks are stored in Sets for efficient insertion, deletion, and iteration.
 * The emit() method executes all registered hooks synchronously without awaiting
 * async completions, ensuring 100% reliable event firing without blocking.
 */
export class HookRegistry {
	private readonly hooks: Map<CrewHookEventType, Set<CrewHook>>;

	constructor() {
		this.hooks = new Map();
		// Initialize with empty Sets for all event types
		const eventTypes: CrewHookEventType[] = [
			'task_started',
			'task_completed',
			'task_failed',
			'run_completed',
			'run_failed',
		];
		for (const type of eventTypes) {
			this.hooks.set(type, new Set());
		}
	}

	/**
	 * Register a hook to be called when the specified event type is emitted.
	 *
	 * @param eventType - The type of event to listen for
	 * @param hook - The hook function to register
	 */
	register(eventType: CrewHookEventType, hook: CrewHook): void {
		const hooksForType = this.hooks.get(eventType);
		if (hooksForType) {
			hooksForType.add(hook);
		}
	}

	/**
	 * Unregister a previously registered hook.
	 *
	 * @param eventType - The type of event the hook was registered for
	 * @param hook - The hook function to remove
	 */
	unregister(eventType: CrewHookEventType, hook: CrewHook): void {
		const hooksForType = this.hooks.get(eventType);
		if (hooksForType) {
			hooksForType.delete(hook);
		}
	}

	/**
	 * Emit an event to all registered hooks for that event type.
	 *
	 * This method executes all hooks synchronously and does not await async hooks.
	 * Errors thrown by hooks are caught and logged but do not prevent other hooks
	 * from executing or block the caller.
	 *
	 * @param event - The event to emit
	 */
	emit(event: CrewHookEvent): void {
		// Validate event type using type guard
		if (!isValidEventType(event.type)) {
			console.warn(`[crew-hooks] Unknown event type: ${event.type}`);
			return;
		}

		const hooksForType = this.hooks.get(event.type);
		if (!hooksForType || hooksForType.size === 0) {
			return;
		}

		// Execute all hooks - fire-and-forget pattern
		// We iterate over a snapshot to allow safe modification during iteration
		const hooksSnapshot = Array.from(hooksForType);
		for (const hook of hooksSnapshot) {
			try {
				const result = hook(event);
				// If the hook returns a Promise, we intentionally do NOT await it.
				// This is the "fire-and-forget" pattern - async hooks run in background.
				if (result instanceof Promise) {
					// Attach a silent catch to prevent unhandled rejection warnings
					result.catch((err) => {
						logInternalError("crew-hooks.async", err, `event.type=${event.type}`);
					});
				}
			} catch (err) {
				// Catch synchronous errors but don't let them block other hooks
				logInternalError("crew-hooks.sync", err, `event.type=${event.type}`);
			}
		}
	}

	/**
	 * Get all hooks registered for a specific event type.
	 *
	 * Returns a snapshot of the current hooks. The returned array is a new copy,
	 * so modifications to it won't affect the registry.
	 *
	 * @param eventType - The event type to query
	 * @returns Array of registered hooks (may be empty)
	 */
	hooksFor(eventType: CrewHookEventType): CrewHook[] {
		const hooksForType = this.hooks.get(eventType);
		if (!hooksForType) {
			return [];
		}
		return Array.from(hooksForType);
	}

	/**
	 * Get the count of hooks registered for a specific event type.
	 *
	 * @param eventType - The event type to query
	 * @returns Number of registered hooks
	 */
	count(eventType: CrewHookEventType): number {
		const hooksForType = this.hooks.get(eventType);
		return hooksForType?.size ?? 0;
	}

	/**
	 * Remove all hooks for a specific event type.
	 *
	 * @param eventType - The event type to clear
	 */
	clear(eventType: CrewHookEventType): void {
		const hooksForType = this.hooks.get(eventType);
		if (hooksForType) {
			hooksForType.clear();
		}
	}

	/**
	 * Remove all registered hooks across all event types.
	 */
	clearAll(): void {
		for (const hooksForType of this.hooks.values()) {
			hooksForType.clear();
		}
	}
}

/**
 * Global singleton instance of HookRegistry for use throughout pi-crew.
 *
 * @example
 * ```typescript
 * import { crewHooks } from './runtime/crew-hooks.ts';
 *
 * // Simple logging hook
 * crewHooks.register('task_completed', (event) => {
 *   console.log(`Task ${event.taskId} completed in run ${event.runId}`);
 * });
 * ```
 */
export const crewHooks = new HookRegistry();
