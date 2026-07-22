/**
 * ndjson.ts — Canonical broker NDJSON framing primitives (encoder + decoder
 *              + typed errors). Newline-delimited JSON, one frame per `\\n`.
 *
 * Moved out of the parallel-work stub `src/runtime/crew-broker-deps.ts`.
 * The public surface (MAX_BROKER_FRAME_BYTES, BrokerError, BrokerErrorCode,
 * encodeBrokerFrame, NdjsonDecoder) is preserved verbatim so importers
 * can be updated with a single import-path change.
 *
 * No internal dependencies on other src/ modules — only Node built-ins.
 */

/** Maximum encoded NDJSON frame size in UTF-8 bytes, INCLUDING the trailing `\n`. */
export const MAX_BROKER_FRAME_BYTES = 256 * 1024;

// ============================================================================
// BrokerError — typed protocol errors
// ============================================================================

export type BrokerErrorCode = "oversize-frame" | "auth" | "protocol" | "timeout" | "close" | "not-implemented" | "rate-limit";

export class BrokerError extends Error {
	readonly code: BrokerErrorCode;
	constructor(code: BrokerErrorCode, message: string) {
		super(message);
		this.name = "BrokerError";
		this.code = code;
	}
}

// ============================================================================
// NDJSON encoder
// ============================================================================

/**
 * Encode a value as a single NDJSON frame (one JSON object terminated by `\n`).
 * Rejects values whose encoded byte length exceeds MAX_BROKER_FRAME_BYTES BEFORE
 * returning. Throws BrokerError("oversize-frame") for over-size payloads.
 */
export function encodeBrokerFrame(value: unknown): Buffer {
	// Stringify with replacer to drop undefined/function values (matches JSON.stringify semantics).
	const json = JSON.stringify(value);
	if (json === undefined) {
		// Cannot encode (e.g. circular) — surface a typed protocol error.
		throw new BrokerError("protocol", "encodeBrokerFrame: value is not JSON-serializable");
	}
	const enc = Buffer.from(json, "utf8");
	// +1 for the trailing '\n'.
	if (enc.length + 1 > MAX_BROKER_FRAME_BYTES) {
		throw new BrokerError("oversize-frame", `frame exceeds ${MAX_BROKER_FRAME_BYTES} bytes (got ${enc.length + 1})`);
	}
	const out = Buffer.allocUnsafe(enc.length + 1);
	enc.copy(out);
	out[enc.length] = 0x0a; // '\n'
	return out;
}

// ============================================================================
// NDJSON decoder
// ============================================================================

/** Cap the partial-frame accumulator to 2 * MAX_BROKER_FRAME_BYTES. Beyond that
 *  we surface oversize-frame and let the caller close. The 2x headroom is
 *  enough to assemble one full frame from chunks of any size. */
const MAX_DECODER_BUFFER = 2 * MAX_BROKER_FRAME_BYTES;

export class NdjsonDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	/**
	 * Push a chunk; return the array of complete parsed values (each was
	 * followed by a `\n` in the stream). May return zero items (no full
	 * frame yet), one item, or many items. Malformed JSON throws
	 * BrokerError("protocol"); over-size accumulated buffer throws
	 * BrokerError("oversize-frame"). Callers must catch and close the socket.
	 */
	push(chunk: Buffer): unknown[] {
		if (chunk.length === 0) return [];
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		if (this.buffer.length > MAX_DECODER_BUFFER) {
			throw new BrokerError("oversize-frame", `decoder buffer exceeded ${MAX_DECODER_BUFFER} bytes`);
		}
		const out: unknown[] = [];
		let idx = this.buffer.indexOf(0x0a);
		while (idx !== -1) {
			const line = this.buffer.subarray(0, idx);
			// Empty lines are skipped (lenient — mirrors herdr/NDJSON practice).
			if (line.length > 0) {
				// Reject an oversize LINE before parse.
				if (line.length > MAX_BROKER_FRAME_BYTES) {
					throw new BrokerError("oversize-frame", `line exceeds ${MAX_BROKER_FRAME_BYTES} bytes (got ${line.length})`);
				}
				try {
					out.push(JSON.parse(line.toString("utf8")));
				} catch (cause) {
					throw new BrokerError("protocol", `ndjson: malformed JSON: ${(cause as Error).message}`);
				}
			}
			// Advance past the consumed line + newline.
			this.buffer = this.buffer.subarray(idx + 1);
			idx = this.buffer.indexOf(0x0a);
		}
		return out;
	}

	reset(): void {
		this.buffer = Buffer.alloc(0);
	}
}
