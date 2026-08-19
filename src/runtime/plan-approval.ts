/**
 * Plan-approval gate helpers.
 *
 * Extracted from team-runner.ts (2026-08, Phase 2.6 maintainability split —
 * plan-approval family). Pure code motion: requiresPlanApproval /
 * isPlanApprovalPending / isMutatingTask / ensurePlanApprovalRequested moved
 * verbatim from team-runner.ts. cancelPlanTasks stays in team-runner.ts
 * (RT-14 structural source-pin test requires it defined there).
 */

import * as fs from "node:fs";
import type { CrewRuntimeConfig } from "../config/config.ts";
import { parsePlannerPlanOutput } from "../extension/plan-orchestrate.ts";
import { appendEvent } from "../state/event-log/event-log.ts";
import { appendPlanRevision, getCurrentPlanRecord, setPlanApproval } from "../state/stores/plan-store.ts";
import { saveRunManifestAsync } from "../state/stores/state-store.ts";
import type { PlanRecord, TeamRunManifest, TeamTaskState } from "../state/types.ts";
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

	// T2/R4 (ADR-4 §6 producer 3 + §8 dual-write): make sure a PlanRecord
	// exists before the gate lights up, so approval names plan id+version.
	// - Record already present (adaptive producer ran, or a re-request after
	//   crash between the record append and the manifest save) → reuse it.
	// - No record → try the planner-tagged `<plan>` contract on the plan
	//   artifact; if that fails → manifest-only gate (pre-v2 behavior, the
	//   dual-read fallback in plan-store keeps readers correct).
	let record = getCurrentPlanRecord(manifest);
	if (!record && planTask?.resultArtifact?.path) {
		try {
			const text = fs.readFileSync(planTask.resultArtifact.path, "utf-8");
			const parsed: PlanRecord | undefined = parsePlannerPlanOutput(text, manifest.runId, planTask.id);
			if (parsed) record = appendPlanRevision(manifest, parsed);
		} catch {
			// Unreadable/unparsable artifact → manifest-only gate (below); the
			// gate must still light up — never a throw here.
		}
	}
	if (record) {
		setPlanApproval(manifest, { status: "pending", planVersion: record.version });
	}

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
		plan: record ? { id: record.id, version: record.version } : manifest.plan,
	};
	await saveRunManifestAsync(updated);
	appendEvent(updated.eventsPath, {
		type: "plan.approval_required",
		runId: updated.runId,
		taskId: planTask?.id,
		message: "Plan requires explicit approval before mutating tasks run. Use: team api op=approve-plan runId=...",
		data: { planArtifactPath: planTask?.resultArtifact?.path, planId: record?.id, planVersion: record?.version },
	});
	return updated;
}

/** @internal 1.9(b) test export — exercise requiresPlanApproval directly. */
export const __test__requiresPlanApproval = requiresPlanApproval;
/** @internal 1.9(b) test export — exercise ensurePlanApprovalRequested directly. */
export const __test__ensurePlanApprovalRequested = ensurePlanApprovalRequested;
