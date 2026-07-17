import * as fs from "node:fs";
import { flushPendingAtomicWrites } from "../../state/atomic-write.ts";
import { withRunLockSync } from "../../state/locks.ts";
import { loadRunManifestById, saveRunTasksCoalesced } from "../../state/state-store.ts";
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
	const MAX_CAS_ATTEMPTS = 100;
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
				// FIX (perf): on the first attempt, reuse the caller-supplied
				// fallbackTasks directly instead of calling loadRunManifestById.
				// The caller already obtained the latest tasks via
				// loadRunManifestById and handed them in as fallbackTasks, so a
				// second load here is pure waste — it's another statSync pair
				// (manifest + tasks) plus a possible JSON.parse. The CAS check
				// below (currentMtime !== baseMtime) catches any concurrent
				// writer that committed between fallbackTasks capture and now;
				// when that fires we fall into the retry path which DOES call
				// loadRunManifestById to pull the fresh state from disk. So we
				// only pay the disk-read cost on actual contention, not on the
				// common single-writer happy path.
				let latest: TeamTaskState[];
				if (attempt === 0) {
					latest = fallbackTasks;
				} else {
					latest = loadRunManifestById(manifest.cwd, manifest.runId)?.tasks ?? fallbackTasks;
				}
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
