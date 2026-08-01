/**
 * PR-G3 (UI-4) — minimal overlay stack for z-order, focus, and dismissal
 * chaining.
 *
 * Before this, src/ui/ had no central router for overlay z-order/focus/
 * dismissal. Overlays (ConfirmOverlay, MailboxDetailOverlay, AgentPickerOverlay,
 * HelpOverlay, …) each manage their own `handleInput`, and a caller that wants
 * two overlays up at once had no way to express "the top one gets input and
 * ESC dismisses it, restoring focus to the one below".
 *
 * The `OverlayStack` is a LIFO stack of overlays. The top of the stack owns
 * input focus and is rendered last (i.e. on top). Popping or dismissing the
 * top restores focus to the next overlay down. Every overlay already exposes
 * the `InteractiveComponent` contract (render + invalidate + handleInput), so
 * existing overlays opt in automatically with zero rewrite.
 *
 * This is intentionally additive: no existing overlay is required to use it.
 * Callers that want centralized z-order/focus management opt in by pushing
 * overlays here.
 */

import type { InteractiveComponent } from "./component.ts";

/**
 * An overlay is an interactive component occupying one z-layer. Anything with
 * `render` + `invalidate` + `handleInput` qualifies (ConfirmOverlay,
 * MailboxDetailOverlay, AgentPickerOverlay, RunDashboard, …).
 */
export type Overlay = InteractiveComponent;

export interface OverlayStackOptions {
	/**
	 * Invoked after the top-of-stack changes (push / pop / dismissTop / clear).
	 * Use it to (re)wire host focus or request a repaint. Optional.
	 */
	onTopChanged?: () => void;
}

/**
 * LIFO overlay stack providing z-order, focus, and dismissal chaining.
 *
 * - `push(o)`  → `o` becomes the new focus/top layer.
 * - `top()`    → the focused overlay (or undefined when empty).
 * - `handleInput(data)` → routed to the top overlay only; returns false when
 *   the stack is empty so callers can fall back to base input handling.
 * - `dismissTop()` / `pop()` → removes the top overlay, restoring focus below.
 * - `render(width)` → renders the top overlay by default; `{ composite: true }`
 *   returns every layer bottom-to-top for custom compositing.
 */
export class OverlayStack {
	private readonly stack: Overlay[] = [];
	private readonly onTopChanged?: () => void;

	constructor(options: OverlayStackOptions = {}) {
		this.onTopChanged = options.onTopChanged;
	}

	/** Number of overlays currently on the stack. */
	get size(): number {
		return this.stack.length;
	}

	/** Whether the stack currently holds any overlays. */
	isEmpty(): boolean {
		return this.stack.length === 0;
	}

	/** Push a new overlay on top. It becomes the input/render focus. */
	push(overlay: Overlay): void {
		this.stack.push(overlay);
		this.notifyTopChanged();
	}

	/** Remove and return the top overlay, or undefined if the stack is empty. */
	pop(): Overlay | undefined {
		const overlay = this.stack.pop();
		this.notifyTopChanged();
		return overlay;
	}

	/** The top-of-stack overlay (the focus/render target), or undefined when empty. */
	top(): Overlay | undefined {
		return this.stack.at(-1);
	}

	/** Peek at the overlay at a given depth (0 = bottom). */
	at(index: number): Overlay | undefined {
		return this.stack[index];
	}

	/**
	 * Dismiss the top overlay. Equivalent to `pop()` but returns a boolean so
	 * callers can chain dismissal (e.g. ESC closes the topmost, then the next).
	 * Returns true when an overlay was dismissed, false when the stack is empty.
	 */
	dismissTop(): boolean {
		if (this.stack.length === 0) return false;
		this.stack.pop();
		this.notifyTopChanged();
		return true;
	}

	/**
	 * Route a raw input chunk to the top-of-stack overlay.
	 * @returns true if an overlay handled it (stack non-empty); false if the
	 *   stack is empty so the caller may fall back to base input handling.
	 */
	handleInput(data: string): boolean {
		const overlay = this.top();
		if (!overlay) return false;
		overlay.handleInput(data);
		return true;
	}

	/**
	 * Render the stack. By default returns the top overlay's lines (the common
	 * modal case where the top covers what is below). Pass `{ composite: true }`
	 * to receive every layer's lines in bottom-to-top order for custom
	 * compositing. Returns `[]` when the stack is empty.
	 */
	render(width: number, options: { composite?: boolean } = {}): string[] {
		if (this.stack.length === 0) return [];
		if (options.composite) {
			const lines: string[] = [];
			for (const overlay of this.stack) {
				lines.push(...overlay.render(width));
			}
			return lines;
		}
		return this.stack.at(-1)!.render(width);
	}

	/** Invalidate every overlay on the stack (e.g. on theme change). */
	invalidateAll(): void {
		for (const overlay of this.stack) overlay.invalidate();
	}

	/** Remove every overlay from the stack. */
	clear(): void {
		const hadOverlays = this.stack.length > 0;
		this.stack.length = 0;
		if (hadOverlays) this.notifyTopChanged();
	}

	private notifyTopChanged(): void {
		this.onTopChanged?.();
	}
}
