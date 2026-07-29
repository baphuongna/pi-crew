/**
 * Phase 6: Semaphore and fail-fast parallel execution.
 *
 * Adapted from oh-my-pi's `parallel.ts` Semaphore class and
 * `mapWithConcurrencyLimit` implementation. Provides:
 * - Explicit acquire/release Semaphore for concurrency control
 * - Fail-fast on first error (via Promise.race)
 * - AbortSignal support for graceful cancellation
 * - Partial results on abort
 */

/**
 * Simple counting semaphore for limiting concurrency across independently-scheduled async work.
 */
export class Semaphore {
	#max: number;
	#current = 0;
	#queue: Array<() => void> = [];
	// FIX (Round 15): Cap the waiter queue to prevent unbounded memory growth
	// if the semaphore is held for a long period and many tasks accumulate.
	static readonly MAX_QUEUE = 10_000;

	constructor(max: number) {
		this.#max = Math.max(1, max);
	}

	async acquire(): Promise<void> {
		if (this.#current < this.#max) {
			this.#current++;
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
		const { promise, resolve } = (() => {
			let res: () => void;
			const p = new Promise<void>((r) => {
				res = r;
			});
			return { promise: p, resolve: res! };
		})();
		this.#queue.push(resolve);
		return promise;
	}

	release(): void {
		const next = this.#queue.shift();
		if (next) {
			next();
		} else if (this.#current > 0) {
			this.#current--;
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
