/**
 * Mailbox detail overlay — RAIL design language (M4/E1, 2026-09-16).
 *
 *   ┏ MAILBOX ▸ 1a2b3c4d
 *   ┃ Inbox                 │ Outbox
 *   ┃ ›✓ lead ▸ one: ping    │  !
 *   ┃ ▼ 3 below
 *   ┣ MESSAGE
 *   ┃ lead ▸ one (one) · pending
 *   ┗ Tab side · ↑/↓ select · Enter expand · … ···· Esc close
 *
 * The `│` in the body is a genuine inner COLUMN separator of the two-column
 * mailbox table (§2.D) — it is not a frame edge. The frame is canopy + `┃`
 * body + `┗` close cap; the legacy title/hint header rows, the `───` inline
 * rule before the expanded message and the hand-typed hint string are gone.
 *
 * Hints: built by `formatHint` (close LAST) and laid out with `railLeaders` so
 * the `Esc close` segment stays visible on a narrow overlay instead of being
 * truncated away with the long action list.
 *
 * Every disk-sourced field is guarded (`?? "?"`): mailbox JSON is not
 * schema-validated at read time.
 */

import { type MailboxMessage, readDeliveryState, readMailbox } from "../../state/coordination/mailbox.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import { pad, truncate } from "../../utils/visual.ts";
import { overlayActionForKey } from "../keybinding-map.ts";
import { ACTIVE, CURSOR, canopyLine, formatHint, overflowHint, RAIL, railLeaders, railLine, sectionLine, shortId } from "../rail.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";

export type MailboxAction =
	| { type: "ack"; messageId: string }
	| { type: "nudge"; agentId?: string }
	| { type: "compose" }
	| { type: "ackAll" }
	| { type: "close" };

/** Rows shown per column before the overflow hint takes over. */
const MAX_ROWS = 12;

export class MailboxDetailOverlay {
	private readonly runId: string;
	private readonly cwd: string;
	private readonly done: (action: MailboxAction | undefined) => void;
	private readonly theme: CrewTheme;
	private inbox: MailboxMessage[] = [];
	private outbox: MailboxMessage[] = [];
	private side: "inbox" | "outbox" = "inbox";
	private selected = 0;
	private expanded = false;
	private lastRefreshedTaskCount = 0;
	private needsRefresh = true;

	constructor(opts: {
		runId: string;
		cwd: string;
		done: (action: MailboxAction | undefined) => void;
		theme?: unknown;
	}) {
		this.runId = opts.runId;
		this.cwd = opts.cwd;
		this.done = opts.done;
		this.theme = asCrewTheme(opts.theme ?? {});
		this.refresh();
	}

