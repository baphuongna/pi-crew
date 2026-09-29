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

import { withRunLockSync } from "../../../state/coordination/locks.ts";
import type { TeamRunManifest } from "../../../state/types.ts";

/** Default bounded retry schedule for run.lock contention (ms). Five
 *  back-off attempts (~1.55s total) absorb a transient holder — e.g. the
 *  detached runner's state flush — without parking the request. */
export const DEFAULT_LOCK_BUSY_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];

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
