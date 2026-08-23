/**
 * Unit tests for the agent view's pane wiring (inline-panel/index.ts).
 *
 * The contract under test — the architecture inherited from pi-subtask:
 *  - Entering an agent opens an IN-DOCUMENT live transcript pane (widget
 *    `pi-crew-agent-view`, placement aboveEditor). No session is switched,
 *    resumed, or torn down, so viewing can never kill a run.
 *  - Re-entering (another agent, or the same one again) just re-targets the
 *    pane: openPane is idempotent widget wiring, not a session operation.
 *  - Closing clears the viewed agent and unregisters the widget.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { __test__closePane, __test__openPane, PANE_WIDGET_KEY } from "../../../src/ui/inline-panel/index.ts";
import { getViewedAgent, setViewedAgent } from "../../../src/ui/inline-panel/panel-store.ts";

interface WidgetCall {
	key: string;
	content: unknown;
	options: unknown;
}

function makeCtx(): { ctx: Record<string, unknown>; widgets: WidgetCall[] } {
	const widgets: WidgetCall[] = [];
	const ctx = {
		cwd: "/tmp/pane-test",
		hasUI: true,
		ui: {
			setWidget: (key: string, content: unknown, options: unknown) => {
				widgets.push({ key, content, options });
			},
			getEditorComponent: () => undefined,
			notify: () => undefined,
		},
	};
	return { ctx, widgets };
}

test("openPane registers the aboveEditor pane widget and marks the agent viewed", () => {
	setViewedAgent(undefined);
	const { ctx, widgets } = makeCtx();
	__test__openPane(ctx as never, { runId: "run1", taskId: "task_1" });

	assert.deepEqual(getViewedAgent(), { runId: "run1", taskId: "task_1" });
	assert.equal(widgets.length, 1, "exactly one setWidget call");
	const call = widgets[0]!;
	assert.equal(call.key, PANE_WIDGET_KEY);
	assert.equal((call.options as { placement?: string }).placement, "aboveEditor");
	assert.equal(typeof call.content, "function", "widget content is the pane factory");
});

test("openPane again just re-targets the pane — no session work, no gating", () => {
	setViewedAgent(undefined);
	const { ctx, widgets } = makeCtx();
	__test__openPane(ctx as never, { runId: "run1", taskId: "task_1" });
	__test__openPane(ctx as never, { runId: "run1", taskId: "task_2" });
	__test__openPane(ctx as never, { runId: "run1", taskId: "task_1" });

	assert.deepEqual(getViewedAgent(), { runId: "run1", taskId: "task_1" });
	assert.equal(widgets.length, 3, "each open re-registers the widget (idempotent wiring)");
});

test("closePane clears the viewed agent and unregisters the widget", () => {
	setViewedAgent(undefined);
	const { ctx, widgets } = makeCtx();
	__test__openPane(ctx as never, { runId: "run1", taskId: "task_1" });
	__test__closePane(ctx as never);

	assert.equal(getViewedAgent(), undefined);
	assert.equal(widgets.length, 2);
	const close = widgets[1]!;
	assert.equal(close.key, PANE_WIDGET_KEY);
	assert.equal(close.content, undefined, "closing unregisters (content undefined)");
});

test("openPane survives a stale ctx (widget registration drops, no throw)", () => {
	setViewedAgent(undefined);
	const ctx = {
		cwd: "/tmp/pane-test",
		hasUI: true,
		get ui(): never {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	};
	assert.doesNotThrow(() => __test__openPane(ctx as never, { runId: "run1", taskId: "task_1" }));
	// The pane target is still recorded; the next session_start install
	// re-registers the widget for it.
	assert.deepEqual(getViewedAgent(), { runId: "run1", taskId: "task_1" });
	setViewedAgent(undefined);
});
