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
 * R3-6 (IME): the ACTIVE field emits pi-tui's zero-width `CURSOR_MARKER` at
 * its value end — the host TUI strips it and parks the hardware cursor there
 * so the IME candidate window follows the logical text cursor (CJK input).
 *
 * Keys/behaviour are unchanged (same `overlay:*` dispatch, same free-text
 * passthrough, same validation errors, same discard confirmation). Hints come
 * from `formatHint` (discard LAST, keys through `keyToken`).
 */

import * as piTui from "@earendil-works/pi-tui";
import type { MailboxDirection } from "../../state/coordination/mailbox.ts";
import { pad, sanitizeLine, truncate } from "../../utils/visual.ts";
import { overlayActionForKey } from "../keybinding-map.ts";
import { CURSOR, canopyLine, formatHint, RAIL, railLine, railRaw } from "../rail.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";
import { ConfirmOverlay } from "./confirm-overlay.ts";
import { renderComposePreview } from "./mailbox-compose-preview.ts";

/** Resolve pi-tui's zero-width IME cursor anchor defensively (L8, policy
 *  W4/G22) — same typeof-guard shape as hyperlink() at widget-renderer.ts:
 *  118-128 and the sibling resolver in settings-overlay.ts. The peer range is
 *  `*`, so a host running a pi-tui build without the export must still render
 *  instead of failing the named import at link time. Exported for the
 *  fallback pin in test/unit/ui/settings-overlay-cursor-marker.test.ts. */
export function resolveCursorMarker(mod: unknown): string {
	const candidate = (mod as { CURSOR_MARKER?: unknown }).CURSOR_MARKER;
	return typeof candidate === "string" ? candidate : "";
}

/** "" on hosts whose pi-tui predates CURSOR_MARKER — the active field then
 *  renders without the IME anchor (marker is zero-width, stripped before
 *  painting; pure enhancement, never a layout dependency). */
const CURSOR_MARKER = resolveCursorMarker(piTui);

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
		// R3-6 (IME): CURSOR_MARKER is pi-tui's zero-width APC sequence — the host
		// TUI finds it, positions the HARDWARE cursor there (IME candidate window
		// anchor for CJK input), and strips it before painting. This overlay's
		// fields append/backspace at end-of-value only, so the logical cursor IS
		// the value end — same pattern as pi-tui's own Input component
		// (marker + fake cursor). The `›` prefix stays: it is the RAIL list-selection
		// glyph, orthogonal to the text cursor. Direction checkbox row gets NO
		// marker — it toggles on space and has no text insertion point.
		const marker = active && !this.confirm ? CURSOR_MARKER : "";
		return `${active ? CURSOR : " "} ${label}: ${truncate(value, Math.max(8, width - label.length - 5))}${marker}`;
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
