import assert from "node:assert/strict";
import test from "node:test";
import {
	attachSnapshotSignature,
	getSnapshotHmacKey,
	isSnapshotHmacStrict,
	SNAPSHOT_HMAC_KEY_ENV,
	SNAPSHOT_SIG_PREFIX,
	signSnapshot,
	shouldRejectSnapshot,
	snapshotSignatureMatches,
	stripSnapshotSignature,
	verifySnapshotPayload,
} from "../../../../src/runtime/scratchpad/snapshot-hmac.ts";

const VALID_KEY_HEX = "a".repeat(64); // 32 bytes hex
const VALID_KEY = Buffer.from(VALID_KEY_HEX, "hex");
const PAYLOAD = Buffer.from("hello-scratchpad-snapshot", "utf8");

test("getSnapshotHmacKey: undefined when env unset", () => {
	assert.equal(getSnapshotHmacKey({}), undefined);
	assert.equal(getSnapshotHmacKey({ [SNAPSHOT_HMAC_KEY_ENV]: "" }), undefined);
});

test("getSnapshotHmacKey: accepts hex and utf8 keys >= 32 bytes", () => {
	const hex = getSnapshotHmacKey({ [SNAPSHOT_HMAC_KEY_ENV]: VALID_KEY_HEX });
	assert.ok(hex instanceof Buffer);
	assert.equal(hex?.length, 32);
	const utf8 = getSnapshotHmacKey({ [SNAPSHOT_HMAC_KEY_ENV]: "x".repeat(40) });
	assert.equal(utf8?.length, 40);
});

test("getSnapshotHmacKey: rejects keys shorter than 32 bytes", () => {
	assert.throws(
		() => getSnapshotHmacKey({ [SNAPSHOT_HMAC_KEY_ENV]: "short" }),
		/at least 32 bytes/,
	);
});

test("signSnapshot + snapshotSignatureMatches round-trip", () => {
	const sig = signSnapshot(PAYLOAD, VALID_KEY);
	assert.match(sig, /^[0-9a-f]{64}$/);
	assert.equal(snapshotSignatureMatches(PAYLOAD, sig, VALID_KEY), true);
	assert.equal(snapshotSignatureMatches(Buffer.from("tampered", "utf8"), sig, VALID_KEY), false);
	// Different key → mismatch.
	assert.equal(snapshotSignatureMatches(PAYLOAD, sig, Buffer.from("b".repeat(64), "hex")), false);
	// Length-mismatch short-circuits without throwing.
	assert.equal(snapshotSignatureMatches(PAYLOAD, "deadbeef", VALID_KEY), false);
});

test("attachSnapshotSignature + stripSnapshotSignature round-trip", () => {
	const signed = attachSnapshotSignature(PAYLOAD, VALID_KEY);
	assert.ok(signed.subarray(0, SNAPSHOT_SIG_PREFIX.length).toString("utf8") === SNAPSHOT_SIG_PREFIX);
	const stripped = stripSnapshotSignature(signed);
	assert.deepEqual(stripped, PAYLOAD);
	// Stripping a payload without a prefix is a no-op.
	assert.deepEqual(stripSnapshotSignature(PAYLOAD), PAYLOAD);
});

test("verifySnapshotPayload: hmac-disabled when key undefined", () => {
	const outcome = verifySnapshotPayload(PAYLOAD, undefined, false);
	assert.equal(outcome.kind, "hmac-disabled");
	assert.equal(shouldRejectSnapshot(outcome), false);
});

test("verifySnapshotPayload: unsigned when prefix absent", () => {
	const lax = verifySnapshotPayload(PAYLOAD, VALID_KEY, false);
	assert.equal(lax.kind, "unsigned");
	assert.equal(lax.strict, false);
	assert.equal(shouldRejectSnapshot(lax), false); // migration: accept
	const strict = verifySnapshotPayload(PAYLOAD, VALID_KEY, true);
	assert.equal(strict.kind, "unsigned");
	assert.equal(strict.strict, true);
	assert.equal(shouldRejectSnapshot(strict), true); // Phase 2: reject
});

test("verifySnapshotPayload: verified for a properly signed payload", () => {
	const signed = attachSnapshotSignature(PAYLOAD, VALID_KEY);
	const outcome = verifySnapshotPayload(signed, VALID_KEY, false);
	assert.equal(outcome.kind, "verified");
	assert.equal(shouldRejectSnapshot(outcome), false);
});

test("verifySnapshotPayload: mismatch when signature is wrong / tampered", () => {
	const signed = attachSnapshotSignature(PAYLOAD, VALID_KEY);
	// Flip one byte of the body after the signature line.
	const newlineIdx = signed.indexOf(0x0a, SNAPSHOT_SIG_PREFIX.length);
	assert.ok(newlineIdx > 0);
	const tampered = Buffer.from(signed);
	tampered[tampered.length - 1] ^= 0xff;
	const lax = verifySnapshotPayload(tampered, VALID_KEY, false);
	assert.equal(lax.kind, "mismatch");
	assert.equal(shouldRejectSnapshot(lax), false); // migration: accept with warn
	const strict = verifySnapshotPayload(tampered, VALID_KEY, true);
	assert.equal(strict.kind, "mismatch");
	assert.equal(shouldRejectSnapshot(strict), true); // Phase 2: reject
});

test("verifySnapshotPayload: treats prefix-only as unsigned (no newline)", () => {
	const partial = Buffer.from(SNAPSHOT_SIG_PREFIX + "deadbeef", "utf8"); // no \n
	const outcome = verifySnapshotPayload(partial, VALID_KEY, false);
	assert.equal(outcome.kind, "unsigned");
});

test("isSnapshotHmacStrict: reads PI_CREW_SNAPSHOT_HMAC_STRICT", () => {
	assert.equal(isSnapshotHmacStrict({}), false);
	assert.equal(isSnapshotHmacStrict({ PI_CREW_SNAPSHOT_HMAC_STRICT: "1" }), true);
	assert.equal(isSnapshotHmacStrict({ PI_CREW_SNAPSHOT_HMAC_STRICT: "true" }), true);
	assert.equal(isSnapshotHmacStrict({ PI_CREW_SNAPSHOT_HMAC_STRICT: "0" }), false);
});
