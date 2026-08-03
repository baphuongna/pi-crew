/**
 * TruncationStage — head(75%) + important-middle + tail(25%) compression.
 *
 * Wraps the head/tail/important-line split (from P0-B's `important-line-classifier.ts`)
 * as a pipeline stage so it composes with other stages (ANSI strip, blank
 * collapse, etc.). When the input is at or below `maxChars`, returns the
 * input unchanged (idempotent — the pipeline gate then marks this stage as
 * a no-op).
 *
 * Marker wording is parameterized so the SAME stage serves both `compactString`
 * ("compacted ... chars") and `readIfSmall` ("truncated ... chars") with
 * their distinct separators. Defaults match `compactString`'s pre-P0-A output
 * exactly so that callers that do not opt into additional stages get
 * bit-identical output (L4 backward-compat safety).
 */
import type { ICompactStage } from "../compact-pipeline.ts";
import { splitWithImportantLines } from "../important-line-classifier.ts";

export interface TruncationMarkerConfig {
	/** "compacted" (compactString default) or "truncated" (readIfSmall default). */
	verb: "compacted" | "truncated";
	/** Unit reported in the marker. Both callers currently use "chars" post-Sprint 1. */
	unit: "chars" | "bytes";
	/** Newline(s) between `head` and the marker line. compactString uses "\n"; readIfSmall uses "\n\n". */
	headSeparator: string;
	/** Newline(s) between the marker (or joined important lines) and `tail`. Both callers use "\n". */
	tailSeparator: string;
}

const DEFAULT_MARKER: TruncationMarkerConfig = {
	verb: "compacted",
	unit: "chars",
	headSeparator: "\n",
	tailSeparator: "\n",
};

export class TruncationStage implements ICompactStage {
	readonly id = "truncation";
	private readonly maxChars: number;
	private readonly preserveImportant: boolean;
	private readonly marker: TruncationMarkerConfig;
	constructor(
		maxChars: number,
		opts: {
			preserveImportant?: boolean;
			marker?: Partial<TruncationMarkerConfig>;
		} = {},
	) {
		if (!Number.isFinite(maxChars) || maxChars <= 0) {
			throw new Error(`TruncationStage: maxChars must be a positive finite number, got ${maxChars}`);
		}
		this.maxChars = maxChars;
		this.preserveImportant = opts.preserveImportant !== false;
		this.marker = { ...DEFAULT_MARKER, ...(opts.marker ?? {}) };
	}
	apply(text: string): string {
		if (text.length <= this.maxChars) return text;
		const { head, tail, importantLines, baseDropped } = splitWithImportantLines(text, this.maxChars, {
			preserveImportant: this.preserveImportant,
		});
		let result: string;
		if (importantLines.length === 0) {
			result = `${head}${this.marker.headSeparator}...[pi-crew ${this.marker.verb} ${baseDropped} ${this.marker.unit}, head+tail preserved]...${this.marker.tailSeparator}${tail}`;
		} else {
			const joined = importantLines.join("\n");
			const remaining = text.length - head.length - tail.length - joined.length;
			result = `${head}${this.marker.headSeparator}...[pi-crew ${this.marker.verb} ${baseDropped} ${this.marker.unit}, head+tail + ${importantLines.length} important lines preserved, ${remaining} ${this.marker.unit} remaining dropped]...\n${joined}${this.marker.tailSeparator}${tail}`;
		}
		// Defense-in-depth: this stage's own monotonic-shrink invariant. The
		// pipeline gate is a SECOND line of defense.
		if (result.length >= text.length) return text;
		return result;
	}
}
