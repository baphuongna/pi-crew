/**
 * coalesce-tasks.ts — micro-task coalescing for scheduler batching (M6).
 *
 * Implements the workflow-level `coalesceMicroTasks` opt-in (plan §11
 * decision #7): default = false; when true, multiple ready tasks sharing
 * `role` and `cwd` are grouped into a single "coalesced task group" so the
 * scheduler dispatches ONE worker call instead of N. Trades individual task
 * observability for fewer cold-starts when many small tasks of the same kind
 * are queued simultaneously.
 *
 * Safety guards (per plan §5 M6):
 *   - Only groups tasks that share role + cwd (so the grouped worker can use
 *     a single worker prompt without per-task permission prompts).
 *   - Tasks that declare a non-false `output` are NEVER coalesced with
 *     another task that has the same write path (write-write conflict).
 *   - When the flag is off or the list is empty, returns the input list
 *     unchanged (no-op for production; zero overhead).
 *
 * Real-dispatch (v0.9.17+ follow-up, see m6-real-dispatch-design.md):
 *   - MVP only coalesces READ_ONLY roles (permissionForRole === "read_only").
 *     This eliminates write-path conflicts, worktree concerns, and mutation
 *     guards. Use case: parallel-research with 4 explorers → 1 worker.
 *   - MVP rejects coalescing when any step has: worktree: true, preStepScript,
 *     verify: true, or non-false output. These are per-step concerns that
 *     don't compose in a single multi-task worker.
 *   - maxGroupSize cap (default 5) prevents context-budget overflow when
 *     grouping many micro-tasks into one worker prompt.
 */

import { permissionForRole } from "./role-permission.ts";
import type { TeamTaskState } from "../state/types.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";

/** Default cap on group size to prevent context-budget overflow. */
export const DEFAULT_MAX_GROUP_SIZE = 5;

/** Default cap on combined estimated prompt size (bytes). Conservative
 *  estimate — real prompt includes the stable prefix (~5KB) plus per-task
 *  sections. 100KB matches the budget heuristic in the design doc
 *  (m6-real-dispatch-design.md §R4). */
export const DEFAULT_MAX_GROUP_BYTES = 100_000;

export interface CoalescedGroup {
	/** Stable id derived from the group membership; deterministic for tests. */
	id: string;
	role: string;
	cwd: string;
	/** Tasks to be coalesced into one worker invocation, in input order. */
	tasks: TeamTaskState[];
}

/**
 * Group ready tasks by (role, cwd) while respecting write-path safety.
 *
 * Returns an array of `CoalescedGroup`. Each group contains tasks that:
 *   - share the same role and cwd
 *   - have NO write-path conflict with any other task in the group
 *
 * Singletons (groups with one task) are preserved — the caller can decide
 * whether to dispatch them as-is or skip the coalesce entirely.
 *
 * If `enabled` is false, returns `[]` (signal to the caller to skip
 * coalescing — use the original list).
 */
export function planCoalescedGroups(
	readyTaskIds: string[],
	tasks: TeamTaskState[],
	workflow: WorkflowConfig,
	enabled: boolean,
	maxGroupSize: number = DEFAULT_MAX_GROUP_SIZE,
	maxGroupBytes: number = DEFAULT_MAX_GROUP_BYTES,
): CoalescedGroup[] {
	if (!enabled || readyTaskIds.length === 0) return [];
	const taskById = new Map<string, TeamTaskState>(tasks.map((task) => [task.id, task]));
	const stepById = new Map<string, WorkflowStep>(workflow.steps.map((step) => [step.id, step]));

	// Bucket: key = `${role}\0${cwd}` → task list preserving input order
	const buckets = new Map<string, TeamTaskState[]>();
	for (const taskId of readyTaskIds) {
		const task = taskById.get(taskId);
		if (!task || !task.stepId) continue;
		const step = stepById.get(task.stepId);
		if (!step) continue;

		// MVP constraint (real-dispatch safety): only coalesce READ_ONLY roles.
		// Writing roles (executor, writer, implementer) require per-step hooks
		// (worktree, preStepScript, verify) that don't compose in one worker.
		if (permissionForRole(task.role) !== "read_only") continue;

		// MVP constraint: reject if step has any per-step concern that
		// doesn't compose in a multi-task worker. These flags set up side
		// effects per-task that can't be combined.
		if (step.worktree) continue;
		if (step.preStepScript) continue;
		if (step.verify) continue;
		if (step.output !== undefined && step.output !== false && step.output !== "") continue;

		const key = `${task.role}\0${task.cwd}`;
		const list = buckets.get(key);
		if (list) list.push(task);
		else buckets.set(key, [task]);
	}

	// Within each bucket, split further by write-path safety (groups of tasks
	// that all have distinct write outputs), cap at maxGroupSize, AND cap
	// combined estimated prompt size at maxGroupBytes. This addresses
	// design-doc risk R4 (context-budget overflow): a worker handling N
	// micro-tasks with large dependency contexts could exceed the model's
	// context window. The byte cap is a heuristic, not a guarantee — the
	// actual prompt includes rendered workspace trees and skill blocks too.
	const groups: CoalescedGroup[] = [];
	for (const [key, bucketTasks] of buckets) {
		const [role, cwd] = key.split("\0");
		const subgroups = splitByWriteSafety(bucketTasks, stepById);
		for (const subgroup of subgroups) {
			// Chunk by BOTH count and bytes. Greedy: keep adding tasks while
			// adding the next one wouldn't exceed either limit. When a
			// single task exceeds the byte limit by itself (rare), include
			// it anyway as a singleton group so it's at least eligible.
			let chunkStart = 0;
			let chunkBytes = 0;
			for (let i = 0; i < subgroup.length; i += 1) {
				const task = subgroup[i]!;
				const step = task.stepId ? stepById.get(task.stepId) : undefined;
				const taskSize = estimateTaskPromptSize(task, step);
				const wouldBeCount = i - chunkStart + 1;
				const wouldBeBytes = chunkBytes + taskSize;
				const overCount = wouldBeCount > maxGroupSize;
				const overBytes = i > chunkStart && wouldBeBytes > maxGroupBytes;
				if ((overCount || overBytes) && i > chunkStart) {
					// Flush current chunk as a group.
					const slice = subgroup.slice(chunkStart, i);
					groups.push(buildGroup(slice, role, cwd));
					chunkStart = i;
					chunkBytes = taskSize;
				} else {
					chunkBytes += taskSize;
				}
			}
			// Flush final chunk.
			if (chunkStart < subgroup.length) {
				const slice = subgroup.slice(chunkStart);
				groups.push(buildGroup(slice, role, cwd));
			}
		}
	}
	return groups;
}

