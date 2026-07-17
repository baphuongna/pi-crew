/**
 * RenderCoalescer — batches multiple render requests into single render passes.
 * Prevents UI flicker when many events arrive in quick succession.
 * Inspired by oh-my-pi's PROGRESS_COALESCE_MS (150ms) pattern.
 */
export class RenderCoalescer {
	#pending = false;
	#timerId: ReturnType<typeof setTimeout> | null = null;
	#callback: () => void;
	#intervalMs: number;

	constructor(callback: () => void, intervalMs = 32) {
		this.#callback = callback;
		this.#intervalMs = intervalMs;
	}

	/** Request a render. Will be coalesced with other requests within the interval. */
	request(): void {
		if (this.#pending) return;
		this.#pending = true;
		const timer = setTimeout(() => {
			this.#pending = false;
			this.#timerId = null;
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
