import type { MailboxDirection } from "../../state/coordination/mailbox.ts";
import { pad, truncate } from "../../utils/visual.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";
import { ConfirmOverlay } from "./confirm-overlay.ts";
import { renderComposePreview } from "./mailbox-compose-preview.ts";

export interface MailboxComposePayload {
	from: string;
	to: string;
	body: string;
	taskId?: string;
	direction: MailboxDirection;
}

export type MailboxComposeResult = { type: "submit"; payload: MailboxComposePayload } | { type: "cancel" };

type FieldName = "from" | "to" | "body" | "taskId" | "direction";

const FIELD_ORDER: FieldName[] = ["from", "to", "body", "taskId", "direction"];

export class MailboxComposeOverlay {
	private readonly done: (result: MailboxComposeResult) => void;
	private readonly theme: CrewTheme;
	private fields: MailboxComposePayload = {
		from: "operator",
		to: "leader",
		body: "",
		direction: "inbox",
	};
	private activeField = 1;
	private error: string | undefined;
	private preview = false;
	private confirm: ConfirmOverlay | undefined;

	constructor(opts: {
		done: (result: MailboxComposeResult) => void;
		theme?: unknown;
		initial?: Partial<MailboxComposePayload>;
	}) {
		this.done = opts.done;
		this.theme = asCrewTheme(opts.theme ?? {});
		this.fields = { ...this.fields, ...opts.initial };
	}

	invalidate(): void {
		// State is updated synchronously from input.
	}

	render(width: number): string[] {
		if (this.confirm) return this.confirm.render(width);
		const inner = Math.max(24, width - 4);
		const formWidth = this.preview ? Math.max(24, Math.floor(inner * 0.6)) : inner;
		const lines = [
			this.theme.bold("Compose mailbox message"),
			this.preview
				? "P close preview · Tab cycle · Enter submit · ESC discard"
				: "P preview · Tab cycle · Enter submit · ESC discard",
			...(this.error ? [this.theme.fg("error", this.error)] : []),
			this.fieldLine("from", formWidth),
			this.fieldLine("to", formWidth),
			this.fieldLine("body", formWidth),
			this.fieldLine("taskId", formWidth),
			`${this.activeField === 4 ? "›" : " "} [${this.fields.direction === "outbox" ? "x" : " "}] Send to outbox`,
		];
		if (!this.preview) return lines.map((line) => pad(truncate(line, inner), inner));
		const previewLines = renderComposePreview(this.fields.body, Math.max(20, inner - formWidth - 3), this.theme);
		const max = Math.max(lines.length, previewLines.length);
		const split: string[] = [];
		for (let index = 0; index < max; index += 1) {
			split.push(
				`${pad(truncate(lines[index] ?? "", formWidth), formWidth)} │ ${truncate(previewLines[index] ?? "", inner - formWidth - 3)}`,
			);
		}
		return split;
	}

	private fieldLine(field: Exclude<FieldName, "direction">, width: number): string {
		const active = FIELD_ORDER[this.activeField] === field;
		const label = field === "taskId" ? "taskId" : field;
		return `${active ? "›" : " "} ${label}: ${truncate(this.fields[field] ?? "", Math.max(8, width - label.length - 5))}`;
	}

	private activeName(): FieldName {
		return FIELD_ORDER[this.activeField] ?? "body";
	}

	private appendText(data: string): void {
		const field = this.activeName();
		if (field === "direction") return;
		this.fields = {
			...this.fields,
			[field]: `${this.fields[field] ?? ""}${data}`,
		};
		this.error = undefined;
	}

	private backspace(): void {
		const field = this.activeName();
		if (field === "direction") return;
		this.fields = {
			...this.fields,
			[field]: (this.fields[field] ?? "").slice(0, -1),
		};
	}

	private submit(): void {
		const body = this.fields.body.trim();
		if (!body) {
			this.error = "Body is required.";
			return;
		}
		if (!this.fields.to.trim()) {
			this.error = "Recipient is required.";
			return;
		}
		this.done({
			type: "submit",
			payload: {
				...this.fields,
				from: this.fields.from.trim() || "operator",
				to: this.fields.to.trim(),
				body,
				taskId: this.fields.taskId?.trim() || undefined,
			},
		});
	}

	private cancel(): void {
		if (this.fields.body.length <= 50) {
			this.done({ type: "cancel" });
			return;
		}
		this.confirm = new ConfirmOverlay(
			{
				title: "Discard draft?",
				body: `Body has ${this.fields.body.length} chars. Y=discard, N=continue editing`,
				dangerLevel: "medium",
				defaultAction: "cancel",
			},
			(confirmed) => {
				this.confirm = undefined;
				if (confirmed) this.done({ type: "cancel" });
			},
			this.theme,
		);
	}

	handleInput(data: string): void {
		if (this.confirm) {
			this.confirm.handleInput(data);
			return;
		}
		if (data === "\u001b") {
			this.cancel();
			return;
		}
		if (data === "P") {
			this.preview = !this.preview;
			return;
		}
		if (data === "\t") {
			this.activeField = (this.activeField + 1) % FIELD_ORDER.length;
			return;
		}
		if (data === " ") {
			if (this.activeName() === "direction") this.fields.direction = this.fields.direction === "inbox" ? "outbox" : "inbox";
			else this.appendText(data);
			return;
		}
		if (data === "\b" || data === "\u007f") {
			this.backspace();
			return;
		}
		if (data === "\r" || data === "\n") {
			if (this.activeName() === "body" || this.fields.body.trim()) this.submit();
			else this.activeField = (this.activeField + 1) % FIELD_ORDER.length;
			return;
		}
		if (data.length === 1 && data >= " ") this.appendText(data);
	}
}
