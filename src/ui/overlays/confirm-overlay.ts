/**
 * Confirm dialog overlay — RAIL design language (M4/E1, 2026-09-16).
 *
 *   ┏ CONFIRM ▸ Delete?
 *   ┃ Danger
 *   ┗ Y confirm · N/Esc cancel
 *
 * The rounded `╭─╮├─┤│╰─╯` box (and its inline `├───┤` rules) is retired; the
 * surface is now canopy / `┃` body / `┗` close cap. The rail colour carries the
 * danger level (high → error, medium → warning, else neutral border) instead of
 * colouring only the title, and the hint is built by `formatHint` (cancel LAST,
 * keys through `keyToken` → `Esc`, never `ESC`).
 *
 * Keys/behaviour are unchanged: same `overlay:*` keyspace dispatch, Enter stays
 * dual-role exactly as before.
 */

import { truncate } from "../../utils/visual.ts";
import { overlayActionForKey } from "../keybinding-map.ts";
import { canopyLine, formatHint, RAIL, type RailSlot, railLine } from "../rail.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";

export interface ConfirmOptions {
	title: string;
	body?: string;
	dangerLevel?: "low" | "medium" | "high";
	defaultAction?: "confirm" | "cancel";
}

export class ConfirmOverlay {
	private readonly opts: ConfirmOptions;
	private readonly done: (confirmed: boolean) => void;
	private readonly theme: CrewTheme;

	constructor(opts: ConfirmOptions, done: (confirmed: boolean) => void, theme: unknown = {}) {
		this.opts = opts;
		this.done = done;
		this.theme = asCrewTheme(theme);
	}

	invalidate(): void {
		// Stateless overlay.
	}

	render(width: number): string[] {
		if (width < 6) return [];
		const theme = this.theme;
		const budget = width - 2;
		// Rail colour = state (§1): the danger level is the state of a confirm.
		const slot: RailSlot = this.opts.dangerLevel === "high" ? "error" : this.opts.dangerLevel === "medium" ? "warning" : "border";
		const hint =
			this.opts.defaultAction === "confirm"
				? formatHint([
						[["enter", "y"], "confirm"],
						[["n", "escape"], "cancel"],
					])
				: formatHint([
						["y", "confirm"],
						[["enter", "n", "escape"], "cancel"],
					]);
		const bodyLines = (this.opts.body ?? "").split(/\r?\n/).filter(Boolean);
		const lines: string[] = [canopyLine({ word: "CONFIRM", subject: this.opts.title ?? "?", theme, budget, slot })];
		for (const line of bodyLines.length ? bodyLines : ["Are you sure?"]) {
			lines.push(railLine(RAIL.body, slot, truncate(line, budget), theme, budget));
		}
		lines.push(railLine(RAIL.close, slot, theme.fg("dim", hint), theme, budget));
		return lines;
	}

	handleInput(data: string): void {
		// M2-1: keys come from the central `overlay:*` keyspace (remappable via
		// `.crew/config.json` → keybindings["overlay:confirm:<action>"]).
		switch (overlayActionForKey("confirm", data)) {
			case "confirm":
				this.done(true);
				return;
			// Enter is dual-role: it confirms when the overlay defaults to confirm
			// and cancels otherwise (byte-identical to the pre-M2-1 chain).
			case "submit":
				this.done(this.opts.defaultAction === "confirm");
				return;
			case "cancel":
				this.done(false);
				return;
		}
	}
}
