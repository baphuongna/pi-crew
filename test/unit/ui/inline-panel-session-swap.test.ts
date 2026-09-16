/**
 * Unit tests for the inline panel's session-swap teardown (P1-10 / M2-2).
 *
 * The contract under test:
 *  - `liveOverlay` / `livePane` / `paneTickTimer` are module-level and the
 *    overlay's `close`/`steer` callbacks close over the `ctx` they were opened
 *    with. Keeping the view across a `session_start` would leave view/steer
 *    pointing at the OLD session's `ctx.cwd` and its already-dead
 *    `ctx.ui.custom.done` (a try/catch hides the throw).
 *  - On session start/swap the panel therefore closes + disposes the overlay,
 *    stops the repaint ticker, and nulls the refs, so no closure retains the
 *    previous ctx.
 *  - A view opened after the swap belongs to the NEW session's ctx and its
 *    ticker runs again.
 *
 * The fake `custom` mirrors showExtensionCustom: it invokes the factory
 * immediately with (tui, theme, keybindings, done).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	__resetInlinePanelForTest,
	__test__closePane,
	__test__liveViewState,
	__test__openPane,
	__test__teardownLiveView,
	installInlinePanel,
} from "../../../src/ui/inline-panel/index.ts";
import { setViewedAgent } from "../../../src/ui/inline-panel/panel-store.ts";

interface Harness {
	ctx: Record<string, unknown>;
	renders: () => number;
	doneCalls: () => number;
	notifies: () => number;
}

function makeHarness(rows = 24, cwd = "/tmp/old-session"): Harness {
	let renders = 0;
	let doneCalls = 0;
	let notifies = 0;
	const tui = {
		terminal: { rows, columns: 100 },
		requestRender: () => {
			renders++;
		},
	};
	const ctx: Record<string, unknown> = {
		cwd,
		hasUI: true,
		ui: {
			requestRender: () => {
				renders++;
			},
			notify: () => {
				notifies++;
			},
			confirm: async () => false,
			getEditorComponent: () => undefined,
			setEditorComponent: () => undefined,
			custom: (
				factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => unknown,
				_options?: Record<string, unknown>,
			) => {
				factory(tui, { colors: {} }, undefined, () => {
					doneCalls++;
				});
				return Promise.resolve(undefined);
			},
		},
	};
	return { ctx, renders: () => renders, doneCalls: () => doneCalls, notifies: () => notifies };
}

/**
 * Install the panel once (the hooks are one-time per process) and hand back the
 * registered `session_start` handler — the exact code path pi runs on a session
 * swap. `inlinePanel: false` keeps the editor factory out of the way: the hook
 * registration is independent of the panel toggle.
 */
let sessionStartHandler: (() => void) | undefined;
function sessionStartHook(): () => void {
	if (sessionStartHandler) return sessionStartHandler;
	const handlers = new Map<string, () => void>();
	const pi = {
		registerCommand: () => undefined,
		on: (event: string, handler: () => void) => {
			handlers.set(event, handler);
		},
	};
	installInlinePanel(pi as unknown as ExtensionAPI, makeHarness().ctx as never, { inlinePanel: false });
	const hook = handlers.get("session_start");
	assert.ok(hook, "installInlinePanel must register a session_start hook");
	sessionStartHandler = hook;
	return hook;
}

