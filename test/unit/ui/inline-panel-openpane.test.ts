/**
 * Unit tests for the agent view's overlay wiring (inline-panel/index.ts).
 *
 * The contract under test:
 *  - Entering an agent opens ONE full-screen overlay via `ctx.ui.custom`
 *    with `overlay: true` and full-terminal sizing (width "100%", margin 0).
 *    It is a separate surface — the main session is never switched, resumed,
 *    or torn down, so viewing can never kill a run.
 *  - Re-entering (another agent, or the same one again) just re-targets the
 *    open overlay: no second `custom` call, no session operation.
 *  - Closing (the overlay's own esc path or the host's closePane) clears the
 *    viewed agent and resolves the host `done()` exactly once.
 *
 * The fake `custom` mirrors showExtensionCustom: it invokes the factory
 * immediately with (tui, theme, keybindings, done) and resolves when done()
 * is called.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewAgentOverlay } from "../../../src/ui/inline-panel/agent-view-overlay.ts";
import { __resetInlinePanelForTest, __test__closePane, __test__openPane } from "../../../src/ui/inline-panel/index.ts";
import { getViewedAgent, setViewedAgent } from "../../../src/ui/inline-panel/panel-store.ts";

interface Harness {
	ctx: Record<string, unknown>;
	calls: number;
	overlay: CrewAgentOverlay;
	options: Record<string, unknown>;
	doneCalls: () => number;
}

function makeHarness(rows = 24): Harness {
	let calls = 0;
	let doneCalls = 0;
	const tui = {
		terminal: { rows, columns: 100 },
		requestRender: () => undefined,
	};
	let overlay: CrewAgentOverlay | undefined;
	const ctx = {
		cwd: "/tmp/pane-test",
		hasUI: true,
		ui: {
			custom: (
				factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => unknown,
				options: Record<string, unknown> | undefined,
			) => {
				calls++;
				lastOptions = options;
				overlay = factory(tui, { colors: {} }, undefined, () => {
					doneCalls++;
				}) as CrewAgentOverlay;
				return Promise.resolve(undefined);
			},
		},
	};
	let lastOptions: Record<string, unknown> | undefined;
	return {
		ctx,
		get calls() {
			return calls;
		},
		get overlay() {
			assert.ok(overlay, "factory must have run");
			return overlay!;
		},
		get options() {
			return lastOptions!;
		},
		doneCalls: () => doneCalls,
	};
}

test("openPane spawns ONE full-screen overlay and marks the agent viewed", () => {
	setViewedAgent(undefined);
	__resetInlinePanelForTest();
	const harness = makeHarness();
	__test__openPane(harness.ctx as never, { runId: "run1", taskId: "task_1" });

	assert.deepEqual(getViewedAgent(), { runId: "run1", taskId: "task_1" });
	assert.equal(harness.calls, 1, "exactly one ctx.ui.custom call");
	const options = harness.options as { overlay?: boolean; overlayOptions?: Record<string, unknown> };
	assert.equal(options.overlay, true, "capturing overlay, not an editor swap");
	assert.equal(options.overlayOptions?.width, "100%", "full terminal width");
	assert.equal((options.overlayOptions?.margin as number | undefined) ?? 0, 0, "no margin");
	assert.equal(options.overlayOptions?.maxHeight, "100%", "may fill the whole height");
});

test("openPane again just re-targets the open overlay — no second custom call", () => {
	setViewedAgent(undefined);
	__resetInlinePanelForTest();
	const harness = makeHarness();
	__test__openPane(harness.ctx as never, { runId: "run1", taskId: "task_1" });
	__test__openPane(harness.ctx as never, { runId: "run1", taskId: "task_2" });
	__test__openPane(harness.ctx as never, { runId: "run1", taskId: "task_1" });

	assert.deepEqual(getViewedAgent(), { runId: "run1", taskId: "task_1" });
	assert.equal(harness.calls, 1, "the same overlay is re-targeted in place");
});

test("overlay close (esc path) clears the viewed agent and resolves done once", () => {
	setViewedAgent(undefined);
	__resetInlinePanelForTest();
	const harness = makeHarness();
	__test__openPane(harness.ctx as never, { runId: "run1", taskId: "task_1" });

	harness.overlay.handleInput("\x1b");
	assert.equal(harness.doneCalls(), 1, "host done() resolved exactly once");
	assert.equal(getViewedAgent(), undefined, "viewed agent cleared");
	harness.overlay.handleInput("\x1b");
	assert.equal(harness.doneCalls(), 1, "closing is idempotent");
});

test("closePane routes through the open overlay's close path", () => {
	setViewedAgent(undefined);
	__resetInlinePanelForTest();
	const harness = makeHarness();
	__test__openPane(harness.ctx as never, { runId: "run1", taskId: "task_1" });

	__test__closePane(harness.ctx as never);
	assert.equal(harness.doneCalls(), 1, "/crew-back resolves the overlay's done()");
	assert.equal(getViewedAgent(), undefined);

	// Closing with no overlay open is a harmless no-op.
	__test__closePane(harness.ctx as never);
	assert.equal(harness.doneCalls(), 1);
});

test("overlay render fills the terminal and carries the hint line", () => {
	setViewedAgent(undefined);
	__resetInlinePanelForTest();
	const harness = makeHarness(24);
	__test__openPane(harness.ctx as never, { runId: "run1", taskId: "task_1" });

	const lines = harness.overlay.render(100);
	assert.equal(lines.length, 24, "exactly terminal height — nothing bleeds through");
	assert.match(lines.at(-1) ?? "", /esc back/, "hint explains how to leave the view");

	// Steer input mode: `i` opens the input row, escape closes it again.
	harness.overlay.handleInput("i");
	const withInput = harness.overlay.render(100);
	assert.equal(withInput.length, 24, "still exactly terminal height with the input row");
	assert.match(withInput.at(-2) ?? "", /❯/, "input row renders above the hint");
	harness.overlay.handleInput("h");
	harness.overlay.handleInput("\x1b");
	const afterCancel = harness.overlay.render(100);
	assert.doesNotMatch(afterCancel.at(-2) ?? "", /❯/, "esc cancels the steer input");
	harness.overlay.handleInput("\x1b");
});

test("openPane survives a stale ctx (overlay spawn drops, no throw)", () => {
	setViewedAgent(undefined);
	__resetInlinePanelForTest();
	const ctx = {
		cwd: "/tmp/pane-test",
		hasUI: true,
		get ui(): never {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	};
	assert.doesNotThrow(() => __test__openPane(ctx as never, { runId: "run1", taskId: "task_1" }));
	// The pane target is still recorded; the editor fallback path keeps the
	// state coherent (esc there closes cleanly).
	assert.deepEqual(getViewedAgent(), { runId: "run1", taskId: "task_1" });
	setViewedAgent(undefined);
});