function buildGroup(tasks: TeamTaskState[], role: string, cwd: string): CoalescedGroup {
	return {
		id: tasks.length === 1 ? tasks[0]!.id : tasks.map((t) => t.id).join("+"),
		role,
		cwd,
		tasks,
	};
}

/**
 * Estimate the prompt-bytes contribution of a single task within a
 * coalesced group. The actual prompt is much larger (workspace tree,
 * skill block, dependency context) but the task-specific contribution
 * is roughly proportional to the step's task text + a fixed per-task
 * overhead for delimiters and headers.
 */
function estimateTaskPromptSize(task: TeamTaskState, step: WorkflowStep | undefined): number {
	const taskText = step?.task?.length ?? 0;
	const packetEstimate = 500; // task packet / scope / verification estimate
	const delimiterOverhead = 200; // `<<<TASK_RESULT:id>>>` + section header
	return taskText + packetEstimate + delimiterOverhead;
}

/**
 * Split a bucket of tasks into write-safe subgroups: a subgroup may include
 * tasks only if no two of them have the same `step.output`.
 *
 * Greedy: first task always goes to current group; subsequent tasks join the
 * current group only if they don't conflict with any already-in-group member.
 * Otherwise, they start (and extend) the next subgroup.
 */
function splitByWriteSafety(bucketTasks: TeamTaskState[], stepById: Map<string, WorkflowStep>): TeamTaskState[][] {
	const result: TeamTaskState[][] = [];
	for (const task of bucketTasks) {
		const step = task.stepId ? stepById.get(task.stepId) : undefined;
		const writePath = step?.output;
		let placed = false;
		for (const group of result) {
			let conflict = false;
			for (const other of group) {
				const otherStep = other.stepId ? stepById.get(other.stepId) : undefined;
				if (typeof writePath === "string" && typeof otherStep?.output === "string" && writePath === otherStep.output) {
					conflict = true;
					break;
				}
			}
			if (!conflict) {
				group.push(task);
				placed = true;
				break;
			}
		}
		if (!placed) result.push([task]);
	}
	return result;
}

/**
 * Flatten a list of `CoalescedGroup` back into a flat task-id list (one entry
 * per group). For a group of N tasks, this returns N task IDs in order. When
 * M6 is enabled upstream, the caller can use this to count "effective ready
 * units" (groups vs raw tasks).
 */
export function flattenGroupIds(groups: CoalescedGroup[]): string[] {
	return groups.flatMap((group) => group.tasks.map((task) => task.id));
}

/**
 * Find the coalesced group that contains the given task ID.
 * Returns undefined if the task is not in any group (e.g., it was excluded
 * by MVP constraints or wasn't part of the coalesced set).
 *
 * Used by the team-runner dispatch loop to look up a task's group metadata
 * (role, cwd, group ID, sibling task IDs) when iterating the flat ready
 * list and discovering which tasks should be batched together.
 */
export function findGroupContainingTask(groups: CoalescedGroup[], taskId: string): CoalescedGroup | undefined {
	for (const group of groups) {
		if (group.tasks.some((task) => task.id === taskId)) return group;
	}
	return undefined;
}

/**
 * Expand a list of task IDs into a list of dispatch units, where each unit
 * is either a single task (for singletons / non-coalescable tasks) or a
 * CoalescedGroup (for multi-task batches). The returned units can be fed
 * directly into mapConcurrent.
 *
 * Tasks not present in any coalesced group are returned as singleton units.
 */
export type DispatchUnit = { kind: "singleton"; taskId: string } | { kind: "group"; group: CoalescedGroup };

export function buildDispatchUnits(readyTaskIds: string[], coalescedGroups: CoalescedGroup[]): DispatchUnit[] {
	const groupByTaskId = new Map<string, CoalescedGroup>();
	for (const group of coalescedGroups) {
		if (group.tasks.length < 2) continue; // singletons handled separately
		for (const task of group.tasks) {
			groupByTaskId.set(task.id, group);
		}
	}
	const visited = new Set<string>();
	const units: DispatchUnit[] = [];
	// First pass: emit groups (one unit per group, in input order)
	for (const taskId of readyTaskIds) {
		const group = groupByTaskId.get(taskId);
		if (!group) continue;
		if (visited.has(group.id)) continue;
		visited.add(group.id);
		for (const t of group.tasks) visited.add(t.id);
		units.push({ kind: "group", group });
	}
	// Second pass: emit singletons (and tasks whose group is size 1)
	for (const taskId of readyTaskIds) {
		if (visited.has(taskId)) continue;
		units.push({ kind: "singleton", taskId });
	}
	return units;
}
