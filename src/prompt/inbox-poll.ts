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
 *     `sinceTs` watermark — one message delivers once.
 */
import { type MailboxMessage, readAllMailboxMessages } from "../state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../state/types.ts";

export interface WorkerInboxPickup {
	stateRoot: string;
	runId: string;
	taskId: string;
	/** Watermark: only messages with `createdAt > sinceTs` are considered. */
	sinceTs?: string;
	/** Mutable seen-id set for cross-poll dedup (the poll loop owns it). */
	seenIds?: Set<string>;
}

/**
 * Read the worker's inbox mailbox and return the messages that should be
 * surfaced as fenced context on the next turn.
 *
 * Stateless apart from the optional caller-owned `seenIds`/`sinceTs` — safe
 * to call on every 500ms poll tick.
 */
export function pollWorkerInbox(pickup: WorkerInboxPickup): MailboxMessage[] {
	const { stateRoot, runId, taskId } = pickup;
	if (!stateRoot || !runId || !taskId) return [];
	const manifest = { stateRoot, runId } as unknown as TeamRunManifest;
	let messages: MailboxMessage[];
	try {
		// readAllMailboxMessages already merges run-level inbox + every task
		// mailbox; we route TO this worker below (never trust a caller-scoped
		// file path).
		messages = readAllMailboxMessages(manifest, "inbox");
	} catch {
		// Transient read error (lock contention, rotated file) — never throw
		// out of a poll tick; the next 500ms tick retries.
		return [];
	}

	const seen = pickup.seenIds;
	const picked: MailboxMessage[] = [];
	const byId = new Set<string>();
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
		if (seen && seen.has(m.id)) continue;
		// Within-call id dedup (duplicate file rows → one delivery).
		if (byId.has(m.id)) continue;
		byId.add(m.id);
		seen?.add(m.id);
		picked.push(m);
	}
	// Deterministic delivery order (same sort readAllMailboxMessages applies).
	return picked;
}
