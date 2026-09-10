/**
 * mailbox-fanout.ts — Phase 1.3 mailbox-event fanout helper.
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * Operates only on the connectionsByRun index + writeOrQueue/enqueueFrame
 * functions passed in. Promoted to a top-level function so the class
 * method is a 1-line delegation.
 */

import type { MailboxMessage } from "../../../state/coordination/mailbox.ts";
import { encodeBrokerFrame } from "../../../utils/ndjson.ts";
import type { ServerConnection } from "../protocol/connection-state.ts";

export interface FanoutWriters {
	writeOrQueue(conn: ServerConnection, buf: Buffer, force: boolean): void;
}

/** Phase 1.3: push a durable-appended mailbox message to any connected
 *  recipient for the message's run. Best-effort — silently skips
 *  recipients that are offline (they recover via msg.inbox). Never throws. */
export function fanoutMailboxMessage(
	connectionsByRun: Map<string, Set<ServerConnection>>,
	writers: FanoutWriters,
	msg: MailboxMessage,
): void {
	const set = connectionsByRun.get(msg.runId);
	if (!set || set.size === 0) return;
	// Recipient delivery dedup lives in src/prompt/prompt-runtime.ts and is
	// keyed by the same message id in this mailbox event and the steering JSONL.
	const eventFrame = encodeBrokerFrame({
		event: "mailbox.message",
		data: {
			id: msg.id,
			from: msg.from,
			to: msg.to,
			body: msg.body,
			kind: msg.kind,
			priority: msg.priority,
		},
		seq: 0, // mailbox messages don't carry a TeamEvent seq; dedup by msg.id
	});
	for (const conn of set) {
		if (conn.closed || !conn.authed) continue;
		// Recipient filter: deliver to the addressed task, or to all if 'all'.
		// Task 5b (§15.2 wake): "parent"-addressed messages land in the
		// run-level inbox, whose live consumer is the run's orchestrator
		// connection (role from the orchestrator token — its taskId never
		// equals "parent"), so without this branch the wake frame would be
		// filtered out and the orchestrator would only see the message on
		// its next inbox poll.
		const isRecipient = !msg.to || msg.to === "all" || conn.taskId === msg.to || (msg.to === "parent" && conn.role === "orchestrator");
		if (!isRecipient) continue;
		try {
			writers.writeOrQueue(conn, eventFrame, false);
		} catch {
			/* a slow/dead recipient must not break fanout to others */
		}
	}
}
