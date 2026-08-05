/**
 * provider-quota.ts — track provider rate-limit / quota state from response
 * headers so the model fallback chain can deprioritize providers that are
 * near exhaustion.
 *
 * WHY: when a provider returns 429 or its `x-ratelimit-remaining` header
 * drops to zero, every subsequent spawn to that provider wastes a child
 * process + a full retry cycle before the fallback chain moves on. Recording
 * the signal here lets `buildConfiguredModelRouting` push those providers to
 * the back of the auto tail instead of trying them first.
 *
 * Data source: pi's `after_provider_response` event carries `status` and
 * `headers`. Standard rate-limit headers (OpenAI, Anthropic, most proxies):
 *   x-ratelimit-remaining-requests / x-ratelimit-remaining-tokens
 *   x-ratelimit-reset-requests    / x-ratelimit-reset-tokens
 *   retry-after (on 429)
 *
 * The tracker is process-local and best-effort: a missed event just means
 * the cache is slightly stale, never a wrong routing decision.
 */

interface ProviderQuotaEntry {
	/** Provider key (lowercase). */
	provider: string;
	/** Remaining requests from the most recent response header. */
	remainingRequests?: number;
	/** Remaining tokens from the most recent response header. */
	remainingTokens?: number;
	/** When the rate-limit window resets (epoch ms). */
	resetAtMs?: number;
	/** HTTP status of the last response (429 = rate-limited). */
	lastStatus?: number;
	/** When this entry was last updated (epoch ms). */
	updatedAtMs: number;
}

/** How long a quota entry stays authoritative before we stop trusting it. */
const QUOTA_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Process-local cache keyed by lowercase provider name. */
const quotaCache = new Map<string, ProviderQuotaEntry>();

/**
 * Parse a numeric header value, returning undefined for missing/invalid.
 */