test("session swap closes/disposes the live view: refs nulled and the ticker stopped", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		setViewedAgent(undefined);
		__resetInlinePanelForTest();
		const hook = sessionStartHook();
		const harness = makeHarness(24, "/tmp/old-session");

		__test__openPane(harness.ctx as never, { runId: "run1", taskId: "task_1" });

		const before = __test__liveViewState();
		const oldOverlay = before.liveOverlay;
		assert.ok(oldOverlay, "the view's overlay is open");
		assert.ok(before.livePane, "the pane is attached to the live overlay");
		assert.equal(before.ticking, true, "repaint ticker armed while the view is open");

		// Control: the ticker really does drive repaints while the view is open.
		const rendersBeforeTicks = harness.renders();
		t.mock.timers.tick(2100);
		assert.ok(harness.renders() > rendersBeforeTicks, "ticker repaints the open view");

		// ── session swap ──
		hook();

		const after = __test__liveViewState();
		assert.equal(after.liveOverlay, undefined, "liveOverlay is null after the swap");
		assert.equal(after.livePane, undefined, "livePane is null after the swap");
		assert.equal(after.ticking, false, "the tick timer is cleared after the swap");
		assert.equal(harness.doneCalls(), 1, "the old overlay told its host to unmount exactly once");

		// No tick fires after the swap — nothing repaints the old workspace.
		const rendersAfterSwap = harness.renders();
		t.mock.timers.tick(5000);
		assert.equal(harness.renders(), rendersAfterSwap, "no repaint tick after the swap");

		// The captured overlay is inert: it can no longer reach the old ctx.
		oldOverlay.handleInput("i");
		oldOverlay.handleInput("steer the old workspace");
		oldOverlay.handleInput("\r");
		oldOverlay.handleInput("\x1b");
		assert.equal(harness.notifies(), 0, "no steer/notify through the stale ctx");
		assert.equal(harness.doneCalls(), 1, "closing stays idempotent");
		assert.deepEqual(oldOverlay.render(80), [], "a disposed overlay renders nothing");
	} finally {
		t.mock.timers.reset();
	}
});

test("session swap with no view open is a harmless no-op", () => {
	setViewedAgent(undefined);
	__resetInlinePanelForTest();
	const hook = sessionStartHook();

	assert.doesNotThrow(() => hook());
	assert.doesNotThrow(() => hook());
	const state = __test__liveViewState();
	assert.equal(state.liveOverlay, undefined);
	assert.equal(state.livePane, undefined);
	assert.equal(state.ticking, false);
});

test("teardownLiveView is idempotent when run directly", () => {
	setViewedAgent(undefined);
	__resetInlinePanelForTest();
	const harness = makeHarness(24, "/tmp/old-session");
	__test__openPane(harness.ctx as never, { runId: "run1", taskId: "task_1" });
	assert.equal(__test__liveViewState().ticking, true);

	__test__teardownLiveView();
	const state = __test__liveViewState();
	assert.equal(state.liveOverlay, undefined);
	assert.equal(state.livePane, undefined);
	assert.equal(state.ticking, false);
	assert.equal(harness.doneCalls(), 1);

	// Running it again (e.g. two session_starts in a row) must not re-close or throw.
	assert.doesNotThrow(() => __test__teardownLiveView());
	assert.equal(harness.doneCalls(), 1, "teardown is idempotent");
});

test("a view opened after the swap binds the new session's ctx and ticks again", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		setViewedAgent(undefined);
		__resetInlinePanelForTest();
		const hook = sessionStartHook();

		const oldHarness = makeHarness(24, "/tmp/old-session");
		__test__openPane(oldHarness.ctx as never, { runId: "run1", taskId: "task_1" });
		hook();

		const newHarness = makeHarness(24, "/tmp/new-session");
		__test__openPane(newHarness.ctx as never, { runId: "run2", taskId: "task_2" });
		const reopened = __test__liveViewState();
		assert.ok(reopened.liveOverlay, "the new session opens its own view");
		assert.equal(reopened.ticking, true, "the ticker is armed again for the new view");

		const renders = newHarness.renders();
		t.mock.timers.tick(2100);
		assert.ok(newHarness.renders() > renders, "the new view is repainted");
		assert.equal(oldHarness.doneCalls(), 1, "the old session's host was unmounted once");

		// Closing targets the new session only.
		__test__closePane(newHarness.ctx as never);
		assert.equal(newHarness.doneCalls(), 1, "close resolves the new host's done()");
		assert.equal(oldHarness.doneCalls(), 1, "the old host is untouched");
		assert.equal(__test__liveViewState().ticking, false, "closing stops the ticker");
	} finally {
		t.mock.timers.reset();
	}
});
