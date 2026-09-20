/**
 * Phase 6: Semaphore and fail-fast parallel execution.
 *
 * Adapted from oh-my-pi's `parallel.ts` Semaphore class and
 * `mapWithConcurrencyLimit` implementation. Provides:
 * - Explicit acquire/release Semaphore for concurrency control, with an
 *   OPTIONAL AbortSignal on acquire() (RR-014 / F15: a queued waiter settles
 *   promptly when its signal fires — it never waits out the current slot
 *   holder, and never consumes a slot once cancelled)
 * - Fail-fast on first error (via Promise.race) — mapWithFailFast below
 * - AbortSignal support for graceful cancellation — mapWithFailFast below
 * - Partial results on abort — mapWithFailFast below
 *
 * RR-014 / F15 defect history: acquire() previously took NO AbortSignal, so a
 * cancelled waiter stayed pending until the slot holder released, and then
 * "received" a slot it could never use (verified probe: acquire() returned
 * with signal.aborted === true). The signal-aware acquire below closes that:
 * aborted waiters are eagerly removed from the queue and REJECT with
 * SemaphoreAbortedError; #current never changes for an aborted acquire.
 */

/**
 * Rejection reason for {@link Semaphore.acquire} when the caller's AbortSignal
 * fires before a slot is granted (RR-014 / F15). Distinguishable via
 * `name === "SemaphoreAbortedError"` — an aborted acquire never bare-resolves.
 */
export class SemaphoreAbortedError extends Error {
	constructor() {
		super("Semaphore acquire aborted: the caller's AbortSignal fired before a slot was granted");
		this.name = "SemaphoreAbortedError";
	}
}

/** Lifecycle outcome of a queued waiter. */
type WaiterOutcome = "granted" | "aborted";

/**
 * Queue entry WITH identity (RR-014 / F15). The pre-fix queue stored bare
 * resolve functions: an aborted waiter could not be referenced or removed, so
 * it stayed pending until a release() handed it a slot it could never use.
 * A record with an idempotent settle() can detach itself from its abort
 * listener exactly once no matter how the abort↔handoff race resolves.
 */
interface Waiter {
	/** Resolves on "granted"; rejects with SemaphoreAbortedError on "aborted". */
	readonly promise: Promise<void>;
	/** Whether settle() already ran (first call wins). */
	readonly settled: boolean;
	/**
	 * Settle this waiter exactly once and detach its abort listener.
	 * - "granted" → resolve: the waiter now OWNS a slot and must release().
	 * - "aborted" → reject: the waiter never owned a slot.
	 */
	settle(kind: WaiterOutcome): void;
}

/**
 * Create a waiter and attach its abort listener on the CALLER'S signal
 * (never on a derived signal — a listener on AbortSignal.any() cannot be
 * removed from the original). `onAbort` runs synchronously when the signal
 * fires; the semaphore uses it to remove the waiter from the queue eagerly.
 */
function createWaiter(signal: AbortSignal | undefined, onAbort: () => void): Waiter {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	let isSettled = false;
	let detachListener: (() => void) | undefined;
	if (signal) {
		const listener = () => onAbort();
		signal.addEventListener("abort", listener, { once: true });
		detachListener = () => signal.removeEventListener("abort", listener);
	}
	return {
		promise,
		get settled() {
			return isSettled;
		},
		settle(kind: WaiterOutcome) {
			if (isSettled) return;
			isSettled = true;
			detachListener?.();
			detachListener = undefined;
			if (kind === "granted") resolve();
			else reject(new SemaphoreAbortedError());
		},
	};
}

/**
 * Simple counting semaphore for limiting concurrency across independently-scheduled async work.
 */
export class Semaphore {
	#max: number;
	#current = 0;
	#queue: Waiter[] = [];
	// FIX (Round 15): Cap the waiter queue to prevent unbounded memory growth
	// if the semaphore is held for a long period and many tasks accumulate.
	static readonly MAX_QUEUE = 10_000;

	constructor(max: number) {
		this.#max = Math.max(1, max);
	}

