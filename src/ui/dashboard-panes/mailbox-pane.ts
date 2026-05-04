import type { RunUiSnapshot } from "../snapshot-types.ts";

export function renderMailboxPane(snapshot: RunUiSnapshot | undefined): string[] {
	if (!snapshot) return ["Mailbox pane: snapshot unavailable"];
	const mailbox = snapshot.mailbox;
	const approx = mailbox.approximate ? " · approximate (tail)" : "";
	return [
		`Mailbox pane: inbox unread=${mailbox.inboxUnread} · outbox pending=${mailbox.outboxPending} · attention=${mailbox.needsAttention}${approx}`,
		mailbox.needsAttention > 0 ? "Needs attention: press Enter for detail · A ack · N nudge · C compose · X ack all." : "No mailbox items need attention. Press Enter for detail or C compose.",
	];
}
