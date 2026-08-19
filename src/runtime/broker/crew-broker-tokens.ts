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
 * A small registry mapping a key → token. Operations are O(1) Map.
 * Constant-time compare (`timingSafeEqual`) prevents side-channel
 * comparison leakage of the secret. The compare normalizes both sides
 * to the same byte length — differing-length inputs return false
 * immediately without entering the timing-safe path (length itself is
 * not a secret, only the bytes are).
 *
 * The key model is dual: when a `taskId` is provided the key is the
 * compound `${runId}:${taskId}` (per-task isolation, F-06). When taskId
 * is absent the key falls back to bare `runId` (legacy per-run token
 * model). Lookups (`get`, `matches`) try the compound key first and
 * fall back to bare `runId` so that a per-run token issued before the
 * taskId was threaded through still authenticates correctly.
 */
export class BrokerTokenRegistry {
	private readonly map = new Map<string, BrokerToken>();

	/** Compute the registry key. Compound when taskId is present, bare
	 *  runId otherwise (backward-compat with the original per-run model). */
	private key(runId: string, taskId?: string): string {
		return taskId ? `${runId}:${taskId}` : runId;
	}

	/** Registry key reserved for the run's orchestrator token. Distinct from any
	 *  task key — taskIds are safe-path ids and cannot collide with this sentinel. */
	private orchestratorKey(runId: string): string {
		return `${runId}:__orchestrator__`;
	}

	/** Issue (or reuse) the orchestrator token for `runId`. Cryptographically
	 *  distinct from every per-task token — a worker cannot forge orchestrator
	 *  role without it (F-06: closes the self-declared-role privilege escalation). */
	issueOrchestratorToken(runId: string, token?: BrokerToken): BrokerToken {
		if (typeof runId !== "string" || runId.length === 0) {
			throw new Error("BrokerTokenRegistry.issueOrchestratorToken: runId must be a non-empty string");
		}
		const k = this.orchestratorKey(runId);
		if (token === undefined) {
			const existing = this.map.get(k);
			if (existing !== undefined) return existing;
			const fresh = newBrokerToken();
			this.map.set(k, fresh);
			return fresh;
		}
		this.map.set(k, token);
		return token;
	}

	/** Issue a token for `runId` (+optional `taskId`). Idempotent per key:
	 *  if a token already exists for the computed key, the existing token is
	 *  returned unchanged so that concurrent sibling tasks sharing a key all
	 *  authenticate with the same token. Pass an explicit `token` only in
	 *  tests that need a deterministic value. */
	issue(runId: string, taskId?: string, token?: BrokerToken): BrokerToken {
		if (typeof runId !== "string" || runId.length === 0) {
			throw new Error("BrokerTokenRegistry.issue: runId must be a non-empty string");
		}
		const k = this.key(runId, taskId);
		if (token === undefined) {
			const existing = this.map.get(k);
			if (existing !== undefined) return existing;
			const fresh = newBrokerToken();
			this.map.set(k, fresh);
			return fresh;
		}
		this.map.set(k, token);
		return token;
	}

	/** Look up the token for `runId` (+optional `taskId`).
	 *  Tries the compound key first; if absent and taskId was provided,
	 *  falls back to the bare `runId` key (backward-compat fallback). */
	get(runId: string, taskId?: string): BrokerToken | undefined {
		const compound = this.map.get(this.key(runId, taskId));
		if (compound !== undefined) return compound;
		// Backward-compat: per-run token issued without taskId.
		if (taskId) return this.map.get(runId);
		return undefined;
	}

	/** Constant-time equality between an expected token and a candidate.
	 *  Extracted so matches() and tokenRole() share the same compare. */
	private static equalConstTime(expected: BrokerToken | undefined, candidate: unknown): boolean {
		if (expected === undefined) return false;
		if (typeof candidate !== "string" || candidate.length === 0) return false;
		const a = Buffer.from(expected, "utf8");
		const b = Buffer.from(candidate, "utf8");
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}

