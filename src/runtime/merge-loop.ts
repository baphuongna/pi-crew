/**
 * Merge of settled dispatch units into the run state for the team-run
 * scheduler loop.
 *
 * Extracted from team-runner.ts (2026-08, Phase 2.6 maintainability split —
 * CORE-4 extraction 5). Pure code motion: isRunTerminalPreserved +
 * mergeUnitResult moved verbatim, including the RT-12 / NEW-D1 / R15-2 /
 * CANCEL-1 comments.
 *
 * `isRunTerminalPreserved` lives here (not in finalize-run.ts) because it is
 * shared by mergeUnitResult, finalizeRun (finalize-run.ts imports it from
 * here) and the core loop in team-runner.ts (which imports it from here) —
 * keeping it here avoids a merge-loop ↔ finalize-run import cycle.
 */
import { flushPendingAtomicWrites } from "../state/atomic-write.ts";
import { withRunLock } from "../state/coordination/locks.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasksAsync, updateRunStatus } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { classifyFatalFsError } from "../utils/fs-errno.ts";
import { cancelNonTerminalTasks } from "./dispatch-batch.ts";
import { mergeTaskUpdatesPreservingTerminal } from "./merge-gate.ts";
import type { SchedulerContext, SchedulerDecision } from "./scheduler-context.ts";
import { mergeArtifacts } from "./team-runner-artifacts.ts";

/**
 * CORE-4 extraction 5: wait for one in-flight dispatch unit to settle and
 * merge its result into the run state.
 *
 * Awaits Promise.race on ctx.pendingUnits; the first settled unit is merged
 * into ctx.manifest/tasks under the run lock (flushPendingAtomicWrites +
 * loadRunManifestById + mergeTaskUpdatesPreservingTerminal + save). The settled
 * unit is then deleted from ctx.pendingUnits, and the merge outcome (taskIds
 * + result object) is recorded on ctx.settledMerge for the post-merge inline
 * logic (cancel-during-exec check + batch summary).
 *
 * Returns null to continue to the phase/budget check. A `{ kind: "return" }`
 * decision is reserved for future run-complete/failure detection during merge.
 *
 * Reads ctx.pendingUnits/manifest/tasks. Mutates ctx.pendingUnits (delete),
 * ctx.manifest/tasks, ctx.settledMerge.
 *
 * @param ctx  The scheduler context.
 */
/** R15-2/R15-1: run statuses that must never be overwritten by an in-memory
 * derived status (mergeUnitResult force-"running", finalizeRun "completed").
 * "blocked" is deliberately EXCLUDED — a blocked run can be unblocked and the
 * finalize chain may legitimately derive blocked from in-memory state. */
export function isRunTerminalPreserved(status: TeamRunManifest["status"]): boolean {
	return status === "cancelled" || status === "failed" || status === "completed";
}

