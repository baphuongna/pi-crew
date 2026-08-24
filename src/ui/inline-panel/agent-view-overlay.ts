/**
 * agent-view-overlay.ts — the agent view as a FULL-SCREEN, separate surface.
 *
 * Opened through `ctx.ui.custom(..., { overlay: true })` with width "100%"
 * and zero margins, so viewing an agent TAKES OVER the terminal instead of
 * flowing under the main transcript: what the user sees is that agent's live
 * session and nothing else. The main session keeps running underneath (its
 * editor, widgets and run state are untouched) and comes back the moment the
 * overlay closes — no session is switched, resumed, or torn down, so a view
 * can never kill a run.
 *
 * Keyboard (the overlay captures focus while open):
 *   esc / q / ctrl+c   close, back to the main conversation
 *   pgup / pgdn / ↑ ↓ / j k / g G   scroll the transcript
 *   tab / shift+tab    switch to the next / previous agent in place
 *   i                  steer input — enter sends to the viewed agent, esc cancels
 *
 * The transcript itself is `CrewAgentPane` (shared with the widget-mode
 * view): pi's own message/tool components, disk-tailed live, per-assistant
 * usage footers — session parity, full height.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";
import { CrewAgentPane } from "./agent-pane.ts";
import type { PanelTarget } from "./panel-selection.ts";
import { getViewedAgent, panelRows, setViewedAgent } from "./panel-store.ts";

export interface CrewAgentOverlayOptions {
	/** Close the view and restore the main conversation. */
	close(): void;
	/** Deliver a steer message to the viewed agent. */
	steer(target: PanelTarget, message: string): void;
}

const INPUT_PROMPT = " ❯ ";

/** Printable single keypress or paste chunk: no control bytes, no ESC
 *  sequences (arrow keys etc. must not land in the steer text). */
function isPrintableInput(data: string): boolean {
	return data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data);
}

export class CrewAgentOverlay {
	/** The transcript core; exposed so the host can wire scroll/steer keys. */
	readonly pane: CrewAgentPane;

	private disposed = false;
	private inputMode = false;
	private inputText = "";
	private closed = false;
	private tui: TUI;
	private theme: CrewTheme;
	private readonly options: CrewAgentOverlayOptions;

	constructor(tui: TUI, theme: Theme, cwd: string, options: CrewAgentOverlayOptions) {
		this.tui = tui;
		this.theme = asCrewTheme(theme);
		this.options = options;
		this.pane = new CrewAgentPane(tui, theme, cwd, {
			// Fill the terminal: overlay chrome (hint + optional input row)
			// plus the pane's own header/border/indicator lines.
			maxBodyLines: (headerLines) => this.availableBodyLines(headerLines),
		});
	}

	/** Idempotent: the escape key and the host's close path share this. */
	requestClose(): void {
		if (this.closed) return;
		this.closed = true;
		this.options.close();
	}

	requestRender(): void {
		if (!this.disposed) this.tui.requestRender();
	}

	private chromeLines(): number {
		return 1 /* hint */ + (this.inputMode ? 1 /* input row */ : 0);
	}

	private availableBodyLines(headerLines: number): number {
		const rows = this.tui.terminal.rows;
		// pane self-chrome: border + spacer/"more" indicator (+1 slack for the
		// bottom "↓ more" indicator that appears while scrolled).
		return Math.max(4, rows - headerLines - 4 - this.chromeLines());
	}

	private hintLine(width: number): string {
		if (this.inputMode) {
			return this.theme.fg("dim", truncateToWidth(" enter send · esc cancel steer", width, "…"));
		}
		const viewed = getViewedAgent();
		const rows = panelRows();
		const row = viewed ? rows.find((r) => r.runId === viewed.runId && r.taskId === viewed.taskId) : undefined;
		const label = row?.name ? `@${row.name.replace(/\s+/g, " ")}` : "agent";
		const multi = rows.length > 1 ? " · tab agent" : "";
		return this.theme.fg("dim", truncateToWidth(` viewing ${label}${multi} · pgup/pgdn scroll · i steer · esc back`, width, "…"));
	}

	private inputLine(width: number): string {
		const text = `${INPUT_PROMPT}${this.inputText}▏`;
		return this.theme.fg("accent", truncateToWidth(text, width, "…"));
	}

	/** Switch the view to the next (delta=+1) or previous (delta=-1) agent. */
	private cycleAgent(delta: 1 | -1): void {
		const rows = panelRows();
		if (rows.length === 0) return;
		const viewed = getViewedAgent();
		const index = viewed ? rows.findIndex((r) => r.runId === viewed.runId && r.taskId === viewed.taskId) : -1;
		const next = rows[(((index + delta) % rows.length) + rows.length) % rows.length];
		if (!next) return;
		if (viewed && next.runId === viewed.runId && next.taskId === viewed.taskId) return;
		setViewedAgent({ runId: next.runId, taskId: next.taskId });
		this.pane.requestRender();
	}

	private sendSteer(): void {
		const text = this.inputText.trim();
		const viewed = getViewedAgent();
		this.inputMode = false;
		this.inputText = "";
		if (!text || !viewed) return;
		this.options.steer(viewed, text);
	}

	handleInput(data: string): void {
		if (this.disposed || this.closed) return;

		if (this.inputMode) {
			if (matchesKey(data, "escape")) {
				this.inputMode = false;
				this.inputText = "";
			} else if (matchesKey(data, "return")) {
				this.sendSteer();
			} else if (matchesKey(data, "backspace")) {
				this.inputText = this.inputText.slice(0, -1);
			} else if (data === "\x03") {
				// ctrl+c inside steer input cancels the input, not the view.
				this.inputMode = false;
				this.inputText = "";
			} else if (isPrintableInput(data)) {
				// Printable (including multi-byte UTF-8 and bracketed paste).
				this.inputText += data;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape") || data === "\x03") {
			this.requestClose();
			return;
		}
		if (data === "q") {
			this.requestClose();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.pane.scrollBy(10);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.pane.scrollBy(-10);
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.pane.scrollBy(1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.pane.scrollBy(-1);
			return;
		}
		if (data === "g" || matchesKey(data, "home")) {
			this.pane.scrollHome();
			return;
		}
		if (data === "G" || matchesKey(data, "end")) {
			this.pane.scrollEnd();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.cycleAgent(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.cycleAgent(-1);
			return;
		}
		if (data === "i") {
			this.inputMode = true;
			this.inputText = "";
			this.tui.requestRender();
			return;
		}
		// Everything else (incl. kitty release events) is ignored — the view
		// never leaks keys into the main editor underneath.
	}

	render(width: number): string[] {
		if (this.disposed || this.closed) return [];

		const rows = this.tui.terminal.rows;
		const lines = this.pane.render(width);
		// Pad so the overlay always covers the full terminal — the session
		// underneath must not bleed through on short transcripts.
		const bodyBudget = rows - this.chromeLines();
		while (lines.length < bodyBudget) lines.push("");
		if (lines.length > bodyBudget) lines.length = bodyBudget;
		if (this.inputMode) lines.push(this.inputLine(width));
		lines.push(this.hintLine(width));
		return lines.slice(0, Math.max(1, rows));
	}

	invalidate(): void {
		this.pane.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.pane.dispose();
	}
}
