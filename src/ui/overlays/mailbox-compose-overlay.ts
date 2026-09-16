/**
 * Mailbox compose overlay — RAIL design language (M4/E1, 2026-09-16).
 *
 *   ┏ COMPOSE ▸ mailbox
 *   ┃ › from: operator                    │ Preview
 *   ┃ › to: leader                        │ # Title
 *   ┃ › body: hello                       │ • item
 *   ┃ › taskId:                           │
 *   ┃ › [ ] Send to outbox                │
 *   ┗ P close preview · Tab cycle · Enter submit · Esc discard
 *
 * Frame: canopy + `┃` body + `┗` close cap. When the preview is on, the body is
 * a genuine two-column layout and `│` is the inner COLUMN separator (§2.D); the
 * canopy/hint rows are NOT part of the split any more, so the hint keeps its
 * full width instead of being cropped to 60% of the overlay.
 *
 * Keys/behaviour are unchanged (same `overlay:*` dispatch, same free-text
 * passthrough, same validation errors, same discard confirmation). Hints come
 * from `formatHint` (discard LAST, keys through `keyToken`).
 */

import type { MailboxDirection } from "../../state/coordination/mailbox.ts";
import { pad, sanitizeLine, truncate } from "../../utils/visual.ts";
import { overlayActionForKey } from "../keybinding-map.ts";
import { CURSOR, canopyLine, formatHint, RAIL, railLine, railRaw } from "../rail.ts";
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
		if (width < 10) return [];
		const theme = this.theme;
		const budget = width - 2;
		const hint = formatHint([
			["P", this.preview ? "close preview" : "preview"],
			["tab", "cycle"],
			["enter", "submit"],
			["escape", "discard"],
		]);
		const lines: string[] = [canopyLine({ word: "COMPOSE", subject: "mailbox", theme, budget })];
		if (this.error) lines.push(railLine(RAIL.body, "error", truncate(this.error, budget), theme, budget));

		const formBudget = this.preview ? Math.max(10, Math.floor(budget * 0.6)) : budget;
		const previewBudget = Math.max(8, budget - formBudget - 3);
		const formRows = [
			this.fieldLine("from", formBudget),
			this.fieldLine("to", formBudget),
			this.fieldLine("body", formBudget),
			this.fieldLine("taskId", formBudget),
			`${this.activeField === 4 ? CURSOR : " "} [${this.fields.direction === "outbox" ? "x" : " "}] Send to outbox`,
		];
		if (!this.preview) {
			for (const row of formRows) lines.push(railLine(RAIL.body, "border", truncate(row, budget), theme, budget));
		} else {
			const previewLines = renderComposePreview(this.fields.body, previewBudget, theme);
			const max = Math.max(formRows.length, previewLines.length);
			for (let index = 0; index < max; index += 1) {
				const left = pad(truncate(formRows[index] ?? "", formBudget), formBudget);
				const right = truncate(previewLines[index] ?? "", previewBudget);
				// No separator when the preview column has no row at this height:
				// a `│` with nothing to its right reads as a frame edge.
				lines.push(railRaw(RAIL.body, "border", right ? `${left} ${theme.fg("dim", "│")} ${right}` : left, theme));
			}
		}
		lines.push(railLine(RAIL.close, "border", theme.fg("dim", hint), theme, budget));
		return lines;
	}

	private fieldLine(field: Exclude<FieldName, "direction">, width: number): string {
		const active = FIELD_ORDER[this.activeField] === field;
		const label = field === "taskId" ? "taskId" : field;
		// `sanitizeLine`: a pasted / pre-filled value can carry a raw newline or
		// TAB — printing it verbatim would break the rail row into several lines
		// (the field is a single-line cell; multi-line content belongs to the
		// preview column).
		const value = sanitizeLine(this.fields[field] ?? "");
		return `${active ? CURSOR : " "} ${label}: ${truncate(value, Math.max(8, width - label.length - 5))}`;
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
		// M2-1: keys come from the central `overlay:*` keyspace (remappable via
		// `.crew/config.json` → keybindings["overlay:mailbox-compose:<action>"]).
		switch (overlayActionForKey("mailbox-compose", data)) {
			case "cancel":
				this.cancel();
				return;
			case "preview":
				this.preview = !this.preview;
				return;
			case "nextField":
				this.activeField = (this.activeField + 1) % FIELD_ORDER.length;
				return;
			case "space":
				if (this.activeName() === "direction") this.fields.direction = this.fields.direction === "inbox" ? "outbox" : "inbox";
				else this.appendText(data);
				return;
			case "backspace":
				this.backspace();
				return;
			case "submit":
				if (this.activeName() === "body" || this.fields.body.trim()) this.submit();
				else this.activeField = (this.activeField + 1) % FIELD_ORDER.length;
				return;
		}
		// Free-text passthrough (unchanged): any other printable char is typed
		// into the active field.
		if (data.length === 1 && data >= " ") this.appendText(data);
	}
}
