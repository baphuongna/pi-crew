/**
 * panel-selection.ts — pure cursor state machine for the inline agent panel.
 *
 * No I/O, no TUI types: the editor wrapper feeds it a key and the current row
 * list, and gets back an action to perform. That keeps the whole navigation
 * contract unit-testable against a synthetic row list.
 *
 * Row 0 is always `main` (the conversation itself); agents occupy 1..n.
 *
 * The cursor is stored as an **identity**, not an index. Rows reorder while the
 * user is navigating — a cancelled agent sinks from the active section into the
 * finished one — and an index cursor would silently retarget whichever agent
 * took the vacated row. Storing the taskId means a second keystroke acts on the
 * same agent the first one did.
 */

/** A concrete agent the panel can act on. */
export interface PanelTarget {
	runId: string;
	taskId: string;
}

/** One navigable agent row, as projected from the widget's run list. */
export interface PanelRow extends PanelTarget {
	/** Terminal statuses are dismissed by `x`; live ones are cancelled. */
	finished: boolean;
	/** Agent name, used for the editor's `@<name>` label while its pane is open. */
	name: string;
}

/**
 * `null` means the editor owns the cursor (normal typing). `"main"` is the
 * conversation row. Anything else is an agent.
 */
export type PanelSelection = "main" | PanelTarget | null;

export type PanelAction =
	/** Not a navigation key — the caller must forward it to the editor. */
	| { kind: "none" }
	/** Cursor moved or selection cleared; repaint and swallow the key. */
	| { kind: "consumed" }
	/** `enter`: open the target's pane, or return to `main` when undefined. */
	| { kind: "open"; target: PanelTarget | undefined }
	/** `x`: cancel a running agent, or dismiss a finished one. */
	| { kind: "act"; target: PanelTarget };

export interface PanelKeys {
	up: boolean;
	down: boolean;
	enter: boolean;
	escape: boolean;
	act: boolean;
}

export interface DispatchOptions {
	/**
	 * When true, `up` at the main row keeps the cursor there instead of handing
	 * focus back to the editor. Used while a transcript pane is open, so one
	 * `down` + `enter` is always a reliable way back to the conversation.
	 */
	holdAtMain?: boolean;
}

export interface DispatchResult {
	action: PanelAction;
	selection: PanelSelection;
}

function sameTarget(a: PanelTarget, b: PanelTarget): boolean {
	return a.runId === b.runId && a.taskId === b.taskId;
}

/** True when `selection` points at a concrete agent (not `main`/editor). */
export function isAgentSelection(selection: PanelSelection): selection is PanelTarget {
	return selection !== null && selection !== "main";
}

/**
 * Numeric cursor position for the current rows, or `null` when the editor owns
 * the cursor. A selection whose agent has disappeared (dismissed, aged out of
 * the linger window) resolves to the main row rather than to a stranger.
 */
export function resolveIndex(rows: readonly PanelRow[], selection: PanelSelection): number | null {
	if (selection === null) return null;
	if (selection === "main") return 0;
	const found = rows.findIndex((row) => sameTarget(row, selection));
	return found >= 0 ? found + 1 : 0;
}

/** Selection for a numeric position, clamped into range. Index 0 is `main`. */
export function selectionAtIndex(rows: readonly PanelRow[], index: number): PanelSelection {
	const clamped = Math.max(0, Math.min(rows.length, index));
	if (clamped === 0) return "main";
	const row = rows[clamped - 1];
	return row ? { runId: row.runId, taskId: row.taskId } : "main";
}

/** The row a selection currently points at, if it is still present. */
export function rowFor(rows: readonly PanelRow[], selection: PanelSelection): PanelRow | undefined {
	if (!isAgentSelection(selection)) return undefined;
	return rows.find((row) => sameTarget(row, selection));
}

/**
 * Apply one keypress.
 *
 * Any key that is not a navigation key returns `{ kind: "none" }` with the
 * selection cleared, so the caller can forward it to the editor and the user is
 * never trapped in a mode.
 */
export function dispatchPanelKey(
	keys: PanelKeys,
	rows: readonly PanelRow[],
	selection: PanelSelection,
	options: DispatchOptions = {},
): DispatchResult {
	// Editor owns the cursor: the only panel key that makes sense is `down`,
	// entering at the main row (pi-subtask: selectRow(rows, 0)). The main row
	// is a real rendered row with its own ❯ marker, so this first press is
	// visible immediately — no dead-key feeling. Everything else falls
	// through untouched.
	if (selection === null) {
		if (keys.down) return { action: { kind: "consumed" }, selection: "main" };
		return { action: { kind: "none" }, selection: null };
	}

	const index = resolveIndex(rows, selection) ?? 0;

	if (keys.up) {
		if (index === 0 && options.holdAtMain !== true) return { action: { kind: "consumed" }, selection: null };
		return { action: { kind: "consumed" }, selection: selectionAtIndex(rows, index - 1) };
	}
	if (keys.down) {
		return { action: { kind: "consumed" }, selection: selectionAtIndex(rows, index + 1) };
	}
	if (keys.escape) {
		return { action: { kind: "consumed" }, selection: null };
	}
	if (keys.enter) {
		const target = index > 0 ? rows[index - 1] : undefined;
		return {
			action: { kind: "open", target: target ? { runId: target.runId, taskId: target.taskId } : undefined },
			selection: null,
		};
	}
	if (keys.act && index > 0) {
		const target = rows[index - 1];
		if (!target) return { action: { kind: "consumed" }, selection: selectionAtIndex(rows, 0) };
		// Selection stays on the SAME agent so a follow-up keystroke acts on it
		// again rather than on whichever row the reorder promoted.
		return {
			action: { kind: "act", target: { runId: target.runId, taskId: target.taskId } },
			selection: { runId: target.runId, taskId: target.taskId },
		};
	}
	return { action: { kind: "none" }, selection: null };
}
