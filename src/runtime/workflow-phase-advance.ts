/**
 * Workflow-phase advancement for the team-run scheduler loop.
 *
 * Extracted from team-runner.ts (2026-08, Phase 2.6 maintainability split —
 * CORE-4 extraction 6). Pure code motion: advanceWorkflowPhases moved
 * verbatim.
 */
import { appendEventAsync } from "../state/event-log/event-log.ts";
import { transitionPhase, type PhaseGuardContext } from "./workflow-state.ts";
import type { SchedulerContext } from "./scheduler-context.ts";

/**
 * CORE-4 extraction 6: advance workflow phases whose tasks are all in
 * terminal state.
 *
 * Iterates phases starting at `ctx.wfMachine.currentPhaseIndex`; for each phase
 * whose tasks are all terminal, determines the transition status (failed if
 * any task failed/cancelled, else completed), applies the phase transition,
 * emits `workflow.phase_completed`/`workflow.phase_failed`/
 * `workflow.phase_guard_blocked` events, and advances `currentPhaseIndex`.
 *
 * Reads `ctx.tasks`, `ctx.manifest` (read-only). Mutates `ctx.wfMachine`
 * in-place (phase status + currentPhaseIndex). The caller syncs the local
 * `wfMachine` from ctx after the call.
 *
 * @param ctx  The scheduler context.
 */
export async function advanceWorkflowPhases(ctx: SchedulerContext): Promise<void> {
	let wfMachine = ctx.wfMachine;
	const tasks = ctx.tasks;
	const manifest = ctx.manifest;
	// Advance workflow phases whose tasks are all in terminal state
	const terminalStatuses = new Set(["completed", "failed", "skipped", "cancelled", "needs_attention"]);
	const phaseTaskMap = new Map<string, string[]>();
	for (const task of tasks) {
		if (!task.stepId) continue;
		const existing = phaseTaskMap.get(task.stepId) ?? [];
		existing.push(task.id);
		phaseTaskMap.set(task.stepId, existing);
	}
	// W5-4: by-id map once for the phase loop (was O(phases × phaseTasks × tasks)).
	const taskById = new Map(tasks.map((t) => [t.id, t] as const));
	for (let pi = wfMachine.currentPhaseIndex; pi < wfMachine.phases.length; pi++) {
		const phase = wfMachine.phases[pi]!;
		const phaseTaskIds = phaseTaskMap.get(phase.name) ?? [];
		if (phaseTaskIds.length === 0) continue;
		const allTerminal = phaseTaskIds.every((taskId) => {
			const task = taskById.get(taskId);
			return task ? terminalStatuses.has(task.status) : false;
		});
		if (!allTerminal) break;
		if (phase.status !== "completed" && phase.status !== "failed" && phase.status !== "skipped") {
			const completedArtifacts = manifest.artifacts.filter((a) => a.kind === "result" || a.kind === "summary").map((a) => a.path);
			const previousPhaseStatus = pi > 0 ? (wfMachine.phases[pi - 1]?.status ?? "pending") : "completed";
			const wfContext: PhaseGuardContext = {
				completedArtifacts,
				previousPhaseStatus,
				taskResults: tasks
					.filter((t) => t.status === "completed" || t.status === "needs_attention")
					.map((t) => ({
						taskId: t.id,
						status: t.status,
						outputPath: t.resultArtifact?.path,
					})),
			};
			// Determine phase transition status based on individual task outcomes
			const phaseTasks = phaseTaskIds
				.map((taskId) => taskById.get(taskId))
				.filter((t): t is NonNullable<typeof t> => t !== undefined);
			const hasFailedOrCancelled = phaseTasks.some((t) => t.status === "failed" || t.status === "cancelled");
			const phaseStatus = hasFailedOrCancelled ? "failed" : "completed";
			const transition = transitionPhase(wfMachine, pi, phaseStatus, wfContext);
			wfMachine = transition.machine;
			if (transition.guardResult && !transition.guardResult.allowed) {
				await appendEventAsync(manifest.eventsPath, {
					type: "workflow.phase_guard_blocked",
					runId: manifest.runId,
					message: `Workflow phase '${phase.name}' guard blocked: ${transition.guardResult.reason ?? "unknown"}`,
					data: {
						phaseIndex: pi,
						phaseName: phase.name,
						reason: transition.guardResult.reason,
					},
				});
				break;
			}
			await appendEventAsync(manifest.eventsPath, {
				type: phaseStatus === "failed" ? "workflow.phase_failed" : "workflow.phase_completed",
				runId: manifest.runId,
				message: `Workflow phase '${phase.name}' ${phaseStatus}.`,
				data: { phaseIndex: pi, phaseStatus },
			});
		}
		wfMachine = { ...wfMachine, currentPhaseIndex: pi + 1 };
	}
	ctx.wfMachine = wfMachine;
}

/** @internal 1.9(b) test export — exercise advanceWorkflowPhases directly. */
export const __test__advanceWorkflowPhases = advanceWorkflowPhases;
