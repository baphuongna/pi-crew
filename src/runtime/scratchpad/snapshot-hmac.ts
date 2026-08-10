/**
 * Snapshot HMAC helper — opt-in integrity for scratchpad snapshots.
 *
 * Closes the E.2 gap declared in docs/improvement-plan-2026-08-09.md and
 * docs/runtime/scratchpad/README.md:120 ("v8.deserialize of restore content
 * is unauthenticated (no HMAC)"). The threat model — a same-uid attacker
 * plants a crafted V8 blob at the snapshot path to run deserialize gadgets
 * in the guest — does not cross the existing same-uid boundary, but HMAC
 * hardening is required before snapshots ever land in a shared/networked
 * store.
 *
 * Migration window (see docs/decisions/2026-08-10-scratchpad-snapshot-hmac.md):
 *
 *   Phase 1 (this module): HMAC sign-on-write + verify-on-read are OPT-IN
 *     via PI_CREW_SNAPSHOT_HMAC_KEY. When the key is unset, behaviour is
 *     unchanged (snapshots remain unsigned). When the key is set, writes
 *     attach a signature and reads verify it; an unsigned/failed snapshot
 *     is ACCEPTED with a warning so existing snapshots remain readable.
 *   Phase 2 (after one release): unsigned snapshots are REJECTED when the
 *     key is set (configurable via PI_CREW_SNAPSHOT_HMAC_STRICT=1).
 *   Phase 3 (after snapshots move to a shared store): the key becomes
 *     required and unsigned snapshots are always rejected.
 *
 * Wire-up into the actual write/read paths is intentionally deferred to a
 * follow-up that audits the snapshot envelope format (V8 base64 vs raw
 * bytes) and the writeArtifact redaction interaction. See ADR for the plan.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Env var holding the HMAC secret. When unset, HMAC is disabled (Phase 0
 * behaviour — snapshots unsigned). When set, sign-on-write and
 * verify-on-read are enabled.
 */
export const SNAPSHOT_HMAC_KEY_ENV = "PI_CREW_SNAPSHOT_HMAC_KEY";

/**
 * Opt-in strict mode (Phase 2): when the key is set AND this is "1",
 * unsigned or signature-mismatched snapshots are REJECTED on read instead
 * of accepted with a warning.
 */
export const SNAPSHOT_HMAC_STRICT_ENV = "PI_CREW_SNAPSHOT_HMAC_STRICT";

/**
 * Header prefix for an inline signature. When snapshots are signed, the
 * signature is prepended to the blob as `PI_CREW_SIG=<hex>\n` so a single
 * read yields both the signature and the payload. (Sidecar files would
 * require writeArtifact coordination that the envelope format does not
 * currently support.)
 */
export const SNAPSHOT_SIG_PREFIX = "PI_CREW_SIG=";

export function getSnapshotHmacKey(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
	const raw = env[SNAPSHOT_HMAC_KEY_ENV];
	if (!raw) return undefined;
	// Accept hex-encoded keys directly; otherwise encode the string as utf8.
	// A key shorter than 32 bytes is rejected to prevent trivial brute-force.
	const buf = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
		? Buffer.from(raw, "hex")
		: Buffer.from(raw, "utf8");
	if (buf.length < 32) {
		throw new Error(
			`${SNAPSHOT_HMAC_KEY_ENV} must be at least 32 bytes (got ${buf.length}); use a longer key or generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
		);
	}
	return buf;
}

export function isSnapshotHmacStrict(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[SNAPSHOT_HMAC_STRICT_ENV] === "1" || env[SNAPSHOT_HMAC_STRICT_ENV] === "true";
}

/**
 * Compute the HMAC-SHA256 signature of `content` under `key`. Returns a
 * lowercase hex string.
 */
export function signSnapshot(content: Buffer | string, key: Buffer): string {
	return createHmac("sha256", key).update(content).digest("hex");
}

/**
 * Constant-time signature comparison. Both signatures must be lowercase
 * hex of the same length; anything else returns false without throwing.
 */
export function snapshotSignatureMatches(content: Buffer | string, signature: string, key: Buffer): boolean {
	const expected = signSnapshot(content, key);
	const a = Buffer.from(expected);
	const b = Buffer.from(signature);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Outcome of {@link verifySnapshotPayload}. Callers decide how to react
 * based on the strict-mode flag.
 */
export type SnapshotVerifyOutcome =
	| { kind: "unsigned"; strict: boolean }
	| { kind: "verified" }
	| { kind: "mismatch"; strict: boolean }
	| { kind: "hmac-disabled" };

/**
 * Verify a snapshot payload that may or may not carry an inline signature.
 *
 * @param payload The raw bytes read from disk (possibly including the
 *   `PI_CREW_SIG=<hex>\n` prefix).
 * @param key The HMAC key, or `undefined` when HMAC is disabled.
 * @param strict When true, unsigned/mismatched payloads are reported as
 *   rejectable. When false (the Phase 1 default), the caller is expected
 *   to accept the payload with a warning.
 */
export function verifySnapshotPayload(payload: Buffer, key: Buffer | undefined, strict: boolean): SnapshotVerifyOutcome {
	if (!key) return { kind: "hmac-disabled" };
	const prefixStr = SNAPSHOT_SIG_PREFIX;
	if (payload.length < prefixStr.length + 1 || payload.subarray(0, prefixStr.length).toString("utf8") !== prefixStr) {
		return { kind: "unsigned", strict };
	}
	const newlineIdx = payload.indexOf(0x0a, prefixStr.length);
	if (newlineIdx < 0) return { kind: "unsigned", strict };
	const sigHex = payload.subarray(prefixStr.length, newlineIdx).toString("utf8");
	const body = payload.subarray(newlineIdx + 1);
	return snapshotSignatureMatches(body, sigHex, key)
		? { kind: "verified" }
		: { kind: "mismatch", strict };
}

/**
 * Strip the inline signature prefix and return the bare payload. Returns
 * the original buffer when no prefix is present. Used by read paths that
 * have already called {@link verifySnapshotPayload} and decided to accept.
 */
export function stripSnapshotSignature(payload: Buffer): Buffer {
	if (payload.length < SNAPSHOT_SIG_PREFIX.length) return payload;
	if (payload.subarray(0, SNAPSHOT_SIG_PREFIX.length).toString("utf8") !== SNAPSHOT_SIG_PREFIX) return payload;
	const newlineIdx = payload.indexOf(0x0a, SNAPSHOT_SIG_PREFIX.length);
	if (newlineIdx < 0) return payload;
	return payload.subarray(newlineIdx + 1);
}

/**
 * Attach an inline signature to a payload. Returns a new buffer shaped as
 * `PI_CREW_SIG=<hex>\n<payload>`. Used by write paths that have HMAC
 * enabled.
 */
export function attachSnapshotSignature(payload: Buffer, key: Buffer): Buffer {
	const sig = signSnapshot(payload, key);
	return Buffer.concat([Buffer.from(`${SNAPSHOT_SIG_PREFIX}${sig}\n`, "utf8"), payload]);
}

/**
 * Should the caller reject the snapshot based on the verify outcome?
 * Centralises the strict-vs-migration decision so callers stay simple.
 */
export function shouldRejectSnapshot(outcome: SnapshotVerifyOutcome): boolean {
	switch (outcome.kind) {
		case "hmac-disabled":
			return false;
		case "verified":
			return false;
		case "unsigned":
		case "mismatch":
			return outcome.strict;
	}
}
