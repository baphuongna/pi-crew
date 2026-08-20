/**
 * crew-editor.ts — the inline agent panel's keyboard half.
 *
 * A `CustomEditor` wrapper (pi-subtask's `SubtaskEditor` pattern): pressing
 * `↓` on an empty prompt moves the cursor into the agent rows rendered by the
 * crew widget; `↑`/`↓` navigate, `enter` opens the agent's transcript pane,
 * `x` cancels/dismisses, `escape` returns to typing.
 *
 * The pane is an in-document widget, NOT an overlay, so this editor keeps pi's
 * real focus: while the pane is open, typed text goes to the viewed agent
 * (Claude Code's `@name` convention — the editor border is relabeled) and the
 * main conversation's editor stays functional underneath.
 *
 * Every unhandled key falls through to `super.handleInput`, so the user is
 * never trapped in a mode. All state lives in panel-store (shared with the
 * widget renderer); this class only translates keys into state changes and
 * host calls.
 */

import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { PanelKeys, PanelTarget } from "./panel-selection.ts";
import { dispatchPanelKey } from "./panel-selection.ts";
import { getPanelSelection, getViewedAgent, panelRows, setPanelSelection } from "./panel-store.ts";

export const AGENT_LABEL_MAX = 24;

export interface CrewEditorOptions {
	/** Open the transcript pane on the given agent. */
	onOpenPane: (target: PanelTarget) => void;
	/** Close the pane and return to the main conversation. */
	onClosePane: () => void;
	/** Scroll the open pane by ±wrapped lines. */
	onScrollPane: (delta: number) => void;
	/** Steer the viewed agent with the typed message. */
	onSteer: (target: PanelTarget, message: string) => void;
	/** `x`: cancel a running agent's run, or dismiss a finished one. */
	onAct: (target: PanelTarget, finished: boolean) => void;
}

export class CrewInlineEditor extends CustomEditor {
	private readonly options: CrewEditorOptions;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options: CrewEditorOptions) {
		super(tui, theme, keybindings);
		this.options = options;
	}

	private panelKeys(data: string): PanelKeys {
		return {
			up: matchesKey(data, "up"),
			down: matchesKey(data, "down"),
			enter: matchesKey(data, "return"),
			escape: matchesKey(data, "escape"),
			act: matchesKey(data, "x"),
		};
	}

	/**
	 * Apply a dispatch result. `closePaneOnMain` is true while the pane is open:
	 * `enter` on the main row then returns to the conversation instead of doing
	 * nothing.
	 */
	private applyDispatch(data: string, rows: ReturnType<typeof panelRows>, keys: PanelKeys, closePaneOnMain: boolean): void {
		const selection = getPanelSelection();
		const result = dispatchPanelKey(keys, rows, selection, { holdAtMain: closePaneOnMain });
		switch (result.action.kind) {
			case "none": {
				// Not a navigation key: hand the editor the exact key and clear
				// the cursor so typing proceeds normally (pi-subtask §2.5).
				setPanelSelection(null);
				super.handleInput(data);
				return;
			}
			case "consumed": {
				setPanelSelection(result.selection);
				return;
			}
			case "open": {
				setPanelSelection(null);
				const target = result.action.target;
				if (target) this.options.onOpenPane(target);
				else if (closePaneOnMain) this.options.onClosePane();
				return;
			}
			case "act": {
				setPanelSelection(result.selection);
				const target = result.action.target;
				const row = rows.find((r) => r.runId === target.runId && r.taskId === target.taskId);
				this.options.onAct(target, row?.finished ?? false);
				return;
			}
		}
	}

	handleInput(data: string): void {
		const rows = panelRows();
		const viewed = getViewedAgent();

		// ── Pane open: typing goes to the viewed agent ─────────────────────
		if (viewed) {
			// Navigation still works inside the pane: move the cursor over the
			// rows and `enter` switches the pane to another agent (or to main).
			if (getPanelSelection() !== null) {
				this.applyDispatch(data, rows, this.panelKeys(data), true);
				return;
			}
			if (matchesKey(data, "down") && this.getText() === "" && rows.length > 0) {
				setPanelSelection("main");
				return;
			}
			if (matchesKey(data, "escape")) {
				this.options.onClosePane();
				return;
			}
			if (matchesKey(data, "pageUp")) {
				this.options.onScrollPane(10);
				return;
			}
			if (matchesKey(data, "pageDown")) {
				this.options.onScrollPane(-10);
				return;
			}
			if (matchesKey(data, "return")) {
				const text = (this.getExpandedText?.() ?? this.getText()).trim();
				if (!text) {
					// Empty enter: hand it back to the editor rather than
					// swallowing the key (keeps the "never stick" contract).
					super.handleInput(data);
					return;
				}
				if (text.startsWith("/")) {
					// Built-in commands still act on the main session.
					super.handleInput(data);
					return;
				}
				// Shift+Enter (newline) never reaches here: matchesKey
				// distinguishes the shifted sequence from plain return.
				this.setText("");
				this.options.onSteer(viewed, text);
				return;
			}
			super.handleInput(data);
			return;
		}

		// ── Idle: `↓` on an empty prompt enters the panel ──────────────────
		if (getPanelSelection() === null) {
			if (matchesKey(data, "down") && this.getText() === "" && rows.length > 0) {
				// dispatch selects the FIRST AGENT (not `main`) so the very
				// first press paints the ❯ marker — visible feedback, matching
				// pi-subtask's selectRow(rows, 0).
				const result = dispatchPanelKey(this.panelKeys(data), rows, null);
				setPanelSelection(result.selection);
				return;
			}
			super.handleInput(data);
			return;
		}

		// ── Navigating: consume or fall through ────────────────────────────
		this.applyDispatch(data, rows, this.panelKeys(data), false);
	}

	/**
	 * Relabel the editor's top border with the viewed agent, so it is
	 * unambiguous where typed text lands — pi-subtask's `@name` marker.
	 */
	render(width: number): string[] {
		const lines = super.render(width);
		const viewed = getViewedAgent();
		if (viewed && lines.length > 0) {
			const rows = panelRows();
			const row = rows.find((r) => r.runId === viewed.runId && r.taskId === viewed.taskId);
			const name = row?.name ?? viewed.taskId.slice(-AGENT_LABEL_MAX);
			const label = ` @${truncateToWidth(name.replace(/\s+/g, " "), AGENT_LABEL_MAX)} `;
			const labelWidth = visibleWidth(label);
			if (visibleWidth(lines[0]) >= labelWidth + 4) {
				lines[0] = truncateToWidth(lines[0], width - labelWidth - 2, "") + label + "──";
			}
		}
		return lines;
	}
}