export async function mergeUnitResult(ctx: SchedulerContext): Promise<SchedulerDecision | null> {
	// RT-12: race on pre-created wrapper promises (created once at dispatch
	// time) instead of rebuilding a wrapper-promise array with new async
	// closures every iteration. This reduces allocation from O(C×T) wrapper
	// promises to O(C) total (one per unit, created once at dispatch).
	const settled = await Promise.race([...ctx.pendingUnits.values()].map((u) => u.wrapped));
	const completedUnit = ctx.pendingUnits.get(settled.unitKey)!;
	ctx.pendingUnits.delete(settled.unitKey);

	// Build the single result to merge. On rejection, synthesize a failed
	// result so the run continues (mirrors the old validResults guard).
	// bug-026 sub-issue B: a rejected unit means runTeamTask itself threw —
	// typically an atomicWriteFile/persistSingleTaskUpdate ENOSPC mid-run.
	// Classify the errno and stamp failureCause on the synthesized failed
	// tasks so the operator sees "failed (disk full)", not a generic write
	// error string.
	const thrownFailureCause = settled.result ? undefined : classifyFatalFsError(settled.error);
	const resultToMerge: { manifest: TeamRunManifest; tasks: TeamTaskState[] } = settled.result ?? {
		manifest: ctx.manifest,
		tasks: cancelNonTerminalTasks(ctx.tasks, "failed", settled.error!.message, (t) => completedUnit.taskIds.includes(t.id)).map((t) =>
			thrownFailureCause && t.status === "failed" ? { ...t, failureCause: thrownFailureCause } : t,
		),
	};
	const validResults = [resultToMerge];
	// Reconstruct manifest from the last worker's snapshot. The .artifacts field
	// is re-merged from both the team-runner's in-memory state and all workers'
	// snapshots, so artifact writes by task-runner (which individually save manifest
	// after writing artifacts) are safely persisted. The in-memory manifest is only
	// used for the next batch iteration's orchestration — actual persistence is safe.
	// Use updateRunStatus to recompute manifest status from merged tasks rather than
	// relying on the last result's manifest (which is arbitrary due to mapConcurrent
	// returning results in arbitrary order).
	// Use the in-memory manifest as base (not the last-completing worker's snapshot).
	// Recompute status from merged tasks so the manifest reflects actual task state,
	// not the arbitrary order in which mapConcurrent returned results.
	// Read committed manifest from disk inside the lock so artifact merge is based
	// on committed state, not in-memory state that may differ from disk.
	const mergeResult = await withRunLock(ctx.manifest, async () => {
		// NEW-D1: flush any pending coalesced atomic writes before reading from
		// disk. Without this, a worker's async manifest save (coalesced by
		// atomic-write) may not be committed yet, causing a lost-update on the
		// merge read. flushPendingAtomicWrites forces all queued writes to disk.
		flushPendingAtomicWrites();
		const disk = loadRunManifestById(ctx.manifest.cwd, ctx.manifest.runId);
		const diskManifest = disk?.manifest ?? ctx.manifest;
		const diskArtifacts = diskManifest.artifacts;
		const reconciledArtifacts = mergeArtifacts([...diskArtifacts, ...validResults.map((item) => item.manifest.artifacts)].flat());
		// R15-2: only force "running" when the disk manifest is NON-terminal
		// (queued/planning/running/blocked). If the disk status is already terminal
		// (cancelled/failed/completed — an external cancel or reconciler write
		// landing during the batch), PRESERVE that terminal status: forcing
		// "running" would legally erase it (contracts.ts allows cancelled/failed/
		// completed → running) and the loop would never observe the disk-terminal
		// (CANCEL-1/CANCEL-2 only catch worker-reported cancel or signal abort).
		const mergedBase = { ...diskManifest, artifacts: reconciledArtifacts };
		const resultManifest = isRunTerminalPreserved(diskManifest.status)
			? mergedBase
			: updateRunStatus(mergedBase, "running", "Merged task updates from parallel batch.");
		// CANCEL-1: use the freshly-loaded disk tasks as the merge base instead
		// of the in-memory `tasks` closure variable. The in-memory tasks reflect
		// only team-runner's view; an external cancel (handleCancel, background
		// race with SIGTERM arriving after cancel wrote but before merge ran)
		// writes 'cancelled' to disk.tasks — using disk.tasks as base preserves
		// that cancellation through the merge instead of overwriting it with the
		// stale in-memory view. disk was loaded inside this lock, so it reflects
		// the freshest committed state.
		const resultTasks = mergeTaskUpdatesPreservingTerminal(disk?.tasks ?? ctx.tasks, validResults);
		await saveRunManifestAsync(resultManifest);
		await saveRunTasksAsync(resultManifest, resultTasks);
		return { resultManifest, resultTasks };
	});
	ctx.manifest = mergeResult.resultManifest;
	ctx.tasks = mergeResult.resultTasks;
	ctx.settledMerge = { taskIds: completedUnit.taskIds, result: resultToMerge };
	return null;
}

/** @internal 1.9(b) test export — exercise mergeUnitResult directly. */
export const __test__mergeUnitResult = mergeUnitResult;
