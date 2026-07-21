/**
 * crew-broker-tokens.ts — Per-run token registry for the broker.
 *
 * The token map is HEAP ONLY. It lives on the CrewBroker instance and is
 * cleared on `stop()`. It is never serialized to disk, never written to
 * the run directory, never logged, and never exposed via a broker method.
 *
 * Extracted from crew-broker.ts to keep the orchestrator file focused on
 * connection / dispatch logic and to make the registry's invariants
 * independently testable.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";

/** Length guard: tokens are 128-bit-class (UUID v4). */
export type BrokerToken = string;

/** Generate a fresh per-run token. */
export function newBrokerToken(): BrokerToken {
	return randomUUID();
}

/**
 * A small registry mapping runId → token. Operations are O(1) Map.
 * Constant-time compare (`timingSafeEqual`) prevents side-channel
 * comparison leakage of the secret. The compare normalizes both sides
 * to the same byte length — differing-length inputs return false
 * immediately without entering the timing-safe path (length itself is
 * not a secret, only the bytes are).
 */
export class BrokerTokenRegistry {
	private readonly map = new Map<string, BrokerToken>();

	/** Register or replace a runId's token. Returns the new token. */
	issue(runId: string, token: BrokerToken = newBrokerToken()): BrokerToken {
		if (typeof runId !== "string" || runId.length === 0) {
			throw new Error("BrokerTokenRegistry.issue: runId must be a non-empty string");
		}
		this.map.set(runId, token);
		return token;
	}

	/** Look up the token for `runId`. Returns undefined if absent. */
	get(runId: string): BrokerToken | undefined {
		return this.map.get(runId);
	}

	/** Constant-time equality check. Returns false on length mismatch. */
	matches(runId: string, candidate: unknown): boolean {
		const expected = this.map.get(runId);
		if (expected === undefined) return false;
		if (typeof candidate !== "string" || candidate.length === 0) return false;
		const a = Buffer.from(expected, "utf8");
		const b = Buffer.from(candidate, "utf8");
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}

	/** Remove the token for `runId`. */
	revoke(runId: string): void {
		this.map.delete(runId);
	}

	/** Wipe every token. Called from CrewBroker.stop(). */
	clear(): void {
		this.map.clear();
	}

	/** Diagnostic — count of registered tokens. Never returns the tokens. */
	get size(): number {
		return this.map.size;
	}
}
