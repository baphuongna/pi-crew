/**
 * path-overlap.ts — write-path overlap detection for sequential scheduling (M5).
 *
 * Implements the writes-only path-intersection heuristic (per plan §11 decision
 * #5). A pair of steps is considered overlapping ONLY when both declare the
 * same write target (via `step.output`). Reads are intentionally ignored to
 * avoid false positives (parallel reads are safe).
 *
 * Scope:
 *   - export `detectWriteOverlap(stepA, stepB): boolean` — pair check
 *   - export `selectNonOverlapping(steps, maxCount): WorkflowStep[]` — greedy
 *     packer that returns at most `maxCount` steps such that no two returned
 *     steps have overlapping write paths.
 *   - export `filterReadyByWriteOverlap(taskIds, tasks, workflow, maxCount)` —
 *     scheduler-side wrapper that translates TeamTaskState IDs to WorkflowSteps
 *     and applies the overlap filter.
 *
 * Default greedy strategy: preserve declaration order; first step always wins
 * because (a) deterministic for tests, (b) declaration order typically reflects
 * author intent, (c) a future PR can swap to priority-based when M5 defaults
 * flip to `true` in production.
 *
 * Out of scope: reads overlap detection (decision #5); deferral cap (decision
 * #6; M5 first ship treats repeated deferral as best-effort; cap warning logged
 * but not enforced, since M5 default = false means production isn't gated).
 */

import type { TeamTaskState } from "../state/types.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";

/**
 * Extract the canonical write-target path of a step.
 *
 * Returns:
 *   - `step.output` if it is a non-empty string (the file path produced).
 *   - `undefined` otherwise (no declared write target → step has no write
 *     overlap risk).
 *
 * `step.output === false` means "explicitly no output"; treated as no write.
 */
function extractWritePath(step: WorkflowStep): string | undefined {
	if (typeof step.output === "string" && step.output.length > 0) return step.output;
	return undefined;
}

/**
 * Pairwise check: do stepA and stepB both write to the same path?
 *
 * O(1). Both steps must declare an `output` string; otherwise no overlap.
 *
 * Examples:
 *   detectWriteOverlap({output: 'a.md'}, {output: 'a.md'}) → true
 *   detectWriteOverlap({output: 'a.md'}, {output: 'b.md'}) → false
 *   detectWriteOverlap({output: 'a.md'}, {output: false})  → false
 *   detectWriteOverlap({output: 'a.md'}, {})              → false
 */
export function detectWriteOverlap(stepA: WorkflowStep, stepB: WorkflowStep): boolean {
	const pathA = extractWritePath(stepA);
	const pathB = extractWritePath(stepB);
	if (!pathA || !pathB) return false;
	return pathA === pathB;
}

/**
 * Greedy packer: pick up to `maxCount` steps from `steps` such that no two
 * PICKED steps have overlapping write paths.
 *
 * Algorithm:
 *   - Iterates over `steps` in order.
 *   - First step is always picked.
 *   - Each subsequent step is picked iff (a) it doesn't overlap with any
 *     already-picked step AND (b) we haven't reached `maxCount`.
 *
 * Returns the picked subset (a NEW array; does not mutate input).
 *
 * Used by scheduler when `limits.serializeOnPathOverlap = true`.
 */
export function selectNonOverlapping(steps: WorkflowStep[], maxCount: number): WorkflowStep[] {
	const picked: WorkflowStep[] = [];
	if (maxCount <= 0 || steps.length === 0) return picked;
	for (const step of steps) {
		if (picked.length >= maxCount) break;
		let conflict = false;
		for (const existing of picked) {
			if (detectWriteOverlap(step, existing)) {
				conflict = true;
				break;
			}
		}
		if (!conflict) picked.push(step);
	}
	return picked;
}

/**
 * Scheduler-side wrapper: given a list of ready task IDs (from the task-graph
 * ready queue), filter them by write-path overlap using the workflow step
 * definitions.
 *
 * Behavior:
 *   - Resolves each task ID → `TeamTaskState` → `WorkflowStep` via
 *     `task.stepId` matching `workflow.steps[i].id`.
 *   - Tasks whose step is missing from the workflow (e.g. ad-hoc tasks) are
 *     always included (treated as having no declared write path).
 *   - Returns the same array (identity-equal) when `enabled` is false, so
 *     callers can skip the filter cheaply.
 *
 * Used by the team-runner scheduler when `limits.serializeOnPathOverlap`
 * is `true` (per plan §11 decision #6, default is `false` so this is a
 * no-op in v0.9.17 unless the workflow author opts in).
 */
export function filterReadyByWriteOverlap(
	readyTaskIds: string[],
	tasks: TeamTaskState[],
	workflow: WorkflowConfig,
	maxCount: number,
	enabled: boolean,
): string[] {
	if (!enabled || maxCount <= 0 || readyTaskIds.length === 0) return readyTaskIds;
	const taskById = new Map<string, TeamTaskState>(tasks.map((task) => [task.id, task]));
	const stepById = new Map<string, WorkflowStep>(workflow.steps.map((step) => [step.id, step]));
	const pickedSteps: WorkflowStep[] = [];
	const pickedTaskIds: string[] = [];
	for (const taskId of readyTaskIds) {
		if (pickedTaskIds.length >= maxCount) break;
		const task = taskById.get(taskId);
		if (!task || !task.stepId) {
			// No step reference: treat as no declared write path → never conflicts.
			pickedTaskIds.push(taskId);
			continue;
		}
		const step = stepById.get(task.stepId);
		if (!step) {
			pickedTaskIds.push(taskId);
			continue;
		}
		let conflict = false;
		for (const existing of pickedSteps) {
			if (detectWriteOverlap(step, existing)) {
				conflict = true;
				break;
			}
		}
		if (!conflict) {
			pickedTaskIds.push(taskId);
			pickedSteps.push(step);
		}
	}
	return pickedTaskIds;
}
