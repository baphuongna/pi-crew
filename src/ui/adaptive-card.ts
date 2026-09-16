/**
 * AdaptiveCard — a width-deferred card component (R2, 2026-09-16).
 *
 * Problem it fixes: pi-crew's tool-renderer cards used to be BUILT as a
 * pre-formatted string at a guessed width (`ctx.width || process.stdout.columns
 * || 116`) and handed to `new Text(...)`. Pi's ToolRenderContext carries NO
 * width field — neither the TUI nor export-html pass one — so the guess could
 * never match the real render column. `Text.render(width)` WRAPS lines wider
 * than the column, which tore the box frame apart (top border split mid-line,
 * right border vanished). This hit HTML export hardest: export renders every
 * card at width=100 while a non-TTY export process builds at the 116 fallback.
 *
 * Design: build the frame at RENDER time, at the width the caller actually
 * provides. The card receives a `builder(width) => string`; `render(width)`
 * invokes it and delegates line-wrapping/padding to a zero-padding `Text`.
 * Results are cached per width (mirroring Text's own cache) so repeated
 * renders of an unchanged card cost nothing.
 *
 * Fail-visible: a builder exception surfaces as a red `✖ card render error`
 * line instead of propagating into the TUI render loop (which has no per-
 * component catch). Construction-time errors in the ToolRenderer wrappers
 * keep their own catch — this is the third and final layer.
 */

import { Text } from "@earendil-works/pi-tui";
import type { CrewComponent } from "./component.ts";

export class AdaptiveCard implements CrewComponent {
	#builder: (width: number) => string;
	#errorStyle: (text: string) => string;
	#text = new Text("", 0, 0);
	#cachedWidth: number | undefined;
	#cachedLines: string[] | null = null;

	/**
	 * @param builder produces the full card text (frame included) for a width.
	 *   Must keep every line within `width` visual columns — the same contract
	 *   the old fixed-width builders already obeyed for their baked width.
	 * @param errorStyle theme.fg("error", …) adapter for the fail-visible line.
	 */
	constructor(builder: (width: number) => string, errorStyle: (text: string) => string = (t) => t) {
		this.#builder = builder;
		this.#errorStyle = errorStyle;
	}

	invalidate(): void {
		this.#cachedLines = null;
		this.#cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.#cachedLines !== null && this.#cachedWidth === width) return this.#cachedLines;
		let text: string;
		try {
			text = this.#builder(width);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			text = this.#errorStyle(`✖ card render error: ${msg.slice(0, 60)}`);
		}
		this.#text.setText(text);
		this.#cachedLines = this.#text.render(width);
		this.#cachedWidth = width;
		return this.#cachedLines;
	}
}
