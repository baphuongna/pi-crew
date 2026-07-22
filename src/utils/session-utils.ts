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

const extractSessionIdCache = new WeakMap<object, string | undefined>();

/**
 * Extract the current Pi session id from an ExtensionContext.
 *
 * Pi's `ExtensionContext` exposes the session id via `sessionManager.getSessionId()`
 * (there is NO top-level `sessionId` property on the context). This accessor
 * reads it through the sessionManager and validates it as a non-empty string.
 * A fallback to a direct `ctx.sessionId` property is kept for tests and any
 * future Pi version that exposes it directly.
 *
 * This is the canonical accessor — every site that filters the SHARED
 * per-project `.crew/state/` tree down to the current session MUST use this,
 * otherwise cross-session state leaks (e.g. compaction-guard resuming another
 * session's runs, ambient-status injecting another session's runs, or the
 * inter-pi broker failing to bind because no session id was captured).
 *
 * Returns undefined when the session id is absent or unparseable — callers
 * must decide whether to treat that as "no filter" (back-compat) or "no runs".
 */
export function extractSessionId(ctx: unknown): string | undefined {
	if (typeof ctx !== "object" || ctx === null) return undefined;
	// Cache the result per-ctx. context-status-injection calls this on EVERY
	// `context` event (i.e. before every LLM call); sessionManager.getSessionId()
	// is a real method call that touches session state — caching prevents
	// per-turn UI hangs that surface as "team-dashboard/team-settings open but
	// unresponsive, pi-crew UI not rendering". WeakMap lets the ctx object be
	// GC'd; no manual invalidation is needed because Pi creates a fresh
	// ExtensionContext per session switch.
	const cached = extractSessionIdCache.get(ctx as object);
	if (cached !== undefined) return cached;
	let result: string | undefined;
	try {
		// Primary path: Pi's ExtensionContext exposes sessionManager.getSessionId().
		const sm = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager;
		const viaManager = sm?.getSessionId?.();
		if (typeof viaManager === "string" && viaManager.length > 0) result = viaManager;
		else {
			// Fallback: a direct sessionId property (tests / future Pi versions).
			const direct = Object.getOwnPropertyDescriptor(ctx, "sessionId")?.value;
			if (typeof direct === "string" && direct.length > 0) result = direct;
		}
	} catch {
		// Defensive: a hostile Proxy or exotic object may trap descriptor
		// access. Real Pi ExtensionContext objects are plain, so this is
		// only hit by adversarial/degenerate inputs — treat as no session id.
		result = undefined;
	}
	extractSessionIdCache.set(ctx as object, result);
	return result;
}
