/**
 * inbox-poll.ts — Task 5 (SDD 2026-08-26-loadout-nesting-messaging) worker
 * inbox pickup.
 *
 * The worker-side `message` tool (D9 / §15.2) writes durable mailbox
 * entries (`kind:"message"` | `"notify"`). This module is the RECEIVE side:
 * the poll loop that shares the ask/delegate cadence picks up new
 * `kind:"message"` entries addressed to THIS task and surfaces them as
 * fenced context at the next turn boundary via `pi.sendMessage` with
 * `deliverAs:"steer"`.
 *
 * Contract (mirrors the broker's recipient resolution in handleMsgSend):
 *   - only `kind:"message"` enters the pickup (notify → fire-and-forget,
 *     steer/response/follow-up → other channels);
 *   - only entries whose mailbox task is THIS worker (`taskId === this`):
 *     sibling DMs are written to the sibling's task mailbox, group-broadcast
 *     recipient copies are written to each recipient's task mailbox, and
 *     `to:"parent"` reports land in the run-level inbox (taskId undefined)
 *     which is ORCHESTRATOR territory — a worker must never read it;
 *   - a worker must never pick up a message whose `from` is itself (§15.3
 *     anti-spoof / self-echo: the broker overrides `from` to the sender's
 *     authenticated taskId, so a group broadcast returns to its sender and
 *     must be dropped at consume time);
 *   - dedup by message id across polls via a caller-owned seen-set and/or a
 *     `sinceTs` watermark — one message delivers once;
 *   - U5 (2026-10-10): dedup is ALSO durable across restarts — every picked
 *     row is recorded in delivery.json (`messages[id]="acknowledged"` +
 *     `${direction}:${requestId}` index) and re-read on the next poll, so a
 *     worker that restarts mid-run (fresh process, EMPTY seen-set) never
 *     re-delivers. A resend carrying the same requestId is dropped by the
 *     same index; duplicate rows under one requestId deliver exactly once.
 */
import * as path from "node:path";
import {
	type MailboxDeliveryState,
	type MailboxMessage,
	readAllMailboxMessages,
	readDeliveryState,
	recordMailboxRequestIdDelivery,
} from "../state/coordination/mailbox.ts";
import { appendEventFireAndForget } from "../state/event-log/event-log.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";

export interface WorkerInboxPickup {
	stateRoot: string;
	runId: string;
	taskId: string;
	/** Watermark: only messages with `createdAt > sinceTs` are considered. */
	sinceTs?: string;
	/** Mutable seen-id set for cross-poll dedup (the poll loop owns it). */
	seenIds?: Set<string>;
}

/** U5: requestId of a row — the U5 top-level field with the legacy
 *  `data.requestId` shape (group_join) as fallback. */
function messageIdempotencyKey(message: MailboxMessage): string | undefined {
	if (message.requestId) return message.requestId;
	const fromData = message.data?.requestId;
	return typeof fromData === "string" ? fromData : undefined;
}

// U5: in-process throttle for `mailbox.pickup_deduped` audit events — a
// restarted worker re-scans the same durable rows on EVERY 500ms tick, so an
// un-throttled per-skip event would spam the log (2/s/row). One event per
// (run, task, key) per process lifetime is the audit signal ("redelivery was
// prevented by the durable record"); bounded FIFO like the parse caches.
const DEDUP_EVENT_KEYS_MAX = 512;
const dedupEventKeys = new Map<string, true>();

function shouldEmitDedupEvent(runId: string, taskId: string, key: string): boolean {
	const mapKey = `${runId}:${taskId}:${key}`;
	if (dedupEventKeys.has(mapKey)) return false;
	dedupEventKeys.set(mapKey, true);
	while (dedupEventKeys.size > DEDUP_EVENT_KEYS_MAX) {
		const oldest = dedupEventKeys.keys().next().value;
		if (oldest === undefined) break;
		dedupEventKeys.delete(oldest);
	}
	return true;
}

/** U5: audit event for a redelivery that the DURABLE record prevented (the
 *  in-memory seen-set alone could not — this is exactly the restart window). */
function emitPickupDedupedEvent(stateRoot: string, runId: string, taskId: string, message: MailboxMessage, layer: string): void {
	if (!shouldEmitDedupEvent(runId, taskId, `${layer}:${message.id}`)) return;
	try {
		appendEventFireAndForget(path.join(stateRoot, "events.jsonl"), {
			type: "mailbox.pickup_deduped",
			runId,
			taskId,
			message: `Dropped duplicate inbox delivery (${layer}) for task ${taskId}.`,
			data: {
				layer,
				messageId: message.id,
				requestId: messageIdempotencyKey(message),
				from: message.from,
				kind: message.kind,
			},
		});
	} catch (error) {
		logInternalError("inbox-poll.pickup-deduped-event", error, `runId=${runId} taskId=${taskId}`);
	}
}

/** U5: audit event for a successful pickup — with the requestId, the event
 *  log is sufficient to audit the dedup chain end-to-end (broker
 *  `mailbox.send` → worker `mailbox.pickup` → `mailbox.pickup_deduped`). */
