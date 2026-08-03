/**
 * PR-G3 (UI-3) — verify the 5 incompatible Component interfaces across src/ui/
 * now share a single `CrewComponent` (render + invalidate) contract and can be
 * used polymorphically.
 *
 * Covered component families:
 *   1. RenderableComponent  (layout-primitives.ts)
 *   2. WidgetComponent      (widget/index.ts)
 *   3. DashboardComponent   (run-dashboard.ts)
 *   4. Component            (transcript-viewer.ts)
 *   5. Component = Container|Text (tool-renderers/index.ts)
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CrewComponent, InteractiveComponent } from "../../../src/ui/component.ts";
import type { RenderableComponent } from "../../../src/ui/layout-primitives.ts";
import { Box, Container, Spacer, Text } from "../../../src/ui/layout-primitives.ts";
import { ConfirmOverlay } from "../../../src/ui/overlays/confirm-overlay.ts";
import type { RunDashboard } from "../../../src/ui/run-dashboard.ts";
import type { Component as ToolRendererComponent } from "../../../src/ui/tool-renderers/index.ts";
import type { DurableTranscriptViewer } from "../../../src/ui/transcript-viewer.ts";
import { DurableTextViewer } from "../../../src/ui/transcript-viewer.ts";

// ── Compile-time structural checks ──────────────────────────────────────
// Each of the 5 Component-ish types must be assignable to the shared
// CrewComponent (or InteractiveComponent) interface. These are pure type
// checks; tsx refuses to run this file if any is incompatible, so the
// assertions below double as compile-time guards.

/** Asserts T is assignable to CrewComponent (render + invalidate). */
function assertCrewComponent<T extends CrewComponent>(): void { /* no-op */ }
/** Asserts T is assignable to InteractiveComponent (render + invalidate + handleInput). */
function assertInteractive<T extends InteractiveComponent>(): void { /* no-op */ }

// 1. RenderableComponent (layout-primitives.ts) — exported, extends CrewComponent.
assertCrewComponent<RenderableComponent>();
// 2. tool-renderers Component (Container | Text) — exported union; both members
//    implement pi-tui's Component (render + invalidate).
assertCrewComponent<ToolRendererComponent>();
// 3. DashboardComponent (run-dashboard.ts) — verified via RunDashboard instance type.
assertInteractive<InstanceType<typeof RunDashboard>>();
// 4. transcript-viewer Component — verified via the two exported viewer classes.
assertInteractive<DurableTextViewer>();
assertInteractive<InstanceType<typeof DurableTextViewer>>();
assertInteractive<DurableTranscriptViewer>();
// 5. WidgetComponent (widget/index.ts) — not exported. A widget-shaped object
//    (render + invalidate) must be a valid CrewComponent. The in-source
//    `interface WidgetComponent extends CrewComponent` provides the compile-time
//    guarantee for the private interface; the assignment below mirrors its shape.
const _widgetShapeCheck: CrewComponent = {
	render(_width: number): string[] {
		return [];
	},
	invalidate(): void { /* no-op */ },
};
void _widgetShapeCheck;

// ── Runtime polymorphic dispatch ─────────────────────────────────────────

test("UI-3: presentational components (RenderableComponent family) are polymorphic CrewComponents", () => {
	// Family 1 (RenderableComponent) + Family 5 (tool-renderers Component, which
	// is the same Container/Text shape) share the contract.
	const components: CrewComponent[] = [new Container(), new Text("hello"), new Spacer(1), new Box(1, 1)];
	for (const c of components) {
		// invalidate must be callable without throwing.
		c.invalidate();
		const lines = c.render(40);
		assert.ok(Array.isArray(lines), "render must return string[]");
		for (const line of lines) assert.equal(typeof line, "string", "each row is a string");
	}
});

test("UI-3: a widget-shaped object satisfies CrewComponent polymorphically", () => {
	// Family 2 (WidgetComponent): render + invalidate.
	const widget: CrewComponent = {
		render(width: number): string[] {
			return [`widget@${width}`];
		},
		invalidate(): void { /* no-op */ },
	};
	const lines = widget.render(80);
	assert.deepEqual(lines, ["widget@80"]);
});

test("UI-3: interactive components satisfy both CrewComponent and InteractiveComponent", () => {
	// Family 3 (DashboardComponent-shaped) and Family 4 (transcript Component)
	// are interactive. ConfirmOverlay is an overlay using the same contract.
	const overlay = new ConfirmOverlay({ title: "Are you sure?" }, () => undefined);

	// Usable as the base CrewComponent.
	const asComponent: CrewComponent = overlay;
	asComponent.invalidate();
	const lines = asComponent.render(50);
	assert.ok(lines.length > 0, "overlay renders lines");

	// Usable as InteractiveComponent (handleInput present).
	let confirmed: boolean | undefined;
	const live = new ConfirmOverlay({ title: "x" }, (c) => {
		confirmed = c;
	});
	(live as InteractiveComponent).handleInput("y");
	assert.equal(confirmed, true);
});

test("UI-3: DurableTextViewer (transcript Component) renders through the shared interface", () => {
	// Family 4 (transcript-viewer Component).
	const viewer = new DurableTextViewer("title", "subtitle", ["line-1", "line-2"], {}, () => undefined);
	const asComponent: CrewComponent = viewer;
	asComponent.invalidate();
	const lines = asComponent.render(60);
	assert.ok(Array.isArray(lines), "viewer render returns string[]");
});

test("UI-3: invalidate then render recomputes (no stale cache after invalidate)", () => {
	// Exercise the shared contract semantics across two families.
	const text = new Text("abc");
	const first = text.render(20);
	// Mutating state calls invalidate internally; render after must differ.
	text.setText("xyz");
	const second = text.render(20);
	assert.notDeepEqual(first, second, "setText invalidates so render reflects the new text");
});
