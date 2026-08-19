/**
 * Plan-approval gate helpers.
 *
 * Extracted from team-runner.ts (2026-08, Phase 2.6 maintainability split —
 * plan-approval family). Pure code motion: requiresPlanApproval /
 * isPlanApprovalPending / isMutatingTask / ensurePlanApprovalRequested moved
 * verbatim from team-runner.ts. cancelPlanTasks stays in team-runner.ts
 * (RT-14 structural source-pin test requires it defined there).
 */

import type { CrewRuntimeConfig } from "../config/config.ts";
import { appendEvent } from "../state/event-log/event-log.ts";
import { saveRunManifestAsync } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { WorkflowConfig } from "../workflows/workflow-config.ts";
import { permissionForRole } from "./role-permission.ts";

export function requiresPlanApproval(_workflow: WorkflowConfig, runtimeConfig: CrewRuntimeConfig | undefined): boolean {
	// ROADMAP T1.2: plan-level HITL applies to ANY workflow when
	// config.runtime.requirePlanApproval === true (not just 'implementation').
	// The gate fires at the read-only → mutating (plan → execute) boundary.
	return runtimeConfig?.requirePlanApproval === true;
}

/** State-level predicate shared by every render surface (widget badge,
 *  progress banner, powerbar segment) so gating is byte-identical to the
 *  action side: `required === true && status === "pending"`. A malformed
 *  manifest (`pending` without `required`) must NOT light up surfaces while
 *  keys/backends refuse — single source of truth (WP-3 review F2). */
export function isPlanApprovalStatePending(approval: TeamRunManifest["planApproval"]): boolean {
	return approval?.required === true && approval.status === "pending";
}

export function isPlanApprovalPending(manifest: TeamRunManifest): boolean {
	return isPlanApprovalStatePending(manifest.planApproval);
}

export function isMutatingTask(task: TeamTaskState): boolean {
	return permissionForRole(task.role) !== "read_only";
}

export async function ensurePlanApprovalRequested(manifest: TeamRunManifest, tasks: TeamTaskState[]): Promise<TeamRunManifest> {
	if (manifest.planApproval) return manifest;
	const assessTask = tasks.find((task) => task.stepId === "assess" && task.status === "completed");
	// ROADMAP T1.2: for non-adaptive workflows, fall back to the most recent
	// completed read-only (planning) task as the plan reference.
	const planTask = assessTask ?? [...tasks].reverse().find((t) => t.status === "completed" && !isMutatingTask(t));
	const now = new Date().toISOString();
	const updated: TeamRunManifest = {
		...manifest,
		updatedAt: now,
		planApproval: {
			required: true,
			status: "pending",
			requestedAt: now,
			updatedAt: now,
			planTaskId: planTask?.id,
			planArtifactPath: planTask?.resultArtifact?.path,
		},
	};
	await saveRunManifestAsync(updated);
	appendEvent(updated.eventsPath, {
		type: "plan.approval_required",
		runId: updated.runId,
		taskId: planTask?.id,
		message: "Plan requires explicit approval before mutating tasks run. Use: team api op=approve-plan runId=...",
		data: { planArtifactPath: planTask?.resultArtifact?.path },
	});
	return updated;
}

/** @internal 1.9(b) test export — exercise requiresPlanApproval directly. */
export const __test__requiresPlanApproval = requiresPlanApproval;
/** @internal 1.9(b) test export — exercise ensurePlanApprovalRequested directly. */
export const __test__ensurePlanApprovalRequested = ensurePlanApprovalRequested;
