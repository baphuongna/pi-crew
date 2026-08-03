/**
 * global-worker-cap.ts — Global WORKER-process concurrency cap (P1g).
 *
 * RFC: research-findings/goal-workflow/13-VISION-RFC.md v0.5 §P1g + MAJ#3.
 *
 * Bounds concurrent WORKER spawns (worker turns, executeTeamRun, dynamic-
 * workflow ctx.agent()/fanOut) to prevent fork-storm DoS. The cap is a fair
 * async semaphore (FIFO queue) defaulting to max(2, os.cpus().length - 2),
 * overridable by env PI_CREW_MAX_WORKERS (parse int; invalid/missing → the
 * computed default).
 *
 * ─── WHY THE GOAL-JUDGE IS EXEMPT (RFC MAJ#3) ───
 * Do NOT route goal-judge spawns through this cap. The judge is naturally
 * bounded — exactly 1 judge per turn, maxTurns:3, no tools (it emits a short
 * JSON verdict, not long agentic loops). A goal cannot spawn many judges, so
 * the judge is NOT a fork-storm vector. Routing the judge through the cap
 * would risk DEADLOCK under contention: a judge could wait on a worker slot
 * that never frees (e.g. all slots held by workers waiting on the judge's
 * verdict). Bounding WORKERS alone bounds the real DoS surface; the exempt
 * judge cannot starve them. Workers must therefore call acquireWorkerSlot()
 * around their runChildPi spawns; judge spawns (goal-evaluator) must not.
 */

import * as os from "node:os";
import { Semaphore } from "./semaphore.ts";

/**
 * Resolve the worker-cap capacity from PI_CREW_MAX_WORKERS or the computed
 * default. Invalid env values (non-numeric, ≤0, NaN) fall back to the default
 * rather than silently disabling the cap.
 */
function resolveCapacity(): number {
	const env = process.env.PI_CREW_MAX_WORKERS;
	if (env !== undefined && env !== "") {
		const parsed = Number.parseInt(env, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
		// Invalid env value → fall back to default (don't silently accept 0/negative).
	}
	const cpus = os.cpus().length;
	return Math.max(2, cpus - 2);
}

let capacity: number = resolveCapacity();
let semaphore: Semaphore = new Semaphore(capacity);

/** Resolved capacity of the global worker cap (env override or default). */
export function getWorkerCapCapacity(): number {
	return capacity;
}

/**
 * @internal Test-only: reinitialize the cap with a specific capacity and a
 * fresh empty queue. Production code must not call this.
 */
export function __test_resetCap(testCapacity: number): void {
	capacity = Math.max(1, testCapacity);
	semaphore = new Semaphore(capacity);
}

/**
 * Acquire a global worker slot. Resolves immediately if under cap, else queues
 * (FIFO) until a slot frees. MUST be paired with releaseWorkerSlot().
 *
 * Used to bound WORKER spawns only. Do NOT route the goal-judge through this
 * (see the RFC MAJ#3 rationale in the module header).
 */
export async function acquireWorkerSlot(): Promise<void> {
	await semaphore.acquire();
}

/**
 * Release a previously acquired worker slot. Over-release (calling release
 * without a matching acquire) is a no-op (the underlying Semaphore guards it).
 */
export function releaseWorkerSlot(): void {
	semaphore.release();
}

/**
 * Convenience: acquire a worker slot, run `fn`, and release on completion OR
 * throw. The slot is ALWAYS released — including when `fn` rejects — so a
 * throwing worker never leaks a slot (deadlock prevention).
 *
 * Example:
 *   const result = await withWorkerSlot(() => runChildPi(...));
 */
export async function withWorkerSlot<T>(fn: () => Promise<T>): Promise<T> {
	await acquireWorkerSlot();
	try {
		return await fn();
	} finally {
		releaseWorkerSlot();
	}
}
