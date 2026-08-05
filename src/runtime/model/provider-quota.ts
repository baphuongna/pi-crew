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
 * Parse a reset timestamp from headers. Providers use either epoch-seconds
 * (x-ratelimit-reset-requests) or a duration in seconds (retry-after).
 */
function headerResetMs(headers: Record<string, string>, nowMs: number): number | undefined {
	// Epoch-seconds reset (OpenAI style)
	const epochSec = headerNumber(headers, "x-ratelimit-reset-requests", "x-ratelimit-reset");
	if (epochSec !== undefined) return epochSec * 1000;
	// Duration-in-seconds (retry-after on 429)
	const retryAfterSec = headerNumber(headers, "retry-after");
	if (retryAfterSec !== undefined) return nowMs + retryAfterSec * 1000;
	return undefined;
}

/**
 * Record a provider response. Called from the `after_provider_response`
 * event handler. The `provider` argument is the pi provider key (e.g.
 * "anthropic", "openai-codex"); it is lowercased for consistent lookup.
 */
export function noteProviderResponse(
	provider: string,
	status: number,
	headers: Record<string, string>,
	nowMs: number = Date.now(),
): void {
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

/** @internal Test seam — clear the quota cache. */
export function __test_resetProviderQuota(): void {
	quotaCache.clear();
}
