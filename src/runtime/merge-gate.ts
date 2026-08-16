/**
 * Monotonic merge gate for parallel task updates.
 *
 * Extracted from team-runner.ts (2026-08-10, improvement-plan Tier 2
 * "team-runner split" — self-contained portion). The merge gate protects
 * terminal task states from being regressed by stale parallel worker
 * snapshots: every terminal->non-terminal transition is rejected, plus a
 * small set of bespoke policies (P2 completed integrity, P3
 * waiting->running stale-snapshot regression) that are stricter than the
 * lifecycle table on the parallel-merge path.
 *
 * Exhaustively tested in test/unit/team-runner-should-merge-table.test.ts.
 */
import { TEAM_TASK_STATUSES, TEAM_TERMINAL_TASK_STATUSES, type TeamTaskStatus } from "../state/contracts.ts";
import type { TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { refreshTaskGraphQueues } from "./scheduling/task-graph-scheduler.ts";

export function isNonTerminalTaskStatus(status: TeamTaskState["status"]): boolean {
	return status === "queued" || status === "running" || status === "waiting";
}

export function safeFinishedAt(task: TeamTaskState): number {
	if (!task.finishedAt) return -Infinity;
	const ms = new Date(task.finishedAt).getTime();
	return Number.isNaN(ms) ? Infinity : ms;
}

/**
 * Returns true when the current task has a malformed finishedAt (NaN/Infinity)
 * and the updated task has a valid finite finishedAt. Malformed finishedAt
 * should be replaced rather than persisting corruption.
 */
export function isMalformedFinishedAtReplacement(currentTime: number, updatedTime: number): boolean {
	return !Number.isFinite(currentTime) && Number.isFinite(updatedTime);
}

/**
 * RT-16: status-level gate for shouldMergeTaskUpdate. Returns the stable
 * "from->to" key used by REJECTED_STATUS_MERGE_TRANSITIONS.
 */
export function statusMergeKey(from: TeamTaskStatus, to: TeamTaskStatus): string {
	return `${from}->${to}`;
}

/**
 * RT-16 — derived merge-gate transition table.
 *
 * The set of old->new status pairs that shouldMergeTaskUpdate must REJECT based
 * solely on the status transition (before any field-level comparison). It
 * replaces the former 13 hand-written status guards that hand-duplicated the
 * lifecycle table. Built once from the single source-of-truth table
 * (TEAM_TASK_STATUSES + TEAM_TERMINAL_TASK_STATUSES — the terminal half of
 * TEAM_TASK_STATUS_TRANSITIONS) plus two merge-specific policies that are
 * STRICTER than the lifecycle table on the parallel-merge path:
 *
 *  P1 Terminal preservation — every terminal->non-terminal pair is rejected.
 *    The lifecycle table permits retries (e.g. completed->queued), but a stale
 *    worker snapshot must never resurrect a settled task.
 *  P2 Completed integrity — five terminal->terminal flips that touch the
 *    "completed" success terminal are rejected: completed->failed,
 *    completed->needs_attention, failed->completed, cancelled->completed,
 *    needs_attention->completed. (completed may still move to
 *    cancelled/skipped; that is intentionally allowed, so these are NOT simply
 *    "every illegal terminal->terminal flip".)
 *  P3 waiting->running regression — the single stale-snapshot case.
 *
 * The decision for every old->new pair is byte-for-byte identical to the former
 * 7 status guards (verified exhaustively in
 * test/unit/team-runner-should-merge-table.test.ts).
 */
export const REJECTED_STATUS_MERGE_TRANSITIONS: ReadonlySet<string> = (() => {
	const rejected = new Set<string>();
	// P1 — terminal preservation: reject every terminal->non-terminal pair.
	for (const from of TEAM_TASK_STATUSES) {
		if (!TEAM_TERMINAL_TASK_STATUSES.has(from)) continue;
		for (const to of TEAM_TASK_STATUSES) {
			if (!TEAM_TERMINAL_TASK_STATUSES.has(to)) rejected.add(statusMergeKey(from, to));
		}
	}
	// P3 — waiting->running stale-snapshot regression.
	rejected.add(statusMergeKey("waiting", "running"));
	// P2 — completed integrity flips (bespoke terminal->terminal policy).
	const completedIntegrityFlips: ReadonlyArray<[TeamTaskStatus, TeamTaskStatus]> = [
		["completed", "failed"],
		["completed", "needs_attention"],
		["failed", "completed"],
		["cancelled", "completed"],
		["needs_attention", "completed"],
	];
	for (const [from, to] of completedIntegrityFlips) rejected.add(statusMergeKey(from, to));
	return rejected;
})();

export function shouldMergeTaskUpdate(current: TeamTaskState, updated: TeamTaskState): boolean {
	// RT-16: status-level gate — reject stale/dangerous transitions via the
	// derived transition table (REJECTED_STATUS_MERGE_TRANSITIONS) instead of
	// hand-written guards. Parallel workers receive the same input snapshot; a
	// later result may still carry stale copies. The table encodes three
	// merge-specific policies stricter than the lifecycle table: terminal
	// preservation (no terminal->non-terminal resurrection), completed integrity
	// (no flipping the "completed" success terminal to/from failed or
	// needs_attention), and the waiting->running stale-snapshot regression.
	if (REJECTED_STATUS_MERGE_TRANSITIONS.has(statusMergeKey(current.status, updated.status))) return false;
	// Guard: when current is "running" but has resultArtifact (another worker already
	// completed it), a stale updated with status="running" and no resultArtifact
	// must not overwrite the actual completed state.
	if (current.status === updated.status && updated.status === "running" && current.resultArtifact && !updated.resultArtifact)
		return false;
	// Guard: when current is "completed" and has resultArtifact but updated is also
	// "completed" without resultArtifact, block the stale update from overwriting
	// a task that successfully produced output.
	if (current.status === updated.status && current.status === "completed" && current.resultArtifact && !updated.resultArtifact)
		return false;
	// Prevent a stale completed task from overwriting a fresher one.
	// Restructure to handle undefined current.finishedAt as a special case:
	// - undefined current + valid updated: allow the update
	// - valid current + undefined updated: block the update (don't lose completion time)
	// - both undefined: finishedAt guard does not apply, fall through to heartbeat check
	// - both valid: compare timestamps as before
	if (current.finishedAt !== undefined && updated.finishedAt !== undefined) {
		const currentTime = safeFinishedAt(current);
		const updatedTime = safeFinishedAt(updated);
		// Malformed finishedAt (NaN) is treated as Infinity — invalid state should be
		// replaced rather than persisting corruption. Log warning for visibility.
		if (!Number.isFinite(currentTime)) {
			logInternalError(
				"merge-gate",
				new Error(`Task ${current.id} has malformed finishedAt: ${current.finishedAt}`),
				undefined,
				"warn",
			);
		}
		if (isMalformedFinishedAtReplacement(currentTime, updatedTime)) {
			return true;
		}
		if (updatedTime < currentTime) return false;
	}
	// Block if updated is trying to establish a terminal status without a finishedAt
	// timestamp. Heartbeat-only updates (status='running', no finishedAt) are
	// allowed if heartbeat has changed (checked separately in hasMeaningfulUpdate).
	if (!updated.finishedAt && !isNonTerminalTaskStatus(updated.status)) return false;
	// Explicitly enumerate all fields that constitute a meaningful update so that
	// adding a new important field requires updating this list (rather than silently
	// losing data if a field is forgotten in the boolean OR chain below).
	const hasMeaningfulUpdate =
		updated.status !== current.status ||
		updated.finishedAt !== current.finishedAt ||
		updated.startedAt !== current.startedAt ||
		Boolean(updated.resultArtifact) !== Boolean(current.resultArtifact) ||
		(Boolean(updated.resultArtifact) && updated.resultArtifact !== current.resultArtifact) ||
		Boolean(updated.error) ||
		Boolean(updated.modelAttempts?.length) ||
		Boolean(updated.usage) ||
		Boolean(updated.attempts?.length) ||
		updated.heartbeat?.lastSeenAt !== current.heartbeat?.lastSeenAt ||
		updated.jsonEvents !== current.jsonEvents ||
		updated.agentProgress?.lastActivityAt !== current.agentProgress?.lastActivityAt;
	return hasMeaningfulUpdate;
}
/** Exposed for the exhaustive status-merge table test (RT-16). */
export const __test__shouldMergeTaskUpdate = shouldMergeTaskUpdate;

// H4 fix: rename to descriptive name. Kept __test__ as alias for backward
// compat test imports.
// FIX (perf P10): replace O(N×M) .find() + .map() inside nested loops with a
// single-pass Map-based merge. Build an index of `merged` once, then for each
// incoming updated task do O(1) lookup; the final pass reassembles `merged`
// preserving original order. For a 20-task run × 5-batch merger with
// ~10 updates per result, this reduces from O(50×20) = 1000 ops to O(120).
// Behavior is unchanged: skipped updates (shouldMergeTaskUpdate=false) still
// leave the existing task in place.
export function mergeTaskUpdatesPreservingTerminal(base: TeamTaskState[], results: Array<{ tasks: TeamTaskState[] }>): TeamTaskState[] {
	// Index current merged state by id for O(1) lookup during the merge pass.
	const indexById = new Map<string, TeamTaskState>();
	for (const task of base) indexById.set(task.id, task);

	let skipped = 0;
	for (const result of results) {
		for (const updated of result.tasks) {
			const current = indexById.get(updated.id);
			if (!current) continue;
			if (!shouldMergeTaskUpdate(current, updated)) {
				// Log skipped merges for visibility into rejected parallel updates.
				// In distributed systems with parallel workers, rejected merges may
				// indicate bugs (wrong status, timestamp corruption) if they accumulate.
				console.debug("[merge-gate] Skipping stale merge for task", updated.id, {
					currentStatus: current.status,
					updatedStatus: updated.status,
					currentFinishedAt: current.finishedAt,
					updatedFinishedAt: updated.finishedAt,
				});
				skipped += 1;
				continue;
			}
			indexById.set(updated.id, updated);
		}
	}
	// Reassemble in original `base` order so downstream snapshots stay stable.
	const merged = base.map((task) => indexById.get(task.id) ?? task);
	// `skipped` is intentional visibility — currently no caller reads it but
	// we'd rather leave the count available for future instrumentation than
	// remove the cumulative silent-rejection signal it provides.
	void skipped;
	return refreshTaskGraphQueues(merged);
}
/** @deprecated Use mergeTaskUpdatesPreservingTerminal. Kept for backward test import compat. */
export const __test__mergeTaskUpdates = mergeTaskUpdatesPreservingTerminal;
