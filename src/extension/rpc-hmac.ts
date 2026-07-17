import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * HMAC-based origin signing for cross-extension RPC.
 *
 * Shared secret is distributed via environment variable PI_CREW_RPC_SECRET.
 * When the secret is configured, all RPC requests must include a valid HMAC
 * signature. When the secret is NOT configured, HMAC is disabled (backward
 * compat for setups that don't need it).
 *
 * Usage:
 *   Sender:   signRpcRequest(params, "my-extension", "pi-crew:rpc:ping")
 *   Receiver: wrap handler with withHmacVerification(handler, channel)
 */

export const RPC_HMAC_VERSION = 1;

const SECRET_ENV_VAR = "PI_CREW_RPC_SECRET";
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000; // 5 min
const SIGNATURE_VALIDITY_MS = 10 * 60 * 1000; // 10 min

// --- Secret management -------------------------------------------------------

/** Get the shared secret. Returns undefined if not configured. */
export function getRpcSecret(): string | undefined {
	return process.env[SECRET_ENV_VAR];
}

/** Set the shared secret (for testing or programmatic setup). */
export function setRpcSecret(secret: string): void {
	process.env[SECRET_ENV_VAR] = secret;
}

/** Clear the shared secret. */
export function clearRpcSecret(): void {
	delete process.env[SECRET_ENV_VAR];
}

/** Whether HMAC authentication is currently enabled. */
export function isHmacEnabled(): boolean {
	return typeof process.env[SECRET_ENV_VAR] === "string" && process.env[SECRET_ENV_VAR].length > 0;
}

// --- Types -------------------------------------------------------------------

export interface RpcSignaturePayload {
	version: number;
	origin: string;
	timestamp: number;
	channel: string;
	nonce: string;
}

export type RpcSignedPayload = RpcSignaturePayload & { signature: string };

// Process-latched: emit a soft, non-alarming note once per process when an RPC
// request is actually processed without HMAC. The previous warning was emitted
// at extension registration (every pi load) and was considered noisy by users
// who never wire cross-extension RPC. Opt out with PI_CREW_SUPPRESS_RPC_WARNING=1.
let _rpcHmacSoftInfoEmitted = false;
function rpcHmacSoftInfoOnce(): void {
	if (_rpcHmacSoftInfoEmitted) return;
	_rpcHmacSoftInfoEmitted = true;
	console.warn(
		"[pi-crew] PI_CREW_RPC_SECRET not set; cross-extension RPC requests will be accepted without origin authentication. " +
			"Operation allowlists and session checks still apply. Set PI_CREW_RPC_SECRET or PI_CREW_SUPPRESS_RPC_WARNING=1 to silence this message.",
	);
}

// --- Signing -----------------------------------------------------------------

/**
 * Create an HMAC signature for an RPC request.
 *
 * @throws if no secret is configured
 */
export function createRpcSignature(origin: string, channel: string, body: unknown): RpcSignedPayload {
	const secret = getRpcSecret();
	if (!secret) {
		throw new Error(`[pi-crew HMAC] Cannot create signature: ${SECRET_ENV_VAR} not set.`);
	}

	const payload: RpcSignaturePayload = {
		version: RPC_HMAC_VERSION,
		origin,
		timestamp: Date.now(),
		channel,
		nonce: randomBytes(16).toString("hex"),
	};

	const signature = computeHmac(secret, payload, body);
	return { ...payload, signature };
}

// --- Verification ------------------------------------------------------------

/**
 * Verify an HMAC signature.
 *
 * @returns `{ valid: true }` or `{ valid: false, reason: string }`
 */
export function verifyRpcSignature(payload: RpcSignedPayload, body: unknown): { valid: true } | { valid: false; reason: string } {
	const secret = getRpcSecret();
	if (!secret) {
		return { valid: false, reason: `[pi-crew HMAC] ${SECRET_ENV_VAR} not configured.` };
	}

	if (payload.version !== RPC_HMAC_VERSION) {
		return { valid: false, reason: `HMAC version mismatch: expected ${RPC_HMAC_VERSION}, got ${payload.version}` };
	}

	const now = Date.now();
	const age = now - payload.timestamp;
	if (age < -CLOCK_SKEW_TOLERANCE_MS) {
		return { valid: false, reason: `HMAC timestamp in the future by ${Math.abs(age)}ms` };
	}
	if (age > SIGNATURE_VALIDITY_MS) {
		return { valid: false, reason: `HMAC signature expired (${age}ms old)` };
	}

	const expected = computeHmac(secret, payload, body);
	return timingSafeCompare(payload.signature, expected) ? { valid: true } : { valid: false, reason: "HMAC signature mismatch" };
}

// --- Middleware --------------------------------------------------------------

/**
 * Wrap an RPC handler with HMAC verification.
 *
 * When HMAC is NOT configured (getRpcSecret() returns undefined), requests
 * without signatures are passed through (backward compat). When HMAC IS
 * configured, unsigned or invalid signatures are rejected.
 */
export function withHmacVerification<P extends { requestId: string }>(
	handler: (params: P) => unknown | Promise<unknown>,
	_channel: string,
): (params: P) => unknown | Promise<unknown> {
	return (params: P) => {
		if (!isHmacEnabled()) {
			// No secret configured → backward compat: allow unsigned.
			// Emit a soft info note (once per process) only when an actual RPC
			// request is being processed — the prior registration-time warning
			// was too noisy for users who never wire cross-extension RPC.
			if (process.env.PI_CREW_SUPPRESS_RPC_WARNING !== "1") {
				rpcHmacSoftInfoOnce();
			}
			return handler(params);
		}

		const sigPayload = extractSignaturePayload(params);
		if (!sigPayload) {
			throw new Error("[pi-crew HMAC] Missing HMAC signature in RPC request.");
		}

		// Strip HMAC fields from body before verification (HMAC was signed over original params)
		const originalBody = stripHmacFields(params);
		const verification = verifyRpcSignature(sigPayload, originalBody);
		if (!verification.valid) {
			throw new Error(`[pi-crew HMAC] ${verification.reason}`);
		}

		// Pass original params (with HMAC fields stripped) to handler
		return handler(originalBody as P);
	};
}

// --- Helpers -----------------------------------------------------------------

/**
 * Attach HMAC signature fields to RPC request params.
 */
export function signRpcRequest<P extends Record<string, unknown>>(
	params: P,
	origin: string,
	channel: string,
): P & {
	hmacVersion: number;
	hmacOrigin: string;
	hmacTimestamp: number;
	hmacChannel: string;
	hmacNonce: string;
	hmacSignature: string;
} {
	const signed = createRpcSignature(origin, channel, params);
	return {
		...params,
		hmacVersion: signed.version,
		hmacOrigin: signed.origin,
		hmacTimestamp: signed.timestamp,
		hmacChannel: signed.channel,
		hmacNonce: signed.nonce,
		hmacSignature: signed.signature,
	};
}

// --- Internal ----------------------------------------------------------------

/** Strip HMAC signature fields from params to get the original body. */
function stripHmacFields<P extends Record<string, unknown>>(params: P): Partial<P> {
	const result = { ...params };
	delete result.hmacVersion;
	delete result.hmacOrigin;
	delete result.hmacTimestamp;
	delete result.hmacChannel;
	delete result.hmacNonce;
	delete result.hmacSignature;
	return result;
}

function computeHmac(secret: string, payload: RpcSignaturePayload, body: unknown): string {
	const payloadForHmac = {
		version: payload.version,
		origin: payload.origin,
		timestamp: payload.timestamp,
		channel: payload.channel,
		nonce: payload.nonce,
	};
	const message = `${JSON.stringify(payloadForHmac)}:${JSON.stringify(body)}`;
	return createHmac("sha256", secret).update(message).digest("hex");
}

function timingSafeCompare(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "hex");
	const bufB = Buffer.from(b, "hex");
	const maxLen = Math.max(bufA.length, bufB.length);
	const safeA = Buffer.alloc(maxLen);
	const safeB = Buffer.alloc(maxLen);
	bufA.copy(safeA);
	bufB.copy(safeB);
	const equal = timingSafeEqual(safeA, safeB);
	return equal && bufA.length === bufB.length;
}

/** Extract HMAC signature payload from request params. */
export function extractSignaturePayload(params: unknown): RpcSignedPayload | null {
	if (!params || typeof params !== "object" || Array.isArray(params)) return null;
	const obj = params as Record<string, unknown>;
	if (
		typeof obj.hmacVersion !== "number" ||
		typeof obj.hmacOrigin !== "string" ||
		typeof obj.hmacTimestamp !== "number" ||
		typeof obj.hmacChannel !== "string" ||
		typeof obj.hmacNonce !== "string" ||
		typeof obj.hmacSignature !== "string"
	) {
		return null;
	}
	return {
		version: obj.hmacVersion,
		origin: obj.hmacOrigin,
		timestamp: obj.hmacTimestamp,
		channel: obj.hmacChannel,
		nonce: obj.hmacNonce,
		signature: obj.hmacSignature,
	};
}
