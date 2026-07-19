/**
 * TailCaptureStage — keep the last N characters/bytes of the input, prepend
 * an optional marker when truncation fires.
 *
 * Distinct from TruncationStage (head + important-middle + tail, P0-B / P0-A):
 * this stage is pure tail-capture, used by streaming accumulators that need to
 * keep the most recent N chars/bytes and drop the oldest. No important-line
 * preservation, no head — just the tail + optional marker.
 *
 * Use cases in pi-crew:
 *   - `appendBoundedTail` (child-pi.ts) — stdout/stderr streaming accumulator
 *     with byte cap and a `[pi-crew captured output truncated to last X KiB]`
 *     marker.
 *   - `stream-preview.ts` textBuffer — incremental text buffer for the live UI
 *     preview, char cap, NO marker (the UI shows raw text without a prefix).
 *
 * Two cap modes:
 *   - `maxChars`: character-based cap (UTF-8 safe by definition).
 *   - `maxBytes`: byte-based cap (legacy, used when memory budget matters
 *     more than UTF-8 safety). The tail is snapped to the last byte that
 *     keeps the result ≤ maxBytes to avoid splitting a multi-byte sequence.
 */
import type { ICompactStage } from "../compact-pipeline.ts";

export interface TailCaptureStageConfig {
	/** Character cap (UTF-8 safe). Mutually exclusive with maxBytes. */
	maxChars?: number;
	/** Byte cap (legacy, used by streaming accumulators). Mutually exclusive with maxChars. */
	maxBytes?: number;
	/** Marker prepended (with a newline separator) when truncation fires. Empty string = no marker. */
	marker?: string;
	/** Optional explicit id; defaults to "tail-capture" (or "tail-capture-stream" if maxBytes mode). */
	id?: string;
}

export class TailCaptureStage implements ICompactStage {
	readonly id: string;
	private readonly maxChars: number | undefined;
	private readonly maxBytes: number | undefined;
	private readonly marker: string;
	constructor(config: TailCaptureStageConfig) {
		const hasChars = typeof config.maxChars === "number";
		const hasBytes = typeof config.maxBytes === "number";
		if (hasChars === hasBytes) {
			throw new Error(
				`TailCaptureStage requires exactly one of maxChars or maxBytes (got chars=${config.maxChars} bytes=${config.maxBytes})`,
			);
		}
		if (hasChars && (config.maxChars as number) <= 0) throw new Error(`TailCaptureStage: maxChars must be > 0, got ${config.maxChars}`);
		if (hasBytes && (config.maxBytes as number) <= 0) throw new Error(`TailCaptureStage: maxBytes must be > 0, got ${config.maxBytes}`);
		this.maxChars = config.maxChars;
		this.maxBytes = config.maxBytes;
		this.marker = config.marker ?? "";
		this.id = config.id ?? (hasBytes ? "tail-capture" : "tail-capture");
	}
	apply(text: string): string {
		if (this.maxBytes !== undefined) {
			// Byte cap mode — snap tail to a UTF-8 char boundary so the result
			// never contains a partial multi-byte sequence.
			if (Buffer.byteLength(text, "utf-8") <= this.maxBytes) return text;
			let tail = text.slice(Math.max(0, text.length - this.maxBytes));
			while (Buffer.byteLength(tail, "utf-8") > this.maxBytes) tail = tail.slice(0, -1);
			return this.marker ? `${this.marker}\n${tail}` : tail;
		}
		// Char cap mode.
		const max = this.maxChars as number;
		if (text.length <= max) return text;
		const tail = text.slice(text.length - max);
		return this.marker ? `${this.marker}\n${tail}` : tail;
	}
}

/** Singleton: char-cap tail capture with no marker (for `stream-preview.ts` textBuffer). */
export const TAIL_CAPTURE_STREAM_STAGE = new TailCaptureStage({
	maxChars: 16_384,
	id: "tail-capture-stream",
});