	/** Backward-compat boolean auth check — delegates to tokenRole(). Prefer
	 *  tokenRole() at auth sites that distinguish orchestrator vs worker
	 *  (F-06: role MUST come from token type, never a self-declared field). */
	matches(runId: string, taskId: string | undefined, candidate: unknown): boolean {
		return this.tokenRole(runId, taskId, candidate) !== null;
	}

	/** Resolve the connection role from the token TYPE. Returns "orchestrator"
	 *  if the candidate matches the run's orchestrator token, "worker" if it
	 *  matches a per-task/per-run token, or null if neither. Orchestrator key
	 *  is checked FIRST so an orchestrator token can never be confused with a
	 *  task token (the two are cryptographically distinct by construction).
	 *  Semantics unchanged since extraction; now delegates to
	 *  tokenRoleWithMatchKind() so both share one compare path. */
	tokenRole(runId: string, taskId: string | undefined, candidate: unknown): "orchestrator" | "worker" | null {
		const resolved = this.tokenRoleWithMatchKind(runId, taskId, candidate);
		return resolved === null ? null : resolved.role;
	}

	/** Same resolution as tokenRole() but also reports HOW the token matched:
	 *  `"compound"` (task-scoped `${runId}:${taskId}` key — or the
	 *  orchestrator key, which is runId-prefixed by construction and can
	 *  never be reached via the fallback) vs `"runId-fallback"` (legacy
	 *  bare-runId key matched because no compound key was issued).
	 *
	 *  WP-2/R2 (ADR-0 2026-08-17-waiting-producer-ask item 6): the broker's
	 *  `wait.*` methods authenticate via task-scoped tokens ONLY — a
	 *  `"runId-fallback"` match is rejected at the dispatch site with a
	 *  migrate hint. Legacy methods keep using tokenRole()/matches() and
	 *  therefore keep accepting the fallback (backward compat preserved).
	 *
	 *  Match semantics mirror tokenRole() exactly: the bare-runId fallback is
	 *  consulted ONLY when no compound key exists for (runId, taskId) — a
	 *  candidate matching the bare key while a DIFFERENT compound key exists
	 *  still returns null (no accidental fallback activation). */
	tokenRoleWithMatchKind(
		runId: string,
		taskId: string | undefined,
		candidate: unknown,
	): { role: "orchestrator" | "worker"; matchKind: "compound" | "runId-fallback" } | null {
		if (BrokerTokenRegistry.equalConstTime(this.map.get(this.orchestratorKey(runId)), candidate)) {
			return { role: "orchestrator", matchKind: "compound" };
		}
		// No taskId → the key degenerates to bare runId; there is no task
		// scoping at all, so an honest matchKind is "runId-fallback".
		if (taskId === undefined) {
			return BrokerTokenRegistry.equalConstTime(this.map.get(runId), candidate)
				? { role: "worker", matchKind: "runId-fallback" }
				: null;
		}
		const compound = this.map.get(this.key(runId, taskId));
		if (compound !== undefined) {
			return BrokerTokenRegistry.equalConstTime(compound, candidate) ? { role: "worker", matchKind: "compound" } : null;
		}
		// Backward-compat: per-run token issued without taskId.
		if (BrokerTokenRegistry.equalConstTime(this.map.get(runId), candidate)) {
			return { role: "worker", matchKind: "runId-fallback" };
		}
		return null;
	}

	/** Remove the token for `runId` (+optional `taskId`).
	 *  Deletes the computed key. When taskId is provided, also removes the
	 *  bare `runId` fallback entry for a clean teardown. */
	revoke(runId: string, taskId?: string): void {
		this.map.delete(this.key(runId, taskId));
		// Backward-compat: also remove any bare-runId fallback entry.
		if (taskId) this.map.delete(runId);
		// Full-run revoke: also drop the orchestrator token.
		if (!taskId) this.map.delete(this.orchestratorKey(runId));
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
