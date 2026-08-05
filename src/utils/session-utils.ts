/**
 * Session ID utilities for pi-crew / pi session alignment.
 *
 * pi's session IDs use the format:
 * ^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$
 *
 * This module provides utilities to generate valid pi session IDs
 * that align with pi-crew run IDs for easy cross-referencing.
 */

/**
 * Validate session ID format per pi's requirements.
 * Format: ^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$
 */
export function assertValidSessionId(id: string): void {
	if (!id || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(`Invalid session id: must be non-empty, alphanumeric with '-', '_', '.' and start/end with alphanumeric`);
	}
}

/**
 * Convert a pi-crew run ID to a valid pi session ID.
 *
 * - Strips non-alphanumeric characters
 * - Lowercases
 * - Prefixes with "crew-"
 * - Truncates to 16 chars for safety
 *
 * @param runId - The pi-crew run ID (e.g., "team_20260528133725_02e05cc5480d0175")
 * @returns Valid pi session ID (e.g., "crew-team20260528133")
 */
export function toPiSessionId(runId: string): string {
	// Strip non-alphanumeric, lowercase, prefix with "crew-"
	const sanitized = runId.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
	return `crew-${sanitized.slice(0, 16)}`;
}

/**
 * Validate and convert a run ID to a pi session ID.
 * Returns the session ID if valid, or undefined if conversion would produce invalid ID.
 */
export function safeToPiSessionId(runId: string): string | undefined {
	try {
		const sessionId = toPiSessionId(runId);
		assertValidSessionId(sessionId);
		return sessionId;
	} catch {
		return undefined;
	}
}

/**
 * Module-level cache for resolved session ids, keyed by the stable
 * `sessionManager` reference (NOT by `ctx` — `ctx` is recreated per event by
 * `createContext()` on the runner, so keying on `ctx` would never hit the
 * cache). The `sessionManager` object persists across events within a session.
 */
const sessionIdCache = new WeakMap<object, string>();

/**
 * Extract the current Pi session id from an ExtensionContext.
 *
 * On Pi 0.83.0 the `ExtensionContext` has NO top-level `sessionId` property —
 * the id is reachable only via `ctx.sessionManager.getSessionId()`. This is
 * the canonical accessor: every site that filters the SHARED per-project
 * `.crew/state/` tree down to the current session MUST use this, otherwise
 * cross-session state leaks (e.g. compaction-guard resuming another session's
 * runs, ambient-status injecting another session's runs).
 *
 * Strategy (primary → fallback):
 *   1. `ctx.sessionManager?.getSessionId?.()` — the working accessor on
 *      Pi 0.83.0. The result is cached by `sessionManager` ref so the method
 *      lookup runs at most once per session-manager instance, keeping the hot
 *      path (called on every `context` event) cheap.
 *   2. `Object.getOwnPropertyDescriptor(ctx, "sessionId")` — for test mocks
 *      and older Pi versions that attach `sessionId` as an own property.
 *
 * Returns undefined when the session id is absent or unparseable — callers
 * must decide whether to treat that as "no filter" (back-compat) or "no runs".
 */
export function extractSessionId(ctx: unknown): string | undefined {
	if (typeof ctx !== "object" || ctx === null) return undefined;
	try {
		const sm = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager;
		if (sm && typeof sm === "object") {
			const cached = sessionIdCache.get(sm as object);
			if (cached) return cached;
			const id = (sm as { getSessionId?: () => unknown }).getSessionId?.();
			if (typeof id === "string" && id.length > 0) {
				sessionIdCache.set(sm as object, id);
				return id;
			}
		}
		const direct = Object.getOwnPropertyDescriptor(ctx, "sessionId")?.value;
		if (typeof direct === "string" && direct.length > 0) return direct;
	} catch {
		// Defensive: a hostile Proxy or exotic object may trap property or
		// descriptor access. Real Pi ExtensionContext objects are plain, so
		// this is only hit by adversarial/degenerate inputs — treat as no id.
		return undefined;
	}
	return undefined;
}

/**
 * Broker-only session id extractor.
 *
 * Pi's `ExtensionContext` does NOT expose a top-level `sessionId` property on
 * its public surface — the id is reachable via `ctx.sessionManager.getSessionId()`.
 * This helper is only called from `installCrewBrokerLifecycleController.setSessionId`
 * (once per session_start), so the extra method invocation is safe here. It is
 * INTENTIONALLY a separate function from `extractSessionId`: both now read
 * `sessionManager.getSessionId()` first, but `extractSessionId` memoises the
 * result in a WeakMap keyed by the `sessionManager` ref (it is called on every
 * `context` event from `context-status-injection.ts`), whereas this broker
 * helper is called only once per `session_start`, so caching is unnecessary.
 *
 * Tries the sessionManager path first, then falls back to a direct
 * `ctx.sessionId` for test mock compatibility.
 */
export function extractBrokerSessionId(ctx: unknown): string | undefined {
	if (typeof ctx !== "object" || ctx === null) return undefined;
	try {
		const sm = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager;
		const viaManager = sm?.getSessionId?.();
		if (typeof viaManager === "string" && viaManager.length > 0) return viaManager;
		const direct = Object.getOwnPropertyDescriptor(ctx, "sessionId")?.value;
		if (typeof direct === "string" && direct.length > 0) return direct;
		return undefined;
	} catch {
		return undefined;
	}
}
