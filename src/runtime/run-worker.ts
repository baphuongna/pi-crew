/**
 * run-worker.ts — Unified worker spawn facade (CORE-13).
 *
 * Consolidates the 4 `runChildPi` call sites (task-runner, run-coalesced-task-
 * group, dynamic-workflow-context, goal-evaluator) behind a single entry point
 * that owns the global worker-cap (`withWorkerSlot`) wrap + the `runChildPi`
 * call + standardized option assembly.
 *
 * ─── WHY ───
 * Before CORE-13, 4 sites each inlined `withWorkerSlot(() => runChildPi(...))`
 * (or skipped the cap for the judge). The wrapping was inconsistent and easy to
 * drift (Sprint 2 CORE-2 had to patch 2 of the 4 sites individually). This
 * facade centralizes the wrap so future changes (e.g. CORE-3 spawn budget) have
 * exactly ONE place to touch.
 *
 * ─── CAP FLAG ───
 * The goal-judge (goal-evaluator.ts) is intentionally exempt from the global
 * worker-cap per RFC MAJ#3 (see global-worker-cap.ts module header). Callers
 * pass `cap: false` to bypass `withWorkerSlot`; all worker spawns default to
 * `cap: true` (the cap applies).
 *
 * ─── WHAT runWorker DOES NOT OWN ───
 * Retry (`executeWithRetry`) stays at the caller level — the 4 sites have
 * different retry policies and retry wraps runWorker, not the other way around.
 * Heartbeat timers, progress persistence, and transcript parsing are also
 * caller-owned (they need task/manifest state that runWorker does not see).
 */

import type { ChildPiRunInput, ChildPiRunResult } from "./child-pi/child-pi.ts";
import { runChildPi } from "./child-pi/child-pi.ts";
import { withWorkerSlot } from "./scheduling/global-worker-cap.ts";

/**
 * Input for {@link runWorker}. Extends {@link ChildPiRunInput} with the `cap`
 * flag that controls whether the global worker-cap semaphore is applied.
 *
 * All fields from `ChildPiRunInput` (cwd, task, agent, model, signal, maxTurns,
 * graceTurns, transcriptPath, steeringFile, skillPaths, onSpawn,
 * onLifecycleEvent, onStdoutLine, onJsonEvent, etc.) are passed through
 * unchanged to `runChildPi`.
 */
export interface WorkerSpawnInput extends ChildPiRunInput {
	/**
	 * Whether to wrap the spawn in the global worker-cap (`withWorkerSlot`).
	 * Default: `true` (all worker spawns).
	 *
	 * Set to `false` for the goal-judge (goal-evaluator.ts), which is exempt
	 * from the cap per RFC MAJ#3 — see `global-worker-cap.ts` module header.
	 */
	cap?: boolean;
}

/**
 * Spawn a child-Pi worker, applying the global worker-cap when `cap` is not
 * `false`. This is the single entry point for all worker spawns; callers should
 * never call `runChildPi` directly.
 *
 * The cap is applied AROUND `runChildPi` so the slot is released on completion
 * OR throw (deadlock-safe via `withWorkerSlot`'s try/finally).
 *
 * Retry is NOT handled here — callers wrap `runWorker` in `executeWithRetry` as
 * needed (task-runner and run-coalesced use retry; dynamic-workflow-context and
 * goal-evaluator do not).
 *
 * @example
 * // Worker spawn (cap applied):
 * const result = await runWorker({ cwd, task, agent, model, signal, ... });
 *
 * // Judge spawn (cap bypassed):
 * const result = await runWorker({ cwd, task, agent, model, signal, cap: false });
 */
export async function runWorker(input: WorkerSpawnInput): Promise<ChildPiRunResult> {
	const { cap = true, ...childPiInput } = input;
	if (cap) {
		return withWorkerSlot(() => runChildPi(childPiInput));
	}
	return runChildPi(childPiInput);
}
