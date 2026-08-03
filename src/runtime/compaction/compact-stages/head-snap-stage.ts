/**
 * HeadSnapStage — keep the first N bytes of the input, optionally snapping to
 * the last newline within that region for clean line boundaries.
 *
 * Distinct from TruncationStage (head + important-middle + tail, P0-B / P0-A):
 * this stage is pure head-only with optional newline-snap, used by the
 * iteration-hooks hook-output capture where the goal is "first N bytes
 * snapped to a clean line" rather than head + tail.
 *
 * Use case in pi-crew:
 *   - `iteration-hooks.ts` truncateToLimit — hook stdout capture capped at
 *     MAX_STDOUT_BYTES (8KB), snapped to the last newline in the head region
 *     so partial lines never appear in the captured preview.
 *
 * Byte cap (not char cap) to preserve the original memory budget semantic:
 * the input is converted from Buffer to string once, then this stage ensures
 * the output never exceeds the byte cap by walking back any partial UTF-8
 * sequence at the cut boundary.
 */
import type { ICompactStage } from "../compact-pipeline.ts";

export interface HeadSnapStageConfig {
	/** Maximum output size in bytes. */
	maxBytes: number;
	/** When true, snap the cut to the last newline within the head region. */
	snapToNewline?: boolean;
	/** Optional explicit id; defaults to "head-snap". */
	id?: string;
}

export class HeadSnapStage implements ICompactStage {
	readonly id: string;
	private readonly maxBytes: number;
	private readonly snapToNewline: boolean;
	constructor(config: HeadSnapStageConfig) {
		if (!Number.isFinite(config.maxBytes) || config.maxBytes <= 0) {
			throw new Error(`HeadSnapStage: maxBytes must be a positive finite number, got ${config.maxBytes}`);
		}
		this.maxBytes = config.maxBytes;
		this.snapToNewline = config.snapToNewline !== false;
		this.id = config.id ?? "head-snap";
	}
	apply(text: string): string {
		if (Buffer.byteLength(text, "utf-8") <= this.maxBytes) return text;
		// Approximate: slice by char count, then walk back any partial UTF-8
		// sequence to keep byte-length <= maxBytes.
		let slice = text.slice(0, this.maxBytes);
		while (Buffer.byteLength(slice, "utf-8") > this.maxBytes) {
			slice = slice.slice(0, slice.length - 1);
		}
		if (this.snapToNewline) {
			const lastNewline = slice.lastIndexOf("\n");
			if (lastNewline >= 0) return slice.slice(0, lastNewline);
		}
		return slice;
	}
}