function emitPickupEvent(stateRoot: string, runId: string, taskId: string, picked: MailboxMessage[]): void {
	try {
		appendEventFireAndForget(path.join(stateRoot, "events.jsonl"), {
			type: "mailbox.pickup",
			runId,
			taskId,
			message: `Picked up ${picked.length} inbox message(s) for task ${taskId}.`,
			data: {
				messageIds: picked.map((m) => m.id),
				requestIds: picked.map((m) => messageIdempotencyKey(m) ?? null),
			},
		});
	} catch (error) {
		logInternalError("inbox-poll.pickup-event", error, `runId=${runId} taskId=${taskId}`);
	}
}

/**
 * Read the worker's inbox mailbox and return the messages that should be
 * surfaced as fenced context on the next turn.
 *
 * Stateless apart from the optional caller-owned `seenIds`/`sinceTs` — safe
 * to call on every 500ms poll tick. U5: picked rows are ALSO recorded in the
 * durable delivery state (delivery.json), so dedup survives a restart.
 */
export function pollWorkerInbox(pickup: WorkerInboxPickup): MailboxMessage[] {
	const { stateRoot, runId, taskId } = pickup;
	if (!stateRoot || !runId || !taskId) return [];
	const manifest = { stateRoot, runId } as unknown as TeamRunManifest;
	let messages: MailboxMessage[];
	let delivery: MailboxDeliveryState;
	try {
		// readAllMailboxMessages already merges run-level inbox + every task
		// mailbox; we route TO this worker below (never trust a caller-scoped
		// file path).
		messages = readAllMailboxMessages(manifest, "inbox");
		// U5: the durable delivery record (mtime-cached read — cheap on the
		// 500ms tick) is the restart-safe dedup source of truth.
		delivery = readDeliveryState(manifest);
	} catch {
		// Transient read error (lock contention, rotated file) — never throw
		// out of a poll tick; the next 500ms tick retries.
		return [];
	}

	const seen = pickup.seenIds;
	const deliveredRequestIds = delivery.requestIds ?? {};
	const picked: MailboxMessage[] = [];
	const byId = new Set<string>();
	const byRequestId = new Set<string>();
	for (const m of messages) {
		// Kind gate: only durable `message`s (per §15.2). Notify is
		// fire-and-forget (its own channel), steer/response/follow-up are
		// other delivery paths.
		if (m.kind !== "message") continue;
		// §15.3 self-echo: a broadcast the worker itself sent must not
		// re-surface on its own next turn.
		if (m.from === taskId) continue;
		// Routing: the entry must be in THIS task's mailbox — never the
		// run-level inbox (orchestrator's parent channel) nor a sibling's.
		if (m.taskId !== taskId) continue;
		if (m.status === "acknowledged") continue;
		// sinceTs watermark (ISO string compare).
		if (pickup.sinceTs !== undefined && m.createdAt <= pickup.sinceTs) continue;
		// Cross-call seen-set dedup.
		if (seen?.has(m.id)) continue;
		// Within-call id dedup (duplicate file rows → one delivery).
		if (byId.has(m.id)) continue;
		// ── U5 durable dedup (2026-10-10) ──────────────────────────────────
		// These two layers survive a worker restart (delivery.json); the
		// in-memory gates above cannot. Every skip here is a redelivery that
		// was PREVENTED — audited via mailbox.pickup_deduped (once per key
		// per process so the 500ms re-scan cannot spam the event log).
		const requestId = messageIdempotencyKey(m);
		const dedupKey = requestId !== undefined ? `${m.direction}:${requestId}` : undefined;
		if (dedupKey !== undefined) {
			// (direction, requestId) index — catches resends carrying the same
			// requestId AND duplicate rows under one requestId.
			if (deliveredRequestIds[dedupKey] !== undefined) {
				emitPickupDedupedEvent(stateRoot, runId, taskId, m, "requestId");
				continue;
			}
			// Within-call requestId dedup (two rows, one requestId → first wins).
			if (byRequestId.has(dedupKey)) continue;
		}
		// Acknowledged delivery entry = the F09 durable "handled" record; the
		// inbox line itself keeps `status:"queued"` forever, so WITHOUT this
		// check a restarted worker re-delivers every already-consumed row
		// (legacy rows without a requestId land here too).
		if (delivery.messages[m.id] === "acknowledged") {
			emitPickupDedupedEvent(stateRoot, runId, taskId, m, "acknowledged");
			continue;
		}
		byId.add(m.id);
		if (dedupKey !== undefined) byRequestId.add(dedupKey);
		seen?.add(m.id);
		picked.push(m);
	}
	if (picked.length > 0) {
		// U5: persist the pickup — the durable record that powers the two
		// layers above after a restart. Best-effort on failure: the in-memory
		// seen-set still dedups within THIS process, and logInternalError
		// makes the lost-durability window visible.
		try {
			recordMailboxRequestIdDelivery(
				manifest,
				picked.map((m) => ({
					direction: m.direction,
					messageId: m.id,
					requestId: messageIdempotencyKey(m),
				})),
			);
			emitPickupEvent(stateRoot, runId, taskId, picked);
		} catch (error) {
			logInternalError("inbox-poll.record-delivery", error, `runId=${runId} taskId=${taskId}`);
		}
	}
	// Deterministic delivery order (same sort readAllMailboxMessages applies).
	return picked;
}
