/**
 * Extracted `api` operation handlers — mailbox group (H3 phase 2).
 *
 * Extracted from `src/extension/team-tool/api.ts` on 2026-08-10. Behaviour is
 * byte-identical to the inline `if` blocks they replace.
 */

import { getCrewEnv } from "../../../config/env-vars.ts";
import { currentCrewRole, permissionForRole } from "../../../runtime/role-permission.ts";
import { withRunLockSync } from "../../../state/coordination/locks.ts";
import {
	acknowledgeMailboxMessage,
	appendMailboxMessage,
	type MailboxDirection,
	type MailboxMessageKind,
	readDeliveryState,
	readMailbox,
	readMailboxMessage,
	validateMailbox,
} from "../../../state/coordination/mailbox.ts";
import { appendEvent, appendEventBuffered } from "../../../state/event-log/event-log.ts";
import { logInternalError } from "../../../utils/internal-error.ts";
import type { ApiOperationHandler } from "./handler-context.ts";

// ── W1b deferred residual (w9-r1): role gates on mutating mailbox operations ──
// send-message (mailbox append + event), ack-message (delivery-state write +
// events), and validate-mailbox WITH repair=true (rewrites mailbox/delivery
// files) all mutate run state, so they follow the canMutateTaskClaims pattern
// (task-claims.ts): read_only-tier roles (explorer/analyst/reviewer/critic/
// planner/security-reviewer + default-deny unknowns) are denied; write-tier
// workers and role-less root-session callers stay allowed. Plain validate-mailbox
// (repair unset/false) is a pure diagnostic READ and stays open, as do
// read-mailbox and read-delivery.

/** Role-tier gate for mailbox-mutating operations (canApprovePlan pattern). */
function canMutateMailbox(op: "repair" | "send" | "ack"): { allowed: boolean; reason?: string } {
	const role = currentCrewRole();
	if (!role) return { allowed: true };
	if (permissionForRole(role) !== "read_only") return { allowed: true };
	const action = op === "repair" ? "repair the mailbox" : op === "send" ? "send mailbox messages" : "acknowledge mailbox messages";
	return { allowed: false, reason: `Role '${role}' is read-only and cannot ${action}.` };
}

/** Caller identity fields for the audit trail (w1b callerAuditFields pattern). */
function callerAuditFields(): { callerRole?: string; callerTaskId?: string } {
	const callerRole = currentCrewRole();
	const callerTaskId = getCrewEnv("PI_CREW_TASK_ID")?.trim() || undefined;
	return {
		...(callerRole ? { callerRole } : {}),
		...(callerTaskId ? { callerTaskId } : {}),
	};
}

