import { pad, truncate } from "../../utils/visual.ts";
import { matchesKey } from "../key-utils.ts";
import { Box, Text } from "../layout-primitives.ts";
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
		const innerWidth = Math.max(24, Math.min(width - 4, 72));
		const color = this.opts.dangerLevel === "high" ? "error" : this.opts.dangerLevel === "medium" ? "warning" : "accent";
		const title = this.theme.bold(this.theme.fg(color, this.opts.title));
		const hint = this.opts.defaultAction === "confirm" ? "Enter/Y confirm · N/ESC cancel" : "Y confirm · Enter/N/ESC cancel";
		const bodyLines = (this.opts.body ?? "").split(/\r?\n/).filter(Boolean);
		const lines = [
			`╭${"─".repeat(innerWidth)}╮`,
			`│ ${pad(truncate(title, innerWidth - 1), innerWidth - 1)}│`,
			`├${"─".repeat(innerWidth)}┤`,
			...(bodyLines.length ? bodyLines : ["Are you sure?"]).map(
				(line) => `│ ${pad(truncate(line, innerWidth - 1), innerWidth - 1)}│`,
			),
			`├${"─".repeat(innerWidth)}┤`,
			`│ ${pad(truncate(this.theme.fg("dim", hint), innerWidth - 1), innerWidth - 1)}│`,
			`╰${"─".repeat(innerWidth)}╯`,
		];
		const box = new Box(0, 0);
		for (const line of lines) box.addChild(new Text(line));
		return box.render(width);
	}

	handleInput(data: string): void {
		if (data === "y" || data === "Y") {
			this.done(true);
			return;
		}
		if (matchesKey(data, "return") && this.opts.defaultAction === "confirm") {
			this.done(true);
			return;
		}
		if (data === "n" || data === "N" || matchesKey(data, "escape") || data === "q" || matchesKey(data, "return")) this.done(false);
	}
}
