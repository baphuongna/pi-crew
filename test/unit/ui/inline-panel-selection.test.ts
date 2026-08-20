/**
 * Unit tests for the inline panel's cursor state machine (panel-selection.ts).
 *
 * The contract under test (adapted from pi-subtask's panel cursor):
 *  - row 0 is `main`, agents start at 1;
 *  - the cursor is an IDENTITY (runId+taskId), so it follows the agent when
 *    the row list reorders and a second `x` acts on the SAME target;
 *  - a vanished selection self-corrects to `main`;
 *  - any key that is not a navigation key falls through as `none` with the
 *    selection cleared — the user is never trapped in a mode.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	dispatchPanelKey,
	type PanelKeys,
	type PanelRow,
	type PanelSelection,
	resolveIndex,
	selectionAtIndex,
} from "../../../src/ui/inline-panel/panel-selection.ts";

const RUN = "team_aaa";

function row(taskId: string, name = taskId, finished = false): PanelRow {
	return { runId: RUN, taskId, name, finished };
}

function keys(overrides: Partial<PanelKeys> = {}): PanelKeys {
	return { up: false, down: false, enter: false, escape: false, act: false, ...overrides };
}

test("down on an idle panel selects the FIRST agent directly (visible feedback)", () => {
	const rows = [row("t1"), row("t2")];
	// Start: editor owns the cursor. Landing on `main` first would paint no
	// marker, reading as a dead keypress — first press must hit an agent row.
	const first = dispatchPanelKey(keys({ down: true }), rows, null);
	assert.equal(first.action.kind, "consumed");
	assert.deepEqual(first.selection, { runId: RUN, taskId: "t1" });

	const second = dispatchPanelKey(keys({ down: true }), rows, first.selection);
	assert.deepEqual(second.selection, { runId: RUN, taskId: "t2" });
});

test("down on an idle panel with no rows stays at main (nothing to select)", () => {
	const result = dispatchPanelKey(keys({ down: true }), [], null);
	assert.equal(result.action.kind, "consumed");
	assert.equal(result.selection, "main");
});

test("enter on an agent row opens that agent; enter on main opens nothing", () => {
	const rows = [row("t1")];
	const atAgent = dispatchPanelKey(keys({ enter: true }), rows, { runId: RUN, taskId: "t1" });
	assert.deepEqual(atAgent.action, { kind: "open", target: { runId: RUN, taskId: "t1" } });

	const atMain = dispatchPanelKey(keys({ enter: true }), rows, "main");
	assert.deepEqual(atMain.action, { kind: "open", target: undefined });
});

test("cursor is identity: after a reorder it follows the agent, not the index", () => {
	const rows = [row("t1"), row("t2"), row("t3")];
	const selection: PanelSelection = { runId: RUN, taskId: "t2" };
	assert.equal(resolveIndex(rows, selection), 2);

	// t3 cancels and sinks to the finished section at the end: t2 must keep
	// its row, so its index stays. But the identity test needs the list to
	// actually MOVE the selected agent: swap t1 and t2.
	const reordered = [row("t2"), row("t1"), row("t3")];
	assert.equal(resolveIndex(reordered, selection), 1, "identity follows the agent through a reorder");

	// A second x must target the same agent regardless of where it sits now.
	const acted = dispatchPanelKey(keys({ act: true }), reordered, selection);
	assert.equal(acted.action.kind, "act");
	assert.deepEqual(acted.action, { kind: "act", target: { runId: RUN, taskId: "t2" } });
	// ...and the selection STAYS on that agent so a follow-up key acts again.
	assert.deepEqual(acted.selection, { runId: RUN, taskId: "t2" });
});

test("vanished selection self-corrects to main", () => {
	const rows = [row("t1")];
	assert.equal(resolveIndex(rows, { runId: RUN, taskId: "gone" }), 0);
	const escOrAct = dispatchPanelKey(keys({ act: true }), rows, { runId: RUN, taskId: "gone" });
	// act at a vanished row resolves to index 0 (main) → falls through to `none`.
	assert.equal(escOrAct.action.kind, "none");
	assert.equal(escOrAct.selection, null);
});

test("up at main exits navigation unless holdAtMain is set", () => {
	const rows = [row("t1")];
	const exiting = dispatchPanelKey(keys({ up: true }), rows, "main");
	assert.deepEqual(exiting, { action: { kind: "consumed" }, selection: null });

	const holding = dispatchPanelKey(keys({ up: true }), rows, "main", { holdAtMain: true });
	assert.deepEqual(holding, { action: { kind: "consumed" }, selection: "main" });
});

test("up/down clamp at the ends", () => {
	const rows = [row("t1"), row("t2")];
	const bottom = dispatchPanelKey(keys({ down: true }), rows, { runId: RUN, taskId: "t2" });
	assert.deepEqual(bottom.selection, { runId: RUN, taskId: "t2" }, "down at the last row holds");
	const top = dispatchPanelKey(keys({ up: true }), rows, { runId: RUN, taskId: "t1" });
	assert.deepEqual(top.selection, "main", "up from the first agent returns to main");
});

test("escape clears the selection", () => {
	const rows = [row("t1")];
	const result = dispatchPanelKey(keys({ escape: true }), rows, { runId: RUN, taskId: "t1" });
	assert.deepEqual(result, { action: { kind: "consumed" }, selection: null });
});

test("non-navigation keys fall through with the selection cleared", () => {
	const rows = [row("t1")];
	const result = dispatchPanelKey(keys(), rows, { runId: RUN, taskId: "t1" });
	assert.deepEqual(result, { action: { kind: "none" }, selection: null });
});

test("selectionAtIndex clamps into range", () => {
	const rows = [row("t1"), row("t2")];
	assert.equal(selectionAtIndex(rows, 0), "main");
	assert.deepEqual(selectionAtIndex(rows, 1), { runId: RUN, taskId: "t1" });
	assert.deepEqual(selectionAtIndex(rows, 99), { runId: RUN, taskId: "t2" });
	assert.deepEqual(selectionAtIndex(rows, -3), "main");
	assert.deepEqual(selectionAtIndex([], 1), "main", "empty list clamps to main");
});

test("act on an agent keeps the selection so a second x repeats the action", () => {
	const rows = [row("t1"), row("t2")];
	const first = dispatchPanelKey(keys({ act: true }), rows, { runId: RUN, taskId: "t1" });
	assert.equal(first.action.kind, "act");
	const again = dispatchPanelKey(keys({ act: true }), rows, first.selection);
	assert.equal(again.action.kind, "act");
	assert.deepEqual(again.action, { kind: "act", target: { runId: RUN, taskId: "t1" } });
});

test("act on main is not a panel action (x on the conversation row falls through)", () => {
	const result = dispatchPanelKey(keys({ act: true }), [row("t1")], "main");
	assert.equal(result.action.kind, "none");
});