function headerNumber(headers: Record<string, string>, ...names: string[]): number | undefined {
	for (const name of names) {
		const raw = headers[name] ?? headers[name.toLowerCase()];
		if (raw === undefined) continue;
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}

/**
 * Read a raw (unparsed) header value — first match wins, case-insensitive.
 */
function headerRaw(headers: Record<string, string>, ...names: string[]): string | undefined {
	for (const name of names) {
		const raw = headers[name] ?? headers[name.toLowerCase()];
		if (raw !== undefined) return raw;
	}
	return undefined;
}

/** Regex: compact Go-duration like "6m0s", "1s", "1h30m", "120s". */
const GO_DURATION_RE = /^(\d+[smh])+$/;
/** Regex: extract individual (\d+)(unit) segments from a Go-duration string. */
const GO_DURATION_SEG_RE = /(\d+)([smh])/g;

/**
 * Parse a reset-timestamp header value into epoch-ms.
 *
 * Three formats are supported (tried in order):
 *   (c) RFC3339 absolute timestamp (Anthropic): Date.parse returns epoch-ms directly.
 *   (a) Go-duration compact string (OpenAI): "6m0s", "1s", "1h30m", "120s".
 *   (b) Pure-seconds integer (retry-after): "30" → nowMs + 30 000.
 *
 * Returns undefined if no format matches.
 */
function parseResetValue(value: string, nowMs: number): number | undefined {
	const trimmed = value.trim();
	// (b) Pure-seconds integer (retry-after / reset): "0", "30", "120".
	// MUST precede RFC3339 — Date.parse("0") returns 946659600000 (Y2K) in V8,
	// not NaN, so a numeric "0" would otherwise hijack the timestamp branch
	// and yield a resetAtMs in the year 2000.
	if (/^\d+$/.test(trimmed)) {
		const secs = Number.parseInt(trimmed, 10);
		if (Number.isFinite(secs) && secs >= 0) return nowMs + secs * 1000;
	}
	// (a) Go-duration compact: digits+unit pairs ("6m0s", "1s", "1h30m").
	if (GO_DURATION_RE.test(trimmed)) {
		let durationMs = 0;
		for (const seg of trimmed.matchAll(GO_DURATION_SEG_RE)) {
			const n = Number.parseInt(seg[1], 10);
			const unit = seg[2];
			durationMs += unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
		}
		return nowMs + durationMs;
	}
	// (c) RFC3339 absolute timestamp (Anthropic). Only non-numeric date-like
	// strings reach here: pure-numeric is handled above, and Date.parse on
	// Go-durations like "6m0s" returns NaN.
	const parsed = Date.parse(trimmed);
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return undefined;
}

/**
 * Parse a reset timestamp from headers. Providers use different formats:
 *   - OpenAI: Go-duration strings ("6m0s", "1s") in x-ratelimit-reset-requests.
 *   - Anthropic: RFC3339 timestamps.
 *   - retry-after: pure-seconds integer.
 */
function headerResetMs(headers: Record<string, string>, nowMs: number): number | undefined {
	const resetRaw = headerRaw(headers, "x-ratelimit-reset-requests", "x-ratelimit-reset");
	if (resetRaw !== undefined) {
		const parsed = parseResetValue(resetRaw, nowMs);
		if (parsed !== undefined) return parsed;
	}
	const retryRaw = headerRaw(headers, "retry-after");
	if (retryRaw !== undefined) {
		return parseResetValue(retryRaw, nowMs);
	}
	return undefined;
}

/**
 * Record a provider response. Called from the `after_provider_response`
 * event handler. The `provider` argument is the pi provider key (e.g.
 * "anthropic", "openai-codex"); it is lowercased for consistent lookup.
 */
export function noteProviderResponse(provider: string, status: number, headers: Record<string, string>, nowMs: number = Date.now()): void {
	const key = provider.toLowerCase();
	const entry: ProviderQuotaEntry = {
		provider: key,
		remainingRequests: headerNumber(headers, "x-ratelimit-remaining-requests", "x-ratelimit-remaining"),
		remainingTokens: headerNumber(headers, "x-ratelimit-remaining-tokens"),
		resetAtMs: headerResetMs(headers, nowMs),
		lastStatus: status,
		updatedAtMs: nowMs,
	};
	quotaCache.set(key, entry);
	// L1: evict entries older than 2 * QUOTA_TTL_MS (10 min) to bound cache growth.
	const evictionCutoff = nowMs - 2 * QUOTA_TTL_MS;
	for (const [cacheKey, cached] of quotaCache) {
		if (cached.updatedAtMs < evictionCutoff) quotaCache.delete(cacheKey);
	}
}

/**
 * Whether a provider is currently deprioritized (near or at quota limit).
 * A provider is deprioritized when:
 *   - its last response was 429, OR
 *   - remaining requests/tokens dropped to 0, OR
 *   - the reset window hasn't passed yet and remaining is very low (<10% of
 *     a typical window, heuristic: remaining < 5)
 */
export function isProviderDeprioritized(provider: string, nowMs: number = Date.now()): boolean {
	const entry = quotaCache.get(provider.toLowerCase());
	if (!entry) return false;
	// Stale entries are ignored — the provider may have recovered.
	if (nowMs - entry.updatedAtMs > QUOTA_TTL_MS) return false;
	// 429 = actively rate-limited right now.
	if (entry.lastStatus === 429) return true;
	// Explicit zero remaining.
	if (entry.remainingRequests === 0 || entry.remainingTokens === 0) return true;
	// Very low remaining with a future reset = approaching the wall.
	if (entry.resetAtMs !== undefined && entry.resetAtMs > nowMs) {
		if (entry.remainingRequests !== undefined && entry.remainingRequests < 5) return true;
		if (entry.remainingTokens !== undefined && entry.remainingTokens < 1000) return true;
	}
	return false;
}

/**
 * Build the `deprioritizedProviders` list for a set of candidate providers.
 * Only providers with a fresh, deprioritized entry are included.
 */
export function deprioritizedProviders(providers: string[], nowMs: number = Date.now()): string[] {
	return providers.filter((p) => isProviderDeprioritized(p, nowMs));
}

/**
 * Build a `providerRank` map from quota data. Providers with more remaining
 * capacity get a lower rank (tried earlier). Providers with no data get
 * `Number.MAX_SAFE_INTEGER` (unknown = last). Providers that are
 * deprioritized get `Number.MAX_SAFE_INTEGER - 1` (just above unknown).
 */
export function providerRankFromQuota(providers: string[], nowMs: number = Date.now()): Record<string, number> {
	const rank: Record<string, number> = {};
	for (const provider of providers) {
		const key = provider.toLowerCase();
		const entry = quotaCache.get(key);
		if (!entry || nowMs - entry.updatedAtMs > QUOTA_TTL_MS) {
			rank[key] = Number.MAX_SAFE_INTEGER;
			continue;
		}
		if (isProviderDeprioritized(key, nowMs)) {
			rank[key] = Number.MAX_SAFE_INTEGER - 1;
			continue;
		}
		// Rank by remaining capacity: more remaining = lower rank = tried first.
		// Use requests as primary signal; fall back to tokens.
		const remaining = entry.remainingRequests ?? entry.remainingTokens;
		rank[key] = remaining !== undefined ? Math.max(0, 1000 - remaining) : Number.MAX_SAFE_INTEGER;
	}
	return rank;
}

/**
 * Clear the provider quota cache. Called on session switch to prevent
 * stale quota data from a previous session leaking into the next.
 */
export function clearProviderQuotaCache(): void {
	quotaCache.clear();
}

/** @internal Test seam — check if a provider has a cached entry. */
export function __test_quotaCacheHasProvider(provider: string): boolean {
	return quotaCache.has(provider.toLowerCase());
}

/** @internal Test seam — clear the quota cache. */
export function __test_resetProviderQuota(): void {
	clearProviderQuotaCache();
}
