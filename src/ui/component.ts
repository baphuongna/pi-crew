/**
 * PR-G3 (UI-3) — single shared Component contract for the UI layer.
 *
 * Five parallel "Component" shapes previously existed across src/ui/:
 *
 *   - `RenderableComponent`        (layout-primitives.ts)
 *   - `WidgetComponent`            (widget/index.ts)
 *   - `DashboardComponent`         (run-dashboard.ts)
 *   - `type Component`             (transcript-viewer.ts)
 *   - `type Component = Container|Text` (tool-renderers/index.ts)
 *
 * They all share the same two core methods (render + invalidate) but could
 * not be used interchangeably, which blocked polymorphic dispatch and shared
 * testing. This module names that shared contract so any UI component can be
 * treated uniformly.
 *
 * This is purely additive: every existing component already structurally
 * satisfies these interfaces (render + invalidate are required everywhere;
 * handleInput is present on the interactive ones). Adapting the existing
 * declarations to `extends`/alias these types changes NO runtime behavior —
 * it only makes the relationship explicit and compiler-enforced.
 *
 * Note: @earendil-works/pi-tui also declares a `Component` interface with the
 * same render+invalidate core (plus an optional handleInput). `CrewComponent`
 * is a structural supertype of it, so pi-tui components opt in automatically.
 */

/** Minimum shared contract every UI component satisfies. */
export interface CrewComponent {
	/**
	 * Drop cached render state so the next `render` recomputes from fresh data.
	 * Called on theme changes, resize, or any state mutation that invalidates
	 * previously produced lines.
	 */
	invalidate(): void;
	/**
	 * Produce rendered lines for the given terminal width.
	 * @param width - available terminal width in cells
	 * @returns one string per output row (already padded/ANSI-colored)
	 */
	render(width: number): string[];
}

/**
 * A component that also accepts raw key/input data. Interactive viewers
 * (RunDashboard, DurableTranscriptViewer) and overlays (ConfirmOverlay,
 * MailboxDetailOverlay, AgentPickerOverlay) implement this; purely
 * presentational components (Container, Text, Spacer, Box) do not.
 */
export interface InteractiveComponent extends CrewComponent {
	/** Optional stable id (used by overlay stacks for lookup/debug). */
	id?: string;
	/** Consume a raw input chunk (a keypress escape sequence). */
	handleInput(data: string): void;
}
