/**
 * dock-footer.ts — dependency-free bridge between the crew dock and the
 * crew-vibes footer.
 *
 * When `ui.widgetPlacement` is `"bottom"`, the dock's rendered lines are
 * produced by the crew widget but PAINTED by the crew-vibes footer, below the
 * quota/meter lines — the very bottom of the terminal. The two halves are
 * mounted by different modules (widget/index.ts owns the widget lifecycle,
 * crew-vibes/footer.ts owns the footer), so the connection lives here as a
 * tiny observable registry with no imports:
 *   - the widget registers a per-render line provider;
 *   - crew-vibes flips the "sink" flag when its footer is (un)installed;
 *   - the footer pulls the provider's lines on every render.
 *
 * Safety: the widget falls back to pi's `belowEditor` widget slot whenever no
 * footer sink is active (crew-vibes disabled), so `"bottom"` never silently
 * hides the dock.
 */

export type FooterDockLinesProvider = (width: number) => string[];

let dockProvider: FooterDockLinesProvider | undefined;
let sinkActive = false;

/** Register the dock line provider (widget side). Pass `undefined` to detach. */
export function setFooterDockProvider(provider: FooterDockLinesProvider | undefined): void {
	dockProvider = provider;
}

/** Current dock line provider, or undefined when the dock is not in the footer. */
export function getFooterDockProvider(): FooterDockLinesProvider | undefined {
	return dockProvider;
}

/** Mark whether a footer sink (crew-vibes) is currently installed. */
export function setFooterDockSinkActive(active: boolean): void {
	sinkActive = active;
}

/** True while crew-vibes' custom footer is installed and can host the dock. */
export function isFooterDockSinkActive(): boolean {
	return sinkActive;
}

/** Test isolation. */
export function resetFooterDockRegistry(): void {
	dockProvider = undefined;
	sinkActive = false;
}
