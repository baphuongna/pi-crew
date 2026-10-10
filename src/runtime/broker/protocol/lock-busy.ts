/**
 * lock-busy.ts — RR-023 F4 (2026-09-29 full battery, finding #4).
 *
 * Broker-handler degradation for run.lock contention. Root cause: the
 * wait.request / delegate.request handlers run their state RMW inside
 * withRunLockSync; acquireLockWithRetry (locks.ts, canSteal=false) throws
 * IMMEDIATELY when a live cross-process holder (e.g. the detached runner
 * persisting task state) owns run.lock, and that throw escaped handleData →
 * closeConnection — workers saw an untyped `code=close` socket death
 * (evidence: team_20260929041005 ask-probe / team_20260929041020
 * delegate-probe, both dead within ~5ms; the SYNC foreground run was the
 * zero-contention control).
 *
 * Fix layer is the broker ONLY — locks.ts steal semantics are the v0.9.26
 * lock-family invariant and stay untouched (a live holder is never stolen).
 * Precedent: protocol/request-parsers.ts (M4/WI-4.1 extraction discipline).
 */

import { withRunLock, withRunLockSync } from "../../../state/coordination/locks.ts";
import type { TeamRunManifest } from "../../../state/types.ts";

/** Default bounded retry schedule for run.lock contention (ms). Five
 *  back-off attempts (~1.55s total) absorb a transient holder — e.g. the
 *  detached runner's state flush — without parking the request. */
export const DEFAULT_LOCK_BUSY_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];

/** Merge-site busy-retry schedule (ms) — RELIABILITY FIX 2026-10-10
 *  (run team_20261010100956 incident: background-runner killed by an
 *  unhandled rejection when mergeUnitResult's withRunLock lost a run.lock
 *  contention race against a concurrent writer). Longer than the broker
 *  default above: a merge under contention sits on the scheduler's critical
 *  path — the run is mid-flight and the settled unit is held in memory — so
 *  it is worth ~7.9s of back-off (6 attempts) before the busy error is
 *  allowed to propagate to the run-level error handler. Each attempt itself
 *  already waits up to staleMs*2 inside acquireLockWithRetryAsync for
 *  in-process holders; this schedule covers the LIVE FOREIGN holder case,
 *  which throws immediately. */
export const MERGE_LOCK_BUSY_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000, 2000, 4000];

/** Match the exact identity locks.ts throws for a LIVE holder on the
 *  never-steal path (sync acquireLockWithRetry, its async twin, and the
 *  lockCtx fallthrough): `Run '<basename>' is locked by another operation.`
 *  Classification is by message identity — locks.ts exports no error class
 *  (plain Error), and src/state must not be edited from the broker layer. */
const RUN_LOCK_BUSY_MESSAGE = /^Run '[^']+' is locked by another operation\.$/;

export function isRunLockBusyError(error: unknown): boolean {
	return error instanceof Error && RUN_LOCK_BUSY_MESSAGE.test(error.message);
}

/** Result of a run-locked RMW under the busy-retry policy: either the body's
 *  value, or the typed busy degradation (message derived from the underlying
 *  lock error — it names run.lock, so it matches /run\.lock|busy/i). */
export type LockBusyOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** Run `fn` under withRunLockSync with a bounded busy-retry.
 *
 *  Retry safety: the busy throw is raised by the lock ACQUIRE before `fn`
 *  runs (locks.ts), and in the broker's wait/delegate bodies every nested
 *  state write is lockCtx-reentrant (same-context nesting never re-acquires),
 *  so a retry never re-executes a partially-run body. Any NON-busy error
 *  propagates unchanged (previous handler behavior for real faults).
 *  Waits use async sleep — the broker event loop keeps serving other
 *  connections (and pings) between attempts. */
export async function withRunLockBusyRetry<T>(
	manifest: TeamRunManifest,
	delaysMs: readonly number[],
	fn: () => T,
): Promise<LockBusyOutcome<T>> {
	for (let attempt = 0; ; attempt++) {
		try {
			return { ok: true, value: withRunLockSync(manifest, fn) };
		} catch (error) {
			if (!isRunLockBusyError(error)) throw error;
			const delay = delaysMs[attempt];
			if (delay === undefined) {
				return {
					ok: false,
					message: `run.lock busy (bounded retry budget exhausted): ${(error as Error).message}`,
				};
			}
			await sleep(delay);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Async twin of withRunLockBusyRetry for the scheduler's merge sites
 *  (merge-loop.ts mergeUnitResult, budget-enforcement.ts
 *  terminaliseRunWithDrain): run `fn` under the ASYNC withRunLock with a
 *  bounded busy-retry, notifying `onRetry` before each back-off sleep so the
 *  call site can log a lock_retry event.
 *
 *  Retry safety mirrors the sync twin: the busy throw is raised by the lock
 *  ACQUIRE before `fn` runs, and every nested state write inside the merge
 *  bodies is lockCtx-reentrant (same-context nesting never re-acquires), so a
 *  retry never re-executes a partially-run body. Any NON-busy error
 *  propagates unchanged — real faults (ENOSPC, EACCES, corruption) keep their
 *  current fatal path; only the transient contention identity is retried.
 *  When the schedule is exhausted the busy error is rethrown for the run-level
 *  handler to classify (bounded — never an infinite loop). */
export async function withRunLockBusyRetryAsync<T>(
	manifest: TeamRunManifest,
	delaysMs: readonly number[],
	fn: () => Promise<T>,
	onRetry?: (attempt: number, delayMs: number, error: Error) => void,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await withRunLock(manifest, fn);
		} catch (error) {
			if (!isRunLockBusyError(error)) throw error;
			const delay = delaysMs[attempt];
			if (delay === undefined) throw error;
			onRetry?.(attempt + 1, delay, error as Error);
			await sleep(delay);
		}
	}
}
