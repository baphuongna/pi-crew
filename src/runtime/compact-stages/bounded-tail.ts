/**
 * BoundedTail — O(1)-amortized bounded string accumulator (segment ring + running
 * byte counter).
 *
 * Replaces the O(n²) `appendBoundedTail` rebuild-per-line pattern on the child stdout/stderr
 * hot path. The defect (P0-1, verified 2026-07-29): the old accumulator did
 * `new TailCaptureStage(...).apply(current + chunk)` on EVERY output line, so once the
 * buffer filled to the 512 KiB cap each line re-scanned the whole buffer with
 * `Buffer.byteLength` AND ran a per-character `while(...) tail = tail.slice(0,-1)` trim
 * — 2.3 s (ASCII) to 112 s (multi-byte) of main-thread block per task.
 *
 * `push(chunk)` is O(chunk): it appends the segment and shifts whole leading segments
 * while over cap, recomputing byte length only for the dropped segment — never the full
 * buffer, never per-character. The single byte-exact boundary trim runs ONCE, in
 * `value()`, which is read only at result-build / error time (rare).
 *
 * Output parity with the old `TailCaptureStage`-based path is preserved: under cap →
 * verbatim; over cap → `[pi-crew captured output truncated to last X KiB]\n` + the last
 * ≤maxBytes bytes snapped to a UTF-8 char boundary.
 */
import { DEFAULT_CHILD_PI } from "../../config/defaults.ts";

const DEFAULT_MAX_BYTES = DEFAULT_CHILD_PI.maxCaptureBytes;

/** Default marker, identical to the old appendBoundedTail/TailCaptureStage wording. */
function defaultMarker(maxBytes: number): string {
	return `[pi-crew captured output truncated to last ${Math.round(maxBytes / 1024)} KiB]`;
}

export class BoundedTail {
	readonly #maxBytes: number;
	readonly #marker: string;
	#segs: string[] = [];
	#bytes = 0;
	#dropped = false;
	#cached: string | undefined;
	#dirty = false;

	constructor(maxBytes: number = DEFAULT_MAX_BYTES, marker?: string) {
		if (!(maxBytes > 0)) throw new Error(`BoundedTail: maxBytes must be > 0, got ${maxBytes}`);
		this.#maxBytes = maxBytes;
		this.#marker = marker ?? defaultMarker(maxBytes);
	}

	/** Append a chunk. O(chunk) amortized; never scans the full buffer. */
	push(chunk: string): this {
		if (!chunk) return this;
		this.#segs.push(chunk);
		this.#bytes += Buffer.byteLength(chunk, "utf-8");
		// Drop whole leading segments while over cap. Stop at length 1 so a single
		// oversized segment is trimmed exactly once in value() instead of per-char.
		while (this.#bytes > this.#maxBytes && this.#segs.length > 1) {
			const dropped = this.#segs.shift() as string;
			this.#bytes -= Buffer.byteLength(dropped, "utf-8");
			this.#dropped = true;
		}
		this.#dirty = true;
		return this;
	}

	/** Materialize the bounded string. Computed at most once per push; cached otherwise. */
	value(): string {
		if (!this.#dirty && this.#cached !== undefined) return this.#cached;
		const body = this.#segs.join("");
		const result = this.#bound(body);
		this.#cached = result;
		this.#dirty = false;
		return result;
	}

	/** Byte-exact bound with marker parity vs the old TailCaptureStage path. */
	#bound(body: string): string {
		if (Buffer.byteLength(body, "utf-8") <= this.#maxBytes) {
			// Under cap: add the marker only if we dropped earlier segments.
			return this.#dropped ? `${this.#marker}\n${body}` : body;
		}
		// Over cap (single segment larger than max, or a boundary segment): keep the
		// last ≤maxBytes bytes snapped forward past any UTF-8 continuation bytes.
		const buf = Buffer.from(body, "utf-8");
		let start = Math.max(0, buf.length - this.#maxBytes);
		while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
		return `${this.#marker}\n${buf.subarray(start).toString("utf-8")}`;
	}
}
