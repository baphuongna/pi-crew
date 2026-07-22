/**
 * crew-broker-deps.ts — Parallel-work shim for executor B (broker skeleton).
 *
 * =====================================================================
 * STUB — TEMPORARY FOR PARALLEL EXECUTION
 * =====================================================================
 *
 * Sibling executor A is implementing the canonical
 *   `src/utils/socket-path.ts` (sub-task 0.1)
 *   `src/utils/ndjson.ts`        (sub-task 0.2)
 * in a different worktree. To allow this worker's broker and client to
 * typecheck and test independently, this module re-declares the EXACT
 * public surface the plan promises (`reports/inter-pi-broker-impl-plan-2026-07-21.md`
 * §"Proposed API" for 0.1 and 0.2), with internally-consistent behavior.
 *
 * The integration verifier (Phase 0 gate, verifier E) replaces this shim
 * with `import { ... } from "../utils/socket-path.ts"` /
 * `from "../utils/ndjson.ts"` and runs the full test suite. If the real
 * modules disagree with the contract below, the verifier flags the diff.
 *
 * DO NOT add public exports beyond what executor A will provide. Any
 * additional surface here is dead code in the merged tree.
 * =====================================================================
 */

import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Constants — must match executor A's ndjson.ts exactly
// ============================================================================

/** Maximum encoded NDJSON frame size in UTF-8 bytes, INCLUDING the trailing `\n`. */
export const MAX_BROKER_FRAME_BYTES = 256 * 1024;

// ============================================================================
// BrokerError — must match executor A's ndjson.ts exactly
// ============================================================================

export type BrokerErrorCode =
	| "oversize-frame"
	| "auth"
	| "protocol"
	| "timeout"
	| "close"
	| "not-implemented"
	| "rate-limit";

export class BrokerError extends Error {
	readonly code: BrokerErrorCode;
	constructor(code: BrokerErrorCode, message: string) {
		super(message);
		this.name = "BrokerError";
		this.code = code;
	}
}

// ============================================================================
// NDJSON encoder — must match executor A's ndjson.ts exactly
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
// NDJSON decoder — must match executor A's NdjsonDecoder class
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

// ============================================================================
// Socket path — must match executor A's src/utils/socket-path.ts exactly
// ============================================================================

/** Default hash length for the short socket filename (8 hex chars). */
const DEFAULT_PATH_HASH_LEN = 8;

/** POSIX sun_path cap (108 bytes including the null terminator). Use 107 for the
 *  string portion of the path. */
const POSIX_SUN_PATH_BUDGET = 107;

/** SHA-256 hex prefix of `sessionId`. `length` defaults to 8; must be in [4, 32]. */
export function hashSessionId(sessionId: string, length: number = DEFAULT_PATH_HASH_LEN): string {
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new Error("hashSessionId: sessionId must be a non-empty string");
	}
	if (!Number.isInteger(length) || length < 4 || length > 32) {
		throw new Error(`hashSessionId: length must be an integer in [4, 32] (got ${length})`);
	}
	const hex = createHash("sha256").update(sessionId, "utf8").digest("hex");
	return hex.substring(0, length);
}

/** Resolve the broker endpoint for the given session.
 *
 *  - POSIX: `${XDG_RUNTIME_DIR || os.tmpdir()}/pi-crew-<hash8>.sock` (dir
 *    0700 enforced by `prepareBrokerSocketDir`; socket 0600 by the server).
 *  - Windows: `\\\\.\\pipe\\pi-crew-broker-<hash8>`.
 *  - Throws if the encoded POSIX path exceeds sun_path (108 bytes) — the
 *    caller cannot fix this without changing the hash length, so fail fast. */
export function getBrokerSocketPath(sessionId: string, platform: NodeJS.Platform = process.platform): string {
	const hash = hashSessionId(sessionId);
	if (platform === "win32") {
		return `\\\\.\\pipe\\pi-crew-broker-${hash}`;
	}
	const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
	const sock = path.join(base, `pi-crew-${hash}.sock`);
	const encoded = Buffer.byteLength(sock, "utf8");
	if (encoded > POSIX_SUN_PATH_BUDGET) {
		throw new Error(
			`broker socket path ${encoded} bytes exceeds sun_path budget (${POSIX_SUN_PATH_BUDGET}); check XDG_RUNTIME_DIR or use a shorter hash`,
		);
	}
	return sock;
}

/** Create the parent directory of a broker socket with mode 0700 (POSIX).
 *  Idempotent: if the directory already exists with the correct mode, leaves
 *  it alone. Refuses to operate on a symlink. Windows is a no-op (named pipes
 *  do not have an enclosing dir). */
export async function prepareBrokerSocketDir(sockPath: string): Promise<void> {
	if (process.platform === "win32") return;
	const dir = path.dirname(sockPath);
	// mkdir with mode 0o700; recursive:true so nested paths work.
	await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
	// Tighten mode if it already existed (mkdir with mode ignores on existing).
	try {
		await fsp.chmod(dir, 0o700);
	} catch {
		// ENOENT or EPERM on non-POSIX — best-effort.
	}
}

/** Connect-then-unlink stale socket (herdr pattern). If a live broker is
 *  listening, leave the endpoint intact (EADDRINUSE will surface on bind).
 *  If a stale file exists with no listener, remove it. If the path is a
 *  symlink, refuse rather than follow.
 *
 *  Returns "removed" when the stale entry was unlinked, "kept" when a live
 *  listener was detected, "absent" when no entry existed, "refused"
 *  when the entry is a symlink. */
export async function removeStaleBrokerSocket(
	sockPath: string,
	probeTimeoutMs: number = 250,
): Promise<"removed" | "kept" | "absent" | "refused"> {
	// Reject symlinks outright.
	let st: Awaited<ReturnType<typeof fsp.lstat>>;
	try {
		st = await fsp.lstat(sockPath);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "absent";
		throw e;
	}
	if (st.isSymbolicLink()) return "refused";
	// Bound the probe: connect with a short timeout. If anything answers, treat as live.
	const live = await new Promise<boolean>((resolve) => {
		let settled = false;
		const sock = net.createConnection(sockPath);
		const finish = (v: boolean) => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {
				/* ignore */
			}
			resolve(v);
		};
		sock.once("connect", () => finish(true));
		sock.once("error", () => finish(false));
		setTimeout(() => finish(false), probeTimeoutMs);
	});
	if (live) return "kept";
	// Stale: remove.
	try {
		await fsp.unlink(sockPath);
		return "removed";
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "absent";
		throw e;
	}
}

// ============================================================================
// Convenience: a fresh per-run token (128-bit class) — broker server
// uses this; never logged. Wrapped here so the stub and real files expose
// the same surface for the broker's import.
// ============================================================================

export function newBrokerToken(): string {
	return randomUUID();
}
