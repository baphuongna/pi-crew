import { type MailboxMessage, readDeliveryState, readMailbox } from "../../state/coordination/mailbox.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import { pad, truncate } from "../../utils/visual.ts";
import { keyOf } from "../key-utils.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";

export type MailboxAction =
	| { type: "ack"; messageId: string }
	| { type: "nudge"; agentId?: string }
	| { type: "compose" }
	| { type: "ackAll" }
	| { type: "close" };

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
		const inner = Math.max(40, width - 4);
		const col = Math.max(18, Math.floor((inner - 3) / 2));
		const lines = [
			this.theme.bold(`Mailbox detail · ${this.runId}`),
			"Tab side · ↑/↓ select · Enter expand · A ack · N nudge · C compose · X ack all · ESC close",
			`${pad(this.theme.bold("Inbox"), col)} │ ${pad(this.theme.bold("Outbox"), col)}`,
		];
		const max = Math.max(this.inbox.length, this.outbox.length, 1);
		for (let index = 0; index < Math.min(max, 12); index += 1) {
			lines.push(`${this.row(this.inbox[index], "inbox", index, col)} │ ${this.row(this.outbox[index], "outbox", index, col)}`);
		}
		const selected = this.selectedMessage();
		if (this.expanded && selected) {
			lines.push("─".repeat(Math.min(inner, 72)));
			lines.push(`${selected.from} → ${selected.to}${selected.taskId ? ` (${selected.taskId})` : ""} · ${selected.status}`);
			lines.push(...selected.body.split(/\r?\n/).map((line) => truncate(line, inner)));
		}
		if (!this.inbox.length && !this.outbox.length) lines.push("Mailbox is empty.");
		return lines.map((line) => truncate(line, inner));
	}

	private row(message: MailboxMessage | undefined, side: "inbox" | "outbox", index: number, width: number): string {
		if (!message) return pad("", width);
		const marker = this.side === side && this.selected === index ? "›" : " ";
		const status = message.status === "acknowledged" ? "✓" : "!";
		return pad(truncate(`${marker}${status} ${message.from}->${message.to}: ${message.body.replace(/\s+/g, " ")}`, width), width);
	}

	handleInput(data: string): void {
		if (data === "\u001b" || data === "q") {
			this.done({ type: "close" });
			return;
		}
		if (data === "\t") {
			this.side = this.side === "inbox" ? "outbox" : "inbox";
			this.selected = Math.min(this.selected, Math.max(0, this.current().length - 1));
			return;
		}
		if (data === "k" || keyOf(data) === "up") {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (data === "j" || keyOf(data) === "down") {
			this.selected = Math.min(Math.max(0, this.current().length - 1), this.selected + 1);
			return;
		}
		if (data === "\r" || data === "\n") {
			this.expanded = !this.expanded;
			return;
		}
		if (data === "A") {
			const message = this.selectedMessage();
			if (message) this.done({ type: "ack", messageId: message.id });
			return;
		}
		if (data === "N") {
			this.done({
				type: "nudge",
				agentId: this.selectedMessage()?.taskId,
			});
			return;
		}
		if (data === "C") {
			this.done({ type: "compose" });
			return;
		}
		if (data === "X") this.done({ type: "ackAll" });
	}
}
