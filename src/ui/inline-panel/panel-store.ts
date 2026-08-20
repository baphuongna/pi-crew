/**
 * panel-store.ts — process-wide state shared by the inline panel's two halves.
 *
 * The editor wrapper mutates the cursor; the widget renderer and the transcript
 * pane read it. Neither can own the state (the editor is created by pi's
 * factory, the widget by another), so it lives here as a small observable
 * singleton — the same shape pi-subtask keeps in its closure.
 *
 * Row projection is injected rather than computed here: the widget already owns
 * the manifest/snapshot caches that produce the run list, and duplicating that
 * read on every keypress would put disk I/O on the input path.
 */

import type { PanelRow, PanelSelection, PanelTarget } from "./panel-selection.ts";
import { isAgentSelection } from "./panel-selection.ts";

let selection: PanelSelection = null;
let viewed: PanelTarget | undefined;
let rowsProvider: (() => PanelRow[]) | undefined;
const listeners = new Set<() => void>();

/** Install the row projection. Called once during panel wiring. */
export function setPanelRowsProvider(provider: (() => PanelRow[]) | undefined): void {
	rowsProvider = provider;
}

/**
 * Navigable rows, freshly projected on each call.
 *
 * A provider throw must never break input handling — a transient manifest read
 * failure would otherwise make the panel swallow keys — so it degrades to an
 * empty list, which the editor treats as "nothing to navigate".
 */
export function panelRows(): PanelRow[] {
	if (!rowsProvider) return [];
	try {
		return rowsProvider();
	} catch {
		return [];
	}
}

export function getPanelSelection(): PanelSelection {
	return selection;
}

export function setPanelSelection(next: PanelSelection): void {
	if (next === selection) return;
	if (isAgentSelection(selection) && isAgentSelection(next) && selection.runId === next.runId && selection.taskId === next.taskId) {
		return;
	}
	selection = next;
	notifyPanelChange();
}

export function getViewedAgent(): PanelTarget | undefined {
	return viewed;
}

export function setViewedAgent(next: PanelTarget | undefined): void {
	if (viewed === next) return;
	if (viewed && next && viewed.runId === next.runId && viewed.taskId === next.taskId) return;
	viewed = next;
	notifyPanelChange();
}

/** True while the panel holds the cursor, i.e. keys are not going to the editor. */
export function isPanelFocused(): boolean {
	return selection !== null;
}

/** What the widget renderer needs, in one read. */
export function panelDisplayState(): {
	selectedTaskId: string | undefined;
	viewedTaskId: string | undefined;
	focused: boolean;
} {
	return {
		selectedTaskId: isAgentSelection(selection) ? selection.taskId : undefined,
		viewedTaskId: viewed?.taskId,
		// Cursor-driven: uncapping the row budget while the user is typing
		// into the pane (viewed set, selection null) would jerk the layout on
		// every pane open. The cursor entry is when the full list is needed.
		focused: selection !== null,
	};
}

export function subscribePanelChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function notifyPanelChange(): void {
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// A failing repaint listener must not stop the others.
		}
	}
}

/** Session teardown / test isolation. */
export function resetPanelStore(): void {
	selection = null;
	viewed = undefined;
	rowsProvider = undefined;
	listeners.clear();
}
