import * as fs from "node:fs";
import { loadConfig } from "../../config/config.ts";
import { flushPendingAtomicWrites } from "../../state/atomic-write.ts";
import { isTerminalTaskStatus } from "../../state/contracts.ts";
import { withRunLockSync } from "../../state/coordination/locks.ts";
import { loadRunManifestById, saveRunTasksCoalesced } from "../../state/stores/state-store.ts";
import type { TaskCheckpointState, TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { recordFromTask, upsertCrewAgent } from "../crew-agent-records.ts";
import type { ProcIdentity } from "../process/reap-group.ts";

export function updateTask(tasks: TeamTaskState[], updated: TeamTaskState): TeamTaskState[] {
	return tasks.map((task) => (task.id === updated.id ? updated : task));
}

/**
 * R6-1 + R6-4 (DR-03, 2026-10-16): field-level merge of the INCOMING task
 * onto the DISK task at the persistSingleTaskUpdate merge point. BUG-028
 * made DISK authoritative for SIBLING tasks; this extends disk authority to
 * two fields of THIS task where the incoming runner snapshot is provably
 * stale relative to another writer:
 *
 * R6-1 terminal-preserve — when the incoming status is TERMINAL and disk
 * already holds a DIFFERENT terminal status (e.g. `cancelled` written by
 * crash-recovery / stale-reconciler / external cancel while a detached
 * worker was still settling), the disk terminal status + error are
 * preserved (mirror of the coalesced cancelled branch,
 * run-coalesced-task-group.ts:367, and the R13-S1 terminal-preserve class
 * in team-tool api). Without this, a late worker settle overwrote the
 * leader's cancellation with `completed` and post-execution then emitted
 * task.completed after crew.run.orphan_cancelled — cancelled run holding a
 * completed task, event-log vs tasks.json divergence. Incoming fields other
 * than status/error (result artifacts, finishedAt, usage, …) are still taken
 * from the incoming record — the worker DID run; only the terminal verdict
 * is not ours to overwrite. Non-terminal disk status → incoming wins as
 * before (normal settle path); incoming non-terminal → untouched (the
 * heartbeat resurrect window is guarded upstream by live-executor's
 * isCurrent disk-status check, R13-S1 style).
 *
 * R6-4 allocation merge — delegate budget accounting (crew-broker writes
 * task.allocation.tokensSpent under the run lock: reserve = disk + reserved
 * at admission, roll-up = − reserved + actual on the then-current base at
 * completion) was a lost update vs the runner's ~1s heartbeat whole-record
 * replace which carries the dispatch-time (pre-reserve) copy. Rule chosen:
 * `tokensSpent = max(disk, incoming)`. Verification against the broker
 * arithmetic (read before choosing — crew-broker.ts reserve ~:1575-1602,
 * roll-up ~:1690-1708, P2-8c refund ~:1745): every broker write is computed
 * off the then-current DISK base; each roll-up subtracts exactly the amount
 * its own reserve previously added and adds back actual ∈ [0, reserved], so
 * disk(t) ≥ any runner snapshot for snapshots that predate their reserves'
 * roll-ups — and the runner NEVER writes allocation (zero writers in
 * task-runner/team-runner; its in-memory copy is dispatch-time lineage that
 * never saw a reserve). Hence max() degenerates to "disk wins" in every
 * broker-consistent interleaving, AND self-heals two disk-corruption shapes
 * verbatim-disk would not: (a) a pre-fix heartbeat that already clobbered a
 * reserve down, (b) the P2-8c refund over-subtracting a reserve that never
 * landed. The one theoretical max() hazard — a runner snapshot taken BETWEEN
 * a reserve and its roll-up, then rolled up with actual < reserved — cannot
 * occur today because no task-runner path reloads the in-memory task from
 * disk mid-execution. `tokensGranted` is admission-authoritative write-once
 * (broker passes it through verbatim) → disk wins verbatim. A heartbeat
 * snapshot that lacks `allocation` entirely (pre-admission copy) keeps the
 * disk allocation instead of deleting it — same lost-update class.
 */
function mergeTaskUpdateWithDisk(diskTasks: TeamTaskState[], incoming: TeamTaskState): TeamTaskState {
	const diskTask = diskTasks.find((t) => t.id === incoming.id);
	if (!diskTask) return incoming;

	let effective = incoming;
	// R6-1: incoming terminal vs disk DIFFERENT terminal → disk wins for the
	// terminal verdict (status + error).
	if (isTerminalTaskStatus(incoming.status) && isTerminalTaskStatus(diskTask.status) && diskTask.status !== incoming.status) {
		effective = { ...incoming, status: diskTask.status, error: diskTask.error };
	}

	// R6-4: field-wise allocation merge (see docblock above for the max()
	// derivation). Applies on every persist (heartbeat, checkpoint, terminal
	// settle) — all runner paths carry the same stale dispatch-time copy.
	const incomingAllocation = incoming.allocation;
	const diskAllocation = diskTask.allocation;
	if (diskAllocation && !incomingAllocation) {
		// Heartbeat snapshot predates admission — keep the broker's accounting
		// instead of deleting it via whole-record replace.
		effective = { ...effective, allocation: diskAllocation };
	} else if (diskAllocation && incomingAllocation) {
		effective = {
			...effective,
			allocation: {
				tokensGranted: diskAllocation.tokensGranted,
				tokensSpent: Math.max(diskAllocation.tokensSpent ?? 0, incomingAllocation.tokensSpent ?? 0),
			},
		};
	}

	// R6-5 WAITING-PRESERVE (FINDING D root fix, live probes 10/11/12,
	// 2026-11-01): a runner-side snapshot (child-executor persistHeartbeat's
	// ~1s whole-record persist is the caught clobberer — stack pinned via
	// saveRunTasksCoalesced instrumentation, probe12 run
	// team_20261101040510) carries a dispatch-time task object that NEVER
	// learned the broker parked the task (the park is written disk-side by the
	// broker's wait.request handler under the run lock; the runner's in-memory
	// copy keeps status "running", no `waiting`). Without this guard the first
	// post-park heartbeat persist ERASED the park (tasks.json → running,
	// waiting:null), which broke respond.force's live-park gate ("no-park"
	// while the worker was verifiably parked — probe10) — the FINDING A
	// residual class, now closed at the merge chokepoint every
	// persistSingleTaskUpdate caller funnels through.
	//
	// Rule (mirror of R6-1's "the verdict is not ours to overwrite"): when
	// DISK holds a live park (`waiting` payload, non-terminal status) and the
	// incoming snapshot does not itself carry park-awareness
	// (waiting === undefined) and is NON-terminal, the disk park survives —
	// the heartbeat was never authoritative over an ask park. Legitimate
	// clears do NOT pass through here: respond.ts requeueWaitingTask and the
	// broker's wait-resolve victim flip write FULL task arrays directly via
	// saveRunTasks under the run lock (verified 2026-11-01), and terminal
	// settles (post-execution) are let through by the non-terminal condition.
	if (
		diskTask.status === "waiting" &&
		diskTask.waiting !== undefined &&
		incoming.waiting === undefined &&
		!isTerminalTaskStatus(effective.status)
	) {
		effective = { ...effective, status: "waiting" as const, waiting: diskTask.waiting };
	}
	return effective;
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
 * default buffered write is fine and matches prior behavior. With the
 * opt-in `persistence.skipTasksFsync` flag (default off), non-terminal
 * checkpoints stay in the 50ms coalesce window but drop ONLY the fsync
 * (durability "best-effort") — tasks.json is reconstructible from the
 * fsync'd event log, so a crash loses at most the un-flushed tail.
 *
 * R6-1/R6-4 (DR-03, 2026-10-16): the per-task merge is NOT an unconditional
 * replace-by-id anymore — mergeTaskUpdateWithDisk (above) preserves a disk
 * terminal status (vs a different incoming terminal) and merges
 * `allocation.tokensSpent` with max(disk, incoming). The mtime CAS retry
 * loop, the run lock, and the BUG-028 always-load-disk policy are unchanged.
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
	// H5 (2026-08-10): lowered from 100 → 10. Each retry does a scoped
	// flushPendingAtomicWrites(tasksPath) + loadRunManifestById (stat + parse;
	// the manifest half is typically served from the manifest cache after the
	// Task 12 reuse) + statSync, ~5ms each. Every attempt now loads from disk
	// (BUG-028); retries only fire under real contention from best-effort
	// writers that don't hold the run lock (async-notifier, crash-recovery).
	// If 10 retries cannot converge, the system is in a pathological state
	// where 100 would not help either — the explicit error below surfaces it
	// instead of blocking the event loop for 500ms.
	const MAX_CAS_ATTEMPTS = 10;

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
				// PERF (2026-08-24): scoped flush — only force OUR tasks.json pending
				// write to land. The old argument-less call drained every pending
				// coalesced write process-wide (other runs, agents.json 250ms window)
				// on every persist (~30x/s), defeating coalescing globally. The F4
				// invariant only needs tasks.json durable before this read.
				flushPendingAtomicWrites(manifest.tasksPath);
				// PERF (2026-08-24): capture the CAS baseline INSIDE the lock, after
				// the flush, immediately before the load. The old pre-lock stat almost
				// always disagreed with the in-lock stat under 10 parallel writers
				// (mtime moved between function entry and lock acquisition), forcing
				// 2+ full flush+load cycles per call. In-lock capture makes retry mean
				// exactly: "a cross-process writer committed between our load and our
				// pre-write stat" — the only race the CAS can actually catch.
				let baseMtime: number;
				try {
					baseMtime = fs.statSync(manifest.tasksPath).mtimeMs;
				} catch {
					baseMtime = 0;
				}
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
				// detects writers between the in-lock baseline stat (captured
				// after the flush, immediately before the load) and the pre-write
				// stat, i.e. staleness acquired AFTER that baseline — not fallback
				// staleness that predates it. Loading disk here makes sibling
				// state authoritative (matching mergeUnitResult / bug-027 policy)
				// while `updated` still wins for THIS task via updateTask — EXCEPT
				// where R6-1/R6-4 (DR-03) preserve disk authority for the terminal
				// verdict and delegate budget accounting (mergeTaskUpdateWithDisk).
				// fallbackTasks remains the fallback when the run state is absent
				// (fresh run, manifest not yet on disk).
				const latest = loadRunManifestById(manifest.cwd, manifest.runId)?.tasks ?? fallbackTasks;
				merged = updateTask(latest, mergeTaskUpdateWithDisk(latest, taskWithCheckpoint));

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
					// Another writer committed between our in-lock baseline and this
					// stat — retry; the next iteration recaptures the baseline fresh.
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
				// PERF round 2, Task 3 (opt-in, default off): for NON-terminal
				// checkpoints — and ONLY when persistence.skipTasksFsync is true —
				// KEEP the 50ms coalesce window (the RMW grouping benefit) and drop
				// ONLY durability: the coalesced entry stores "best-effort" and the
				// flush forwards it to atomicWriteFile (no data/parent-dir fsync).
				// tasks.json is reconstructible from the fsync'd event log, so the
				// crash tail is at most the in-flight checkpoint. Terminal
				// transitions (skipCoalesce=true) always stay full-durability — the
				// flag never touches that path.
				const skipTasksFsync = !skipCoalesce && loadConfig().config.persistence?.skipTasksFsync === true;
				if (skipTasksFsync) {
					saveRunTasksCoalesced(manifest, merged, false, "best-effort");
				} else {
					saveRunTasksCoalesced(manifest, merged, skipCoalesce);
				}
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
	identity?: ProcIdentity,
): { task: TeamTaskState; tasks: TeamTaskState[] } {
	// Wave 11a review (MAJOR #4): CARRY the spawn-time identity over exactly like
	// `childPid`. This function is also called on phase transitions that know
	// nothing about the process ("child-stdout-final", "artifact-written"); those
	// calls used to REBUILD the checkpoint without the three identity fields and
	// silently erase them, so a later reaper lost the pid proof F3 exists to
	// provide. Only a DEFINED argument overrides the carried value, so a caller
	// that passes nothing keeps the pre-wave record shape byte-for-byte.
	const previous = task.checkpoint;
	const carriedPid = childPid ?? previous?.childPid;
	// MINOR #6 (review): the identity belongs to ONE pid. Carrying it over a
	// CHANGE of `childPid` (retry / re-spawn) would pair a fresh pid with the old
	// incarnation's starttime — the reaper's reuse-proof field would then be a
	// lie that REFUSES the real child (or, worse, matches an unrelated pid). So
	// carry identity only while the child stays the same one.
	const sameChild = childPid === undefined || childPid === previous?.childPid;
	const carriedPgid = identity?.pgid ?? (sameChild ? previous?.childPgid : undefined);
	const carriedStartTime = identity?.starttime ?? (sameChild ? previous?.childStartTime : undefined);
	const carriedUid = identity?.uid ?? (sameChild ? previous?.childUid : undefined);
	const checkpoint: TaskCheckpointState = {
		phase,
		updatedAt: new Date().toISOString(),
		...(carriedPid !== undefined ? { childPid: carriedPid } : {}),
		// Wave 11a (F3): persist the spawn-time identity so a later reaper can
		// PROVE the pid (starttime) instead of guessing. Only defined fields are
		// spread, so a caller that passes nothing keeps the pre-wave record shape
		// and old records/state files keep loading unchanged.
		...(carriedPgid !== undefined ? { childPgid: carriedPgid } : {}),
		...(carriedStartTime !== undefined ? { childStartTime: carriedStartTime } : {}),
		...(carriedUid !== undefined ? { childUid: carriedUid } : {}),
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
