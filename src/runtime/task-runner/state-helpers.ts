import * as fs from "node:fs";
import { flushPendingAtomicWrites } from "../../state/atomic-write.ts";
import { withRunLockSync } from "../../state/coordination/locks.ts";
import { loadRunManifestById, saveRunTasksCoalesced } from "../../state/stores/state-store.ts";
import type { TaskCheckpointState, TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { recordFromTask, upsertCrewAgent } from "../crew-agent-records.ts";

export function updateTask(tasks: TeamTaskState[], updated: TeamTaskState): TeamTaskState[] {
	return tasks.map((task) => (task.id === updated.id ? updated : task));
}

/**
 * Persist a single task update using compare-and-swap under the run lock.
 *
 * Problem: The naive read-merge-write pattern is vulnerable to a read-modify-write
 * race. When two parallel task completions race:
 *   1. Task A loads tasks [A(running), B(running)], writes [A(completed), B(running)]
 *   2. Task B loads [A(running), B(running)] (stale, before A's write), writes [A(running), B(completed)]
 *   Result: Task A's completed status is clobbered.
 *
 * Solution: Use mtime-based CAS under the run lock. Before writing, stat the tasks file
 * to record its mtime. After merging, re-stat — if mtime changed, another writer
 * committed first; retry with the fresh state. This is O(retry) under contention but
 * converges in the normal single-writer case.
 *
 * ST-7: pass `skipCoalesce: true` when persisting a TERMINAL task status
 * (completed/failed/cancelled/needs_attention/skipped). Without this the
 * underlying `saveRunTasksCoalesced` would buffer the write for 50ms; a
 * SIGKILL in that window loses the terminal update and crash recovery
 * would see "running" in tasks.json while events.jsonl already shows
 * "completed". For non-terminal transitions (heartbeat, progress) the
 * default buffered write is fine and matches prior behavior.
 *
 * @param checkpointPhase - Optional checkpoint phase to include in the task state alongside the update.
 */
export function persistSingleTaskUpdate(
	manifest: TeamRunManifest,
	fallbackTasks: TeamTaskState[],
	updated: TeamTaskState,
	checkpointPhase?: TaskCheckpointState["phase"],
	skipCoalesce: boolean = false,
): TeamTaskState[] {
	// H5 (2026-08-10): lowered from 100 → 10. Each retry does
	// flushPendingAtomicWrites (global) + loadRunManifestById (stat + parse)
	// + statSync, ~5ms each. Every attempt now loads from disk (BUG-028);
	// retries only fire under real contention from best-effort writers that
	// don't hold the run lock (async-notifier, crash-recovery). If 10 retries
	// cannot converge, the system is in a pathological state where 100 would
	// not help either — the explicit error below surfaces it instead of
	// blocking the event loop for 500ms.
	const MAX_CAS_ATTEMPTS = 10;
	let baseMtime = 0;
	try {
		baseMtime = fs.statSync(manifest.tasksPath).mtimeMs;
	} catch {
		// File doesn't exist yet — baseMtime=0 means "anything is fine"
		baseMtime = 0;
	}

	let merged: TeamTaskState[] | undefined;

	// Build the task with optional checkpoint phase
	const taskWithCheckpoint = checkpointPhase
		? {
				...updated,
				checkpoint: {
					phase: checkpointPhase,
					updatedAt: new Date().toISOString(),
				},
			}
		: updated;

	try {
		return withRunLockSync(manifest, () => {
			for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
				// F4: persistSingleTaskUpdate now uses saveRunTasksCoalesced below
				// (50ms debounce window). Read-modify-write loops are unsafe under
				// coalescing — a parallel writer's buffered write is invisible to
				// loadRunManifestById until it actually lands. Force any pending
				// coalesced writes to flush first so this read sees the latest
				// durable state. Without this guard, a parallel writer could
				// overwrite our buffered write between our load and our (async)
				// fsync, silently losing the intermediate update.
				flushPendingAtomicWrites();
				// BUG-028 (2026-08-16): ALWAYS load the committed tasks from disk
				// inside the lock — never trust fallbackTasks on attempt 0. The
				// old F4 perf shortcut assumed "the caller already obtained the
				// latest tasks via loadRunManifestById and handed them in as
				// fallbackTasks", but that assumption is FALSE for fan-out
				// workers: dispatch-batch.ts hands every unit the SAME dispatch-
				// time snapshot (ctx.tasks), and the worker's array is only ever
				// updated with its OWN task (updateTask). When the LAST unit of
				// a batch terminal-persists, attempt 0 wrote the FULL stale array
				// (siblings still "running") over disk where siblings were already
				// terminal — resurrecting them and blocking finalize ("task is
				// still running"). The mtime CAS below cannot catch this: it only
				// detects writers between the entry stat and the in-lock stat,
				// i.e. staleness acquired AFTER function entry — not fallback
				// staleness that predates it. Loading disk here makes sibling
				// state authoritative (matching mergeUnitResult / bug-027 policy)
				// while `updated` still wins for THIS task via updateTask.
				// fallbackTasks remains the fallback when the run state is absent
				// (fresh run, manifest not yet on disk).
				const latest = loadRunManifestById(manifest.cwd, manifest.runId)?.tasks ?? fallbackTasks;
				merged = updateTask(latest, taskWithCheckpoint);

				// F2: collapsed from 3 redundant statSync calls into 1. The previous
				// implementation re-checked mtime twice more after load and before
				// write, but since the code is synchronous and `loadRunManifestById`
				// holds no I/O-yield between the load and this stat, those re-checks
				// always returned the same mtime and added nothing. The one CAS below
				// remains necessary for best-effort writers (async-notifier,
				// crash-recovery) that don't acquire the run lock.
				let currentMtime: number;
				try {
					currentMtime = fs.statSync(manifest.tasksPath).mtimeMs;
				} catch {
					// Run state deleted (prune/forget) — nothing to persist.
					return fallbackTasks;
				}

				if (currentMtime !== baseMtime) {
					// Another writer committed — their update is in latest, re-merge on top
					baseMtime = currentMtime;
					continue;
				}

				break;
			}

			if (merged === undefined) {
				logInternalError(
					"persistSingleTaskUpdate",
					new Error(`failed to converge after ${MAX_CAS_ATTEMPTS} attempts`),
					undefined,
					"error",
				);
				throw new Error(`persistSingleTaskUpdate: failed to converge after ${MAX_CAS_ATTEMPTS} attempts`);
			}

			try {
				// F4: coalesced write inside the withRunLockSync critical section.
				// The mtime CAS retry loop above still guards against concurrent
				// non-coalesced writers; the flushPendingAtomicWrites() guard at
				// the top of the retry loop ensures reads see any other coalesced
				// writer's flushed-before-this-call state.
				// ST-7: terminal transitions (skipCoalesce=true) bypass the 50ms
				// coalesce window so a SIGKILL after the persist completes cannot
				// leave tasks.json stale with a non-terminal status.
				saveRunTasksCoalesced(manifest, merged, skipCoalesce);
			} catch (err) {
				logInternalError("persistSingleTaskUpdate", err, undefined, "error");
				throw err;
			}
			return merged;
		});
	} catch (err) {
		if (merged === undefined) {
			logInternalError("persistSingleTaskUpdate", err, undefined, "error");
		}
		throw err;
	}
}

export function checkpointTask(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	task: TeamTaskState,
	phase: TaskCheckpointState["phase"],
	childPid?: number,
): { task: TeamTaskState; tasks: TeamTaskState[] } {
	const checkpoint: TaskCheckpointState = {
		phase,
		updatedAt: new Date().toISOString(),
		...(childPid ? { childPid } : task.checkpoint?.childPid ? { childPid: task.checkpoint.childPid } : {}),
	};
	const nextTask = { ...task, checkpoint };
	const nextTasks = persistSingleTaskUpdate(manifest, updateTask(tasks, nextTask), nextTask);
	try {
		upsertCrewAgent(manifest, recordFromTask(manifest, nextTask, "child-process"));
	} catch (err) {
		logInternalError("checkpointTask", err);
	}
	return { task: nextTask, tasks: nextTasks };
}