	private refresh(): void {
		const loaded = loadRunManifestById(this.cwd, this.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
		if (!loaded) return;
		// Track task count changes to trigger re-render
		const taskCount = loaded.tasks.length;
		if (taskCount !== this.lastRefreshedTaskCount) {
			this.lastRefreshedTaskCount = taskCount;
			this.needsRefresh = true;
		}
		const delivery = readDeliveryState(loaded.manifest).messages;
		const applyDelivery = (message: MailboxMessage): MailboxMessage => ({
			...message,
			status: delivery[message.id] ?? message.status,
		});
		const taskIds = loaded.tasks.map((task) => task.id);
		this.inbox = [
			...readMailbox(loaded.manifest, "inbox"),
			...taskIds.flatMap((taskId) => readMailbox(loaded.manifest, "inbox", taskId)),
		]
			.map(applyDelivery)
			.reverse();
		this.outbox = [
			...readMailbox(loaded.manifest, "outbox"),
			...taskIds.flatMap((taskId) => readMailbox(loaded.manifest, "outbox", taskId)),
		]
			.map(applyDelivery)
			.reverse();
		this.selected = Math.min(this.selected, Math.max(0, this.current().length - 1));
	}

	private current(): MailboxMessage[] {
		return this.side === "inbox" ? this.inbox : this.outbox;
	}

	private selectedMessage(): MailboxMessage | undefined {
		return this.current()[this.selected];
	}

	invalidate(): void {
		this.needsRefresh = true;
	}

	render(width: number): string[] {
		if (this.needsRefresh) {
			this.refresh();
			this.needsRefresh = false;
		}
		if (width < 10) return [];
		const theme = this.theme;
		const budget = width - 2;
		const lines: string[] = [canopyLine({ word: "MAILBOX", subject: shortId(this.runId), theme, budget })];

		// Two-column body (inbox ↔ outbox): `│` is the inner column separator.
		const col = Math.max(10, Math.floor((budget - 3) / 2));
		const rightCol = Math.max(1, budget - col - 3);
		const twoCol = (left: string, right: string) =>
			`${pad(truncate(left, col), col)} ${theme.fg("dim", "│")} ${truncate(right, rightCol)}`;
		lines.push(railLine(RAIL.body, "border", twoCol(theme.bold("Inbox"), theme.bold("Outbox")), theme, budget));
		const total = Math.max(this.inbox.length, this.outbox.length);
		const shown = Math.min(total, MAX_ROWS);
		for (let index = 0; index < shown; index += 1) {
			lines.push(
				railLine(
					RAIL.body,
					"border",
					twoCol(this.row(this.inbox[index], "inbox", index, col), this.row(this.outbox[index], "outbox", index, col)),
					theme,
					budget,
				),
			);
		}
		if (total > shown) {
			lines.push(railLine(RAIL.body, "border", overflowHint(0, total - shown, theme), theme, budget));
		}

		const selected = this.selectedMessage();
		if (this.expanded && selected) {
			const from = selected.from ?? "?";
			const to = selected.to ?? "?";
			lines.push(sectionLine({ name: "Message", theme, budget }));
			lines.push(
				railLine(
					RAIL.body,
					"border",
					truncate(
						`${from} ${ACTIVE} ${to}${selected.taskId ? ` (${selected.taskId})` : ""} · ${selected.status ?? "?"}`,
						budget,
					),
					theme,
					budget,
				),
			);
			for (const line of (selected.body ?? "").split(/\r?\n/)) {
				lines.push(railLine(RAIL.body, "border", truncate(line, budget), theme, budget));
			}
		}

		if (!this.inbox.length && !this.outbox.length) {
			lines.push(railLine(RAIL.body, "border", theme.fg("dim", "Mailbox is empty."), theme, budget));
		}

		const actions = formatHint([
			["tab", "side"],
			[["up", "down"], "select"],
			["enter", "expand"],
			["A", "ack"],
			["N", "nudge"],
			["C", "compose"],
			["X", "ack all"],
		]);
		const close = formatHint([["escape", "close"]]);
		lines.push(
			railLine(RAIL.close, "border", railLeaders(theme.fg("dim", actions), theme.fg("dim", close), budget, theme), theme, budget),
		);
		return lines;
	}

	private row(message: MailboxMessage | undefined, side: "inbox" | "outbox", index: number, width: number): string {
		if (!message) return "";
		const marker = this.side === side && this.selected === index ? CURSOR : " ";
		const acknowledged = message.status === "acknowledged";
		const status = this.theme.fg(acknowledged ? "success" : "warning", acknowledged ? "✓" : "!");
		const from = message.from ?? "?";
		const to = message.to ?? "?";
		const body = (message.body ?? "").replace(/\s+/g, " ");
		return truncate(`${marker}${status} ${from} ${ACTIVE} ${to}: ${body}`, width);
	}

	handleInput(data: string): void {
		// M2-1: keys come from the central `overlay:*` keyspace (remappable via
		// `.crew/config.json` → keybindings["overlay:mailbox-detail:<action>"]).
		switch (overlayActionForKey("mailbox-detail", data)) {
			case "close":
				this.done({ type: "close" });
				return;
			case "toggleSide":
				this.side = this.side === "inbox" ? "outbox" : "inbox";
				this.selected = Math.min(this.selected, Math.max(0, this.current().length - 1));
				return;
			case "up":
				this.selected = Math.max(0, this.selected - 1);
				return;
			case "down":
				this.selected = Math.min(Math.max(0, this.current().length - 1), this.selected + 1);
				return;
			case "toggleDetail":
				this.expanded = !this.expanded;
				return;
			case "ack": {
				const message = this.selectedMessage();
				if (message) this.done({ type: "ack", messageId: message.id });
				return;
			}
			case "nudge":
				this.done({
					type: "nudge",
					agentId: this.selectedMessage()?.taskId,
				});
				return;
			case "compose":
				this.done({ type: "compose" });
				return;
			case "ackAll":
				this.done({ type: "ackAll" });
				return;
		}
	}
}