	/**
	 * Acquire a slot, optionally abortable (RR-014 / F15).
	 *
	 * - No signal → unchanged semantics: blocks until a slot frees.
	 * - Signal already aborted at entry → rejects immediately (fail-closed):
	 *   no slot taken, nothing enqueued. Abort listeners never re-fire for an
	 *   already-aborted signal, so such a waiter could never be removed later.
	 * - Signal fires while WAITING → the waiter is removed from the queue
	 *   EAGERLY (synchronously inside the abort listener) and rejects with
	 *   SemaphoreAbortedError. It never consumes a slot: #current is untouched.
	 *
	 * Abort↔handoff race resolves to exactly one consistent state because
	 * every #queue/#current mutation is synchronous (no await between them)
	 * and settle() is idempotent (first call wins, and it detaches the abort
	 * listener):
	 * - abort wins → the waiter was spliced out of the queue, so release()
	 *   cannot hand it a slot; the freed slot reaches the next ALIVE waiter
	 *   (or decrements #current). Capacity intact.
	 * - grant wins → settle("granted") detached the listener, so a later
	 *   abort is a no-op at semaphore level; the caller observes
	 *   signal.aborted and releases normally (runChildPi's pre-spawn guard
	 *   returns kind "aborted" without spawning, so withWorkerSlot's finally
	 *   releases the slot within a microtask of the grant).
	 */
	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(new SemaphoreAbortedError());
		}
		if (this.#current < this.#max) {
			this.#current++;
			// Re-check the abort↔grant window before resolving. The path above
			// is synchronous so the flag cannot flip today; this guards against
			// a future await being inserted here (belt-and-braces — concurrency
			// primitive). Never resolve a granted acquire for an aborted signal.
			if (signal?.aborted) {
				this.#current--;
				return Promise.reject(new SemaphoreAbortedError());
			}
			return;
		}
		// FIX (Round 15): Reject when the waiter queue is full. The previous
		// implementation let #queue grow without bound, risking memory
		// exhaustion under sustained high concurrency with slow releases.
		if (this.#queue.length >= Semaphore.MAX_QUEUE) {
			// P1-7: reject (don't throw) so callers can backpressure instead of crashing.
			return Promise.reject(
				new Error(`Semaphore queue full: ${this.#queue.length} waiters (max ${Semaphore.MAX_QUEUE}); cannot acquire slot`),
			);
		}
		const waiter = createWaiter(signal, () => {
			// Eager removal, synchronously inside the abort listener: the waiter
			// leaves the queue BEFORE settling. A release() that already
			// shift()ed it (grant won the race) finds settle() idempotent; a
			// release() that has not cannot hand a slot to a dead waiter.
			// #current is untouched — this waiter never owned a slot.
			const index = this.#queue.indexOf(waiter);
			if (index >= 0) this.#queue.splice(index, 1);
			waiter.settle("aborted");
		});
		this.#queue.push(waiter);
		return waiter.promise;
	}

	release(): void {
		// Hand the freed slot to the first ALIVE waiter (FIFO). A settled entry
		// still sitting in the queue is impossible with eager removal but is
		// skipped defensively — a slot must never burn on a dead waiter. Handoff
		// TRANSFERS ownership: #current is NOT decremented; only when no alive
		// waiter remains does it decrement.
		while (true) {
			const next = this.#queue.shift();
			if (next === undefined) {
				if (this.#current > 0) this.#current--;
				return;
			}
			if (next.settled) continue;
			next.settle("granted");
			return;
		}
		// Guard: over-release is a no-op to prevent #current going negative
	}

	/** Current number of acquired slots. */
	get current(): number {
		return this.#current;
	}

	/** Number of waiters in the queue. */
	get waiting(): number {
		return this.#queue.length;
	}
}

/**
 * Result of parallel execution with fail-fast support.
 */
export interface ParallelResult<R> {
	/** Results array — undefined entries indicate tasks that were skipped due to abort. */
	results: (R | undefined)[];
	/** Whether execution was aborted before all tasks completed. */
	aborted: boolean;
	/** The first error that triggered fail-fast, if any. */
	firstError?: unknown;
}

/**
 * Execute items with a concurrency limit, fail-fast, and abort signal support.
 *
 * - On first error: aborts remaining workers and rethrows.
 * - On external abort: returns partial results with `aborted: true`.
 * - Results are returned in the same order as input items.
 *
 * Adapted from oh-my-pi's `mapWithConcurrencyLimit`.
 */
/** @internal */
async function mapWithFailFast<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	signal?: AbortSignal,
): Promise<ParallelResult<R>> {
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: (R | undefined)[] = new Array(items.length);
	let nextIndex = 0;

	// Internal abort controller for fail-fast
	const abortController = new AbortController();
	const workerSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	// Promise that rejects on first error — used for fail-fast
	let rejectFirst: (error: unknown) => void;
	const firstErrorPromise = new Promise<never>((_, reject) => {
		rejectFirst = reject;
	});

	const worker = async (): Promise<void> => {
		while (true) {
			if (workerSignal.aborted) return;
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index], index, workerSignal);
			} catch (error) {
				if (!workerSignal.aborted) {
					abortController.abort();
					rejectFirst(error);
					throw error;
				}
			}
		}
	};

	const workers = Array.from({ length: limit }, () => worker());

	try {
		await Promise.race([Promise.all(workers), firstErrorPromise]);
	} catch (error) {
		if (signal?.aborted) {
			return { results, aborted: true, firstError: error };
		}
		throw error;
	}

	return { results, aborted: signal?.aborted ?? false };
}
