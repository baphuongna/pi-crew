/**
 * AnsiStripStage — strip ANSI CSI escape sequences.
 *
 * Matches the common CSI pattern: ESC `[` followed by parameter bytes
 * (0-9 ; ?), intermediate bytes (space - /), and a final byte (@-~).
 * Sufficient for the color/cursor codes emitted by npm, cargo, jest, etc.
 * Does not attempt to handle OSC / DCS / private modes (rare in CLI output
 * captured into artifacts; can be added later if real-world signal emerges).
 *
 * Idempotent (no ANSI in → no change; ANSI in → ANSI out).
 */
import type { ICompactStage } from "../compact-pipeline.ts";

// CSI: ESC [ <params 0-9;> <intermediates space-/ > <final @-~>
const ANSI_CSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export class AnsiStripStage implements ICompactStage {
	readonly id = "ansi-strip";
	apply(text: string): string {
		if (text.indexOf("\x1b") === -1) return text; // fast path: no ESC at all
		return text.replace(ANSI_CSI_PATTERN, "");
	}
}

export const ANSI_STRIP_STAGE = new AnsiStripStage();
