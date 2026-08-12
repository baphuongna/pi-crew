/**
 * Extracted `api` operation handlers — plan approval group (H3 phase 2).
 *
 * Extracted from `src/extension/team-tool/api.ts` on 2026-08-10. Behaviour is
 * byte-identical to the inline `if` blocks they replace.
 */

import { terminateLiveAgentsForRun } from "../../../runtime/live-session/live-agent-manager.ts";
import { currentCrewRole, permissionForRole } from "../../../runtime/role-permission.ts";
import { withRunLock } from "../../../state/coordination/locks.ts";
import { appendEvent } from "../../../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasks, updateRunStatus } from "../../../state/stores/state-store.ts";
import { logInternalError } from "../../../utils/internal-error.ts";
import type { ApiOperationHandler } from "./handler-context.ts";

function canApprovePlan(): { allowed: boolean; reason?: string } {
	const role = currentCrewRole();
	if (!role) return { allowed: true };
	if (permissionForRole(role) === "read_only")
		return {
			allowed: false,
			reason: `Role '${role}' is read-only and cannot approve or cancel plan gates.`,
		};
	return { allowed: true };
}

export const handleApprovePlan: ApiOperationHandler = async (hctx) => {
	const { loaded, result, ctx } = hctx;
	const permission = canApprovePlan();
	if (!permission.allowed)
		return result(
			permission.reason ?? "Plan approval is not allowed in this context.",
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	try {
		return await withRunLock(loaded.manifest, async () => {
			const current = loadRunManifestById(ctx.cwd, loaded.manifest.runId) ?? loaded; // NOTE: inside withRunLock - consistent read
			const approval = current.manifest.planApproval;
			if (!approval?.required || approval.status !== "pending")
				return result(
					"Run has no pending plan approval request.",
					{
						action: "api",
						status: "error",
						runId: loaded.manifest.runId,
					},
					true,
				);
			const now = new Date().toISOString();
			const manifest = {
				...current.manifest,
				updatedAt: now,
				planApproval: {
					...approval,
					status: "approved" as const,
					approvedAt: now,
					updatedAt: now,
				},
			};
			await saveRunManifestAsync(manifest);
			appendEvent(manifest.eventsPath, {
				type: "plan.approved",
				runId: manifest.runId,
				taskId: approval.planTaskId,
				message: "Adaptive implementation plan approved; resume the run to execute mutating tasks.",
				metadata: { provenance: "api" },
			});
			return result(JSON.stringify(manifest.planApproval, null, 2), {
				action: "api",
				status: "ok",
				runId: manifest.runId,
				artifactsRoot: manifest.artifactsRoot,
			});
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(
			message,
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	}
};

export const handleCancelPlan: ApiOperationHandler = async (hctx) => {
	const { loaded, result, ctx } = hctx;
	const permission = canApprovePlan();
	if (!permission.allowed)
		return result(
			permission.reason ?? "Plan approval cancellation is not allowed in this context.",
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	try {
		return await withRunLock(loaded.manifest, async () => {
			const current = loadRunManifestById(ctx.cwd, loaded.manifest.runId) ?? loaded; // NOTE: inside withRunLock - consistent read
			const approval = current.manifest.planApproval;
			if (!approval?.required || approval.status !== "pending")
				return result(
					"Run has no pending plan approval request.",
					{
						action: "api",
						status: "error",
						runId: loaded.manifest.runId,
					},
					true,
				);
			const now = new Date().toISOString();
			const tasks = current.tasks.map((task) =>
				task.status === "queued" || task.status === "running" || task.status === "waiting"
					? {
							...task,
							status: "cancelled" as const,
							finishedAt: now,
							error: "Plan approval was cancelled.",
						}
					: task,
			);
			let manifest: typeof current.manifest = {
				...current.manifest,
				updatedAt: now,
				planApproval: {
					...approval,
					status: "cancelled" as const,
					cancelledAt: now,
					updatedAt: now,
				},
			};
			await saveRunManifestAsync(manifest);
			saveRunTasks(manifest, tasks);
			appendEvent(manifest.eventsPath, {
				type: "plan.cancelled",
				runId: manifest.runId,
				taskId: approval.planTaskId,
				message: "Adaptive implementation plan was cancelled.",
				metadata: { provenance: "api" },
			});
			manifest = updateRunStatus(manifest, "cancelled", "Plan approval was cancelled.");
			void terminateLiveAgentsForRun(manifest.runId, "cancelled", appendEvent, manifest.eventsPath).catch((error) =>
				logInternalError("team-tool.cancel-plan.terminate", error, `runId=${manifest.runId}`),
			);
			return result(
				JSON.stringify(
					{
						planApproval: manifest.planApproval,
						cancelledTasks: tasks.filter((task) => task.status === "cancelled").map((task) => task.id),
					},
					null,
					2,
				),
				{
					action: "api",
					status: "ok",
					runId: manifest.runId,
					artifactsRoot: manifest.artifactsRoot,
				},
			);
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(
			message,
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	}
};

/** Dispatcher map for the plan-approval group. Consumed by handleApi. */
export const PLAN_APPROVAL_OPERATIONS: Record<string, ApiOperationHandler> = {
	"approve-plan": handleApprovePlan,
	"cancel-plan": handleCancelPlan,
};
