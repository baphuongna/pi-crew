import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	clearRpcSecret,
	setRpcSecret,
	createRpcSignature,
	verifyRpcSignature,
	signRpcRequest,
	withHmacVerification,
	extractSignaturePayload,
	isHmacEnabled,
	RPC_HMAC_VERSION,
} from "../../src/extension/rpc-hmac.ts";

describe("RPC HMAC authentication", () => {
	const TEST_SECRET = "test-secret-for-rpc-hmac-1234567890";

	beforeEach(() => {
		clearRpcSecret();
	});

	describe("secret management", () => {
		it("isHmacEnabled returns false when no secret set", () => {
			clearRpcSecret();
			assert.equal(isHmacEnabled(), false);
		});

		it("isHmacEnabled returns true when secret is set", () => {
			setRpcSecret(TEST_SECRET);
			assert.equal(isHmacEnabled(), true);
		});

		it("isHmacEnabled returns false for empty string", () => {
			setRpcSecret("");
			assert.equal(isHmacEnabled(), false);
		});
	});

	describe("signature creation", () => {
		beforeEach(() => {
			setRpcSecret(TEST_SECRET);
		});

		it("creates a valid signature payload", () => {
			const body = { requestId: "test-123", goal: "hello" };
			const sig = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			assert.equal(sig.version, RPC_HMAC_VERSION);
			assert.equal(sig.origin, "test-ext");
			assert.equal(sig.channel, "pi-crew:rpc:ping");
			assert.ok(typeof sig.timestamp === "number");
			assert.ok(typeof sig.nonce === "string");
			assert.ok(sig.nonce.length === 32); // 16 bytes hex = 32 chars
			assert.ok(typeof sig.signature === "string");
			assert.ok(sig.signature.length === 64); // SHA-256 hex = 64 chars
		});

		it("throws when no secret configured", () => {
			clearRpcSecret();
			assert.throws(() => createRpcSignature("test-ext", "pi-crew:rpc:ping", {}), /pi-crew HMAC.*Cannot create signature/);
		});

		it("produces different signatures for different nonces", () => {
			const body = { requestId: "test-123" };
			const sig1 = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);
			const sig2 = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			// Nonces should be different (random)
			assert.notEqual(sig1.nonce, sig2.nonce);
			// But signatures should also be different (because of different nonces)
			assert.notEqual(sig1.signature, sig2.signature);
		});
	});

	describe("signature verification", () => {
		beforeEach(() => {
			setRpcSecret(TEST_SECRET);
		});

		it("verifies a valid signature", () => {
			const body = { requestId: "test-123", goal: "hello" };
			const sig = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			const result = verifyRpcSignature(sig, body);
			assert.deepEqual(result, { valid: true });
		});

		it("rejects when secret not configured", () => {
			clearRpcSecret();
			const sig = {
				version: RPC_HMAC_VERSION,
				origin: "test-ext",
				timestamp: Date.now(),
				channel: "pi-crew:rpc:ping",
				nonce: "abc123",
				signature: "fake-sig",
			};

			const result = verifyRpcSignature(sig, {});
			assert.equal(result.valid, false);
			assert.ok(result.valid === false);
			assert.ok(typeof result.reason === "string");
			assert.ok(result.reason.includes("not configured"));
		});

		it("rejects wrong version", () => {
			const body = { requestId: "test-123" };
			const sig = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			const result = verifyRpcSignature({ ...sig, version: 999 }, body);
			assert.equal(result.valid, false);
		});

		it("rejects expired signature", () => {
			const body = { requestId: "test-123" };
			const sig = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			// Set timestamp far in the past (beyond validity window)
			const expiredSig = { ...sig, timestamp: Date.now() - 20 * 60 * 1000 }; // 20 min ago
			const result = verifyRpcSignature(expiredSig, body);
			assert.equal(result.valid, false);
			assert.ok(typeof result.reason === "string");
			assert.ok(result.reason.includes("expired"));
		});

		it("rejects signature from the future (beyond clock skew)", () => {
			const body = { requestId: "test-123" };
			const sig = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			// Set timestamp far in the future
			const futureSig = { ...sig, timestamp: Date.now() + 20 * 60 * 1000 }; // 20 min ahead
			const result = verifyRpcSignature(futureSig, body);
			assert.equal(result.valid, false);
			assert.ok(typeof result.reason === "string");
			assert.ok(result.reason.includes("future"));
		});

		it("rejects tampered body", () => {
			const body = { requestId: "test-123", goal: "hello" };
			const sig = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			const tamperedBody = { requestId: "test-123", goal: "malicious" };
			const result = verifyRpcSignature(sig, tamperedBody);
			assert.equal(result.valid, false);
		});

		it("rejects invalid signature string", () => {
			const body = { requestId: "test-123" };
			const sig = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			const result = verifyRpcSignature({ ...sig, signature: "invalid-hex-not-real-sig" }, body);
			assert.equal(result.valid, false);
		});
	});

	describe("signRpcRequest helper", () => {
		beforeEach(() => {
			setRpcSecret(TEST_SECRET);
		});

		it("attaches HMAC fields to params", () => {
			const params = { requestId: "test-123", goal: "hello" };
			const signed = signRpcRequest(params, "test-ext", "pi-crew:rpc:ping");

			assert.equal(signed.requestId, "test-123");
			assert.equal(signed.goal, "hello");
			assert.equal(signed.hmacVersion, RPC_HMAC_VERSION);
			assert.equal(signed.hmacOrigin, "test-ext");
			assert.equal(signed.hmacChannel, "pi-crew:rpc:ping");
			assert.ok(typeof signed.hmacTimestamp === "number");
			assert.ok(typeof signed.hmacNonce === "string");
			assert.ok(typeof signed.hmacSignature === "string");
		});

		it("produces a verifiable signature", () => {
			const params = { requestId: "test-123", goal: "hello" };
			const signed = signRpcRequest(params, "test-ext", "pi-crew:rpc:ping");

			const sigPayload = {
				version: signed.hmacVersion,
				origin: signed.hmacOrigin,
				timestamp: signed.hmacTimestamp,
				channel: signed.hmacChannel,
				nonce: signed.hmacNonce,
				signature: signed.hmacSignature,
			};

			const result = verifyRpcSignature(sigPayload, params);
			assert.deepEqual(result, { valid: true });
		});
	});

	describe("extractSignaturePayload", () => {
		it("returns null for non-object input", () => {
			assert.equal(extractSignaturePayload(null), null);
			assert.equal(extractSignaturePayload(undefined), null);
			assert.equal(extractSignaturePayload("string"), null);
			assert.equal(extractSignaturePayload(123), null);
			assert.equal(extractSignaturePayload([]), null);
		});

		it("returns null when fields missing", () => {
			assert.equal(extractSignaturePayload({ requestId: "test" }), null);
			assert.equal(
				extractSignaturePayload({
					hmacVersion: 1,
					hmacOrigin: "ext",
					// missing others
				}),
				null,
			);
		});

		it("extracts valid payload", () => {
			const params = {
				requestId: "test",
				hmacVersion: 1,
				hmacOrigin: "ext",
				hmacTimestamp: Date.now(),
				hmacChannel: "pi-crew:rpc:ping",
				hmacNonce: "abc",
				hmacSignature: "def",
			};

			const payload = extractSignaturePayload(params);
			assert.ok(payload !== null);
			assert.equal(payload!.version, 1);
			assert.equal(payload!.origin, "ext");
			assert.equal(payload!.channel, "pi-crew:rpc:ping");
			assert.equal(payload!.nonce, "abc");
			assert.equal(payload!.signature, "def");
		});
	});

	describe("withHmacVerification middleware", () => {
		it("passes through when HMAC not configured (backward compat)", () => {
			clearRpcSecret();
			let called = false;
			const handler = withHmacVerification((params: { requestId: string }) => {
				called = true;
				return { ok: true };
			}, "pi-crew:rpc:ping");

			const result = handler({ requestId: "test" });
			assert.equal(called, true);
			assert.deepEqual(result, { ok: true });
		});

		it("passes through valid signed request when HMAC enabled", () => {
			setRpcSecret(TEST_SECRET);
			const params = { requestId: "test-123", goal: "hello" };
			const signed = signRpcRequest(params, "test-ext", "pi-crew:rpc:ping");

			let called = false;
			const handler = withHmacVerification((p: typeof signed) => {
				called = true;
				return { ok: true };
			}, "pi-crew:rpc:ping");

			const result = handler(signed);
			assert.equal(called, true);
			assert.deepEqual(result, { ok: true });
		});

		it("rejects unsigned request when HMAC enabled", () => {
			setRpcSecret(TEST_SECRET);
			const handler = withHmacVerification((params: { requestId: string }) => {
				return { ok: true };
			}, "pi-crew:rpc:ping");

			assert.throws(() => handler({ requestId: "test" }), /pi-crew HMAC.*Missing HMAC signature/);
		});

		it("rejects request with invalid HMAC when HMAC enabled", () => {
			setRpcSecret(TEST_SECRET);
			const handler = withHmacVerification((params: { requestId: string }) => {
				return { ok: true };
			}, "pi-crew:rpc:ping");

			const badParams = {
				requestId: "test",
				hmacVersion: 1,
				hmacOrigin: "malicious-ext",
				hmacTimestamp: Date.now(),
				hmacChannel: "pi-crew:rpc:ping",
				hmacNonce: "abc123",
				hmacSignature: "0000000000000000000000000000000000000000000000000000000000000000",
			};

			assert.throws(() => handler(badParams as any), /pi-crew HMAC.*mismatch/);
		});
	});

	describe("cross-channel replay protection", () => {
		beforeEach(() => {
			setRpcSecret(TEST_SECRET);
		});

		it("rejects signature created for different channel", () => {
			const body = { requestId: "test-123" };
			// Sign for channel A
			const sig = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			// Verify against channel B
			const result = verifyRpcSignature({ ...sig, channel: "pi-crew:rpc:run" }, body);
			assert.equal(result.valid, false);
		});
	});

	describe("different secrets produce different signatures", () => {
		it("produces different signatures with different secrets", () => {
			setRpcSecret("secret-1");
			const body = { requestId: "test-123" };
			const sig1 = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			setRpcSecret("secret-2");
			const sig2 = createRpcSignature("test-ext", "pi-crew:rpc:ping", body);

			// Same nonce/timestamp won't match because different secrets
			// (well, they have different nonces anyway due to randomBytes)
			assert.notEqual(sig1.signature, sig2.signature);

			// sig1 should not verify with secret-2
			setRpcSecret("secret-2");
			const result = verifyRpcSignature(sig1, body);
			assert.equal(result.valid, false);
		});
	});
});