export const handleReadMailbox: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result } = hctx;
	const direction = cfg.direction === "inbox" || cfg.direction === "outbox" ? (cfg.direction as MailboxDirection) : undefined;
	const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
	const kind =
		typeof cfg.kind === "string" && ["message", "steer", "follow-up", "response", "group_join"].includes(cfg.kind)
			? (cfg.kind as MailboxMessageKind)
			: undefined;
	if (taskId && !loaded.tasks.some((task) => task.id === taskId))
		return result(
			`API read-mailbox taskId '${taskId}' does not match a run task.`,
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	try {
		return result(JSON.stringify(readMailbox(loaded.manifest, direction, taskId, kind), null, 2), {
			action: "api",
			status: "ok",
			runId: loaded.manifest.runId,
			artifactsRoot: loaded.manifest.artifactsRoot,
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

export const handleValidateMailbox: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result } = hctx;
	// W1b residual: ONLY the repair pass mutates (rewrites mailbox/delivery
	// state); the plain validation report is a diagnostic read and stays open.
	if (cfg.repair === true) {
		const gate = canMutateMailbox("repair");
		if (!gate.allowed)
			return result(
				gate.reason ?? "mailbox repair is not allowed in this context.",
				{
					action: "api",
					status: "error",
					runId: loaded.manifest.runId,
				},
				true,
			);
	}
	const report = validateMailbox(loaded.manifest, {
		repair: cfg.repair === true,
	});
	return result(
		JSON.stringify(report, null, 2),
		{
			action: "api",
			status: report.issues.some((issue) => issue.level === "error") && cfg.repair !== true ? "error" : "ok",
			runId: loaded.manifest.runId,
			artifactsRoot: loaded.manifest.artifactsRoot,
		},
		report.issues.some((issue) => issue.level === "error") && cfg.repair !== true,
	);
};

export const handleReadDelivery: ApiOperationHandler = (hctx) => {
	const { loaded, result } = hctx;
	return result(JSON.stringify(readDeliveryState(loaded.manifest), null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleSendMessage: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired, ctx } = hctx;
	const gate = canMutateMailbox("send");
	if (!gate.allowed)
		return result(
			gate.reason ?? "send-message is not allowed in this context.",
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	const direction = cfg.direction === "outbox" ? "outbox" : "inbox";
	const from = typeof cfg.from === "string" && cfg.from.trim() ? cfg.from.trim() : "api";
	const to = typeof cfg.to === "string" && cfg.to.trim() ? cfg.to.trim() : "leader";
	const body = typeof cfg.body === "string" && cfg.body.trim() ? cfg.body : undefined;
	const taskId = typeof cfg.taskId === "string" && cfg.taskId.trim() ? cfg.taskId.trim() : undefined;
	if (!body)
		return result(
			paramRequired(
				"API send-message",
				"config.body",
				"{ action: 'api', runId: 'team_...', config: { operation: 'send-message', body: '<message>' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	if (taskId && !loaded.tasks.some((task) => task.id === taskId))
		return result(
			`API send-message taskId '${taskId}' does not match a run task.`,
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	try {
		return withRunLockSync(loaded.manifest, () => {
			const message = appendMailboxMessage(loaded.manifest, {
				direction,
				from,
				to,
				body,
				taskId,
			});
			// H1 (2026-08-10): informational mailbox event inside a SYNC
			// run-lock callback. Sync append (byte-identical to pre-extract
			// api.ts) so consumers reading eventsPath immediately after the
			// call see the event — async fire-and-forget would race.
			appendEventBuffered(loaded.manifest.eventsPath, {
				type: "mailbox.message",
				runId: loaded.manifest.runId,
				data: {
					id: message.id,
					direction,
					from,
					to,
					// W1b residual: record the verified caller identity on the audit trail.
					...callerAuditFields(),
				},
			}).catch((e) => logInternalError("api.mailbox.buffered", e, "type=mailbox.message"));
			ctx.events?.emit?.("crew.mailbox.message", {
				runId: loaded.manifest.runId,
				id: message.id,
				direction,
				from,
				to,
				taskId,
				source: "send-message",
			});
			return result(JSON.stringify(message, null, 2), {
				action: "api",
				status: "ok",
				runId: loaded.manifest.runId,
				artifactsRoot: loaded.manifest.artifactsRoot,
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

export const handleAckMessage: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired, ctx } = hctx;
	const gate = canMutateMailbox("ack");
	if (!gate.allowed)
		return result(
			gate.reason ?? "ack-message is not allowed in this context.",
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	const messageId = typeof cfg.messageId === "string" ? cfg.messageId : undefined;
	if (!messageId)
		return result(
			paramRequired(
				"API ack-message",
				"config.messageId",
				"{ action: 'api', runId: 'team_...', config: { operation: 'ack-message', messageId: 'msg-1' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	try {
		return withRunLockSync(loaded.manifest, () => {
			const message = readMailboxMessage(loaded.manifest, messageId);
			const delivery = acknowledgeMailboxMessage(loaded.manifest, messageId);
			// Read-your-writes (CI 2026-09-11, phase4 integration): the ack API
			// returns and callers/tests read events.jsonl synchronously right after —
			// buffered append flushes later (bufferMs window), so the events were
			// missing at read. Sync appendEvent (base behavior, b6eba80f pattern).
			try {
				appendEvent(loaded.manifest.eventsPath, {
					type: "mailbox.acknowledged",
					runId: loaded.manifest.runId,
					data: {
						messageId,
						// W1b residual: record the verified caller identity on the audit trail.
						...callerAuditFields(),
					},
				});
			} catch (e) {
				logInternalError("api.mailbox.append", e, "type=mailbox.acknowledged");
			}
			if (message?.data?.kind === "group_join" && typeof message.data.requestId === "string") {
				try {
					appendEvent(loaded.manifest.eventsPath, {
						type: "agent.group_join.acknowledged",
						runId: loaded.manifest.runId,
						message: "Group join delivery acknowledged via mailbox ack.",
						data: {
							requestId: message.data.requestId,
							messageId,
							batchId: message.data.batchId,
							partial: message.data.partial,
							acknowledgedAt: delivery.updatedAt,
							acknowledgedBy: "leader",
						},
						metadata: { provenance: "api" },
					});
				} catch (e) {
					logInternalError("api.mailbox.append", e, "type=agent.group_join.acknowledged");
				}
			}
			ctx.events?.emit?.("crew.mailbox.acknowledged", {
				runId: loaded.manifest.runId,
				messageId,
				delivery,
			});
			return result(JSON.stringify(delivery, null, 2), {
				action: "api",
				status: "ok",
				runId: loaded.manifest.runId,
				artifactsRoot: loaded.manifest.artifactsRoot,
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

/** Dispatcher map for the mailbox group. Consumed by handleApi. */
export const MAILBOX_OPERATIONS: Record<string, ApiOperationHandler> = {
	"read-mailbox": handleReadMailbox,
	"validate-mailbox": handleValidateMailbox,
	"read-delivery": handleReadDelivery,
	"send-message": handleSendMessage,
	"ack-message": handleAckMessage,
};
