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
import { type RpcWorkerInput, resolveWorkerTransport, runRpcWorker } from "./rpc/rpc-worker.ts";
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

	/**
	 * W7 prototype-only: direct overrides for the RPC frame client (fake
	 * spawner, tiny timeouts). Tests inject a fake stream here; PRODUCTION
	 * callers must leave this unset — the defaults spawn the host pi binary
	 * (getPiSpawnCommand) with the live-fire argv. Never set by task-runner
	 * or any dispatch site.
	 */
	rpc?: RpcWorkerInput["rpc"];
}

/**
 * True when the RPC transport failed BEFORE the agent produced any output —
 * the only shape safe to retry on the stdio transport (the task was never
 * consumed). A result with `rawFinalText` (agent ran) or `aborted: true`
 * (caller cancelled) is NEVER retried: double-executing a task that already
 * produced work is worse than surfacing the transport error.
 *
 * Covers: pi binary missing/instant crash (prompt rejects fast via stdout
 * close — live-fire probe failure-injection path), rpc handshake/prompt
 * timeout, server prompt preflight rejection (the turn never started).
 */
export function isEarlyRpcTransportFailure(result: ChildPiRunResult): boolean {
	if (result.error === undefined) return false;
	if (result.rawFinalText !== undefined) return false;
	if (result.aborted) return false;
	return true;
}

/**
 * Spawn a child-Pi worker, applying the global worker-cap when `cap` is not
 * `false`. This is the single entry point for all worker spawns; callers should
 * never call `runChildPi` directly.
 *
 * The cap is applied AROUND the transport call so the slot is released on
 * completion OR throw (deadlock-safe via `withWorkerSlot`'s try/finally) —
 * this includes the RPC path, whose stdio fallback runs INSIDE the same slot
 * (one child at a time either way; a failed rpc spawn releases the slot via
 * the try/finally, it never hangs).
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
	const { cap = true, rpc: rpcOverrides, ...childPiInput } = input;
	// W7 (P2-3) EXPERIMENTAL transport seam: PI_CREW_WORKER_TRANSPORT=rpc
	// selects the RPC transport (WIRED 2026-10-04 after the live-fire probe
	// came back GREEN — see src/runtime/rpc/README.md + module header). The
	// rpc path maps the minimal input the prototype consumes (cwd/task/model/
	// signal — agent config, system-prompt files, skills, transcript, session
	// identity remain stdio-only; README "Limitations"). If the rpc transport
	// fails before any agent output, the spawn falls back to the stdio path
	// inside the same worker-cap slot (structured warn; never retried after
	// the agent produced output or on caller abort). Default/invalid env →
	// stdio path below, byte-identical to the pre-W7 behavior.
	if (resolveWorkerTransport() === "rpc") {
		const runRpcPath = async (): Promise<ChildPiRunResult> => {
			// Pre-aborted signal never reaches the rpc transport: mirror the
			// stdio path's B5 pre-spawn guard directly (a doomed rpc spawn would
			// only burn a command-timeout before producing the same aborted
			// result — and `result.aborted` is stamped by runRpcWorker for ANY
			// aborted signal, which would blind the early-failure predicate).
			if (childPiInput.signal?.aborted) return runChildPi(childPiInput);
			const rpcResult = await runRpcWorker({
				cwd: childPiInput.cwd,
				task: childPiInput.task,
				model: childPiInput.model,
				signal: childPiInput.signal,
				rpc: rpcOverrides,
			});
			if (!isEarlyRpcTransportFailure(rpcResult)) return rpcResult;
			console.error(
				`[pi-crew:run-worker.rpc-transport] rpc transport failed before any agent output (exitCode=${rpcResult.exitCode}, error=${rpcResult.error}) — falling back to the stdio transport for this spawn`,
			);
			return runChildPi(childPiInput);
		};
		if (cap) return withWorkerSlot(runRpcPath, childPiInput.signal);
		return runRpcPath();
	}
	if (cap) {
		// RR-014 / F15: thread the caller's signal into the slot WAIT itself.
		// Previously the signal lived only inside childPiInput and was read by
		// runChildPi AFTER the acquire resolved — a cancelled task queued on a
		// full pool stayed pending until the slot holder finished (and delayed
		// every drainPendingUnits awaiting it). Two consistent outcomes:
		// - abort wins the race → acquire rejects (SemaphoreAbortedError), no
		//   slot taken, fn never runs;
		// - grant wins the race → acquire resolves, runChildPi's pre-spawn
		//   guard (child-pi-spawn.ts B5) sees signal.aborted and returns
		//   kind "aborted" WITHOUT spawning, and withWorkerSlot's finally
		//   releases the slot within a microtask.
		return withWorkerSlot(() => runChildPi(childPiInput), childPiInput.signal);
	}
	return runChildPi(childPiInput);
}
