/**
 * Extracted `api` operation handlers — mailbox group (H3 phase 2).
 *
 * Extracted from `src/extension/team-tool/api.ts` on 2026-08-10. Behaviour is
 * byte-identical to the inline `if` blocks they replace.
 */

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
import { appendEvent } from "../../../state/event-log/event-log.ts";
import type { ApiOperationHandler } from "./handler-context.ts";

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
			appendEvent(loaded.manifest.eventsPath, {
				type: "mailbox.message",
				runId: loaded.manifest.runId,
				data: { id: message.id, direction, from, to },
			});
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
			appendEvent(loaded.manifest.eventsPath, {
				type: "mailbox.acknowledged",
				runId: loaded.manifest.runId,
				data: { messageId },
			});
			if (message?.data?.kind === "group_join" && typeof message.data.requestId === "string") {
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
