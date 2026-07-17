/**
 * RenderCoalescer — batches multiple render requests into single render passes.
 * Prevents UI flicker when many events arrive in quick succession.
 * Inspired by oh-my-pi's PROGRESS_COALESCE_MS (150ms) pattern.
 */
import { logInternalError } from "../utils/internal-error.ts";

export interface RenderCoalescerOptions {
	/**
	 * Invoked once per coalesce window with the number of `request()` calls
	 * that were collapsed into the most recent scheduled render. Defaults to
	 * a debug-scoped `logInternalError` so dropped bursts surface in logs
	 * (gated behind PI_TEAMS_DEBUG) without callers having to wire one up.
	 */
	onDrop?: (droppedCount: number) => void;
}

export class RenderCoalescer {
	#pending = false;
	#timerId: ReturnType<typeof setTimeout> | null = null;
	#callback: () => void;
	#intervalMs: number;
	#onDrop: (droppedCount: number) => void;
	#dropped = 0;

	constructor(callback: () => void, intervalMs = 32, options: RenderCoalescerOptions = {}) {
		this.#callback = callback;
		this.#intervalMs = intervalMs;
		this.#onDrop =
			options.onDrop ??
			((count) => {
				logInternalError(
					"render-coalescer",
					new Error(`coalesced ${count} dropped request(s) into a single render`),
					undefined,
					"debug",
				);
			});
	}

	/** Request a render. Will be coalesced with other requests within the interval. */
	request(): void {
		if (this.#pending) {
			// A render is already scheduled — coalesce this request and bump
			// the drop counter so the scheduled flush can report how many
			// bursts were collapsed (useful for diagnosing UI lag).
			this.#dropped += 1;
			return;
		}
		this.#pending = true;
		const timer = setTimeout(() => {
			this.#pending = false;
			this.#timerId = null;
			const dropped = this.#dropped;
			this.#dropped = 0;
			if (dropped > 0) {
				try {
					this.#onDrop(dropped);
				} catch {
					/* drop callback errors are non-fatal */
				}
			}
			this.#callback();
		}, this.#intervalMs);
		timer.unref();
		this.#timerId = timer;
	}

	/** Force an immediate render, bypassing coalescing. */
	flush(): void {
		if (this.#timerId !== null) {
			clearTimeout(this.#timerId);
			this.#timerId = null;
		}
		this.#pending = false;
		this.#callback();
	}

	/** Check if a render is pending. */
	get pending(): boolean {
		return this.#pending;
	}

	/** Clean up timers. Call when the coalescer is no longer needed. */
	dispose(): void {
		if (this.#timerId !== null) {
			clearTimeout(this.#timerId);
			this.#timerId = null;
		}
		this.#pending = false;
	}
}
