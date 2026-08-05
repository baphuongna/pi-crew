import assert from "node:assert/strict";
import test from "node:test";
import {
	__test_quotaCacheHasProvider,
	__test_resetProviderQuota,
	clearProviderQuotaCache,
	deprioritizedProviders,
	isProviderDeprioritized,
	noteProviderResponse,
	providerRankFromQuota,
} from "../../../../src/runtime/model/provider-quota.ts";

test("noteProviderResponse records rate-limit headers", () => {
	__test_resetProviderQuota();
	noteProviderResponse("anthropic", 200, {
		"x-ratelimit-remaining-requests": "42",
		"x-ratelimit-remaining-tokens": "100000",
	});
	assert.equal(isProviderDeprioritized("anthropic"), false);
});

test("429 status marks provider as deprioritized", () => {
	__test_resetProviderQuota();
	noteProviderResponse("openai", 429, { "retry-after": "30" });
	assert.equal(isProviderDeprioritized("openai"), true);
});

test("zero remaining requests marks provider as deprioritized", () => {
	__test_resetProviderQuota();
	noteProviderResponse("gemini", 200, { "x-ratelimit-remaining-requests": "0" });
	assert.equal(isProviderDeprioritized("gemini"), true);
});

test("zero remaining tokens marks provider as deprioritized", () => {
	__test_resetProviderQuota();
	noteProviderResponse("gemini", 200, { "x-ratelimit-remaining-tokens": "0" });
	assert.equal(isProviderDeprioritized("gemini"), true);
});

test("Go-duration header '6m0s' with low remaining marks provider as deprioritized", () => {
	__test_resetProviderQuota();
	noteProviderResponse("openai", 200, {
		"x-ratelimit-remaining-requests": "3",
		"x-ratelimit-reset-requests": "6m0s",
	});
	assert.equal(isProviderDeprioritized("openai"), true);
});

test("Go-duration header '1s' with low remaining marks provider as deprioritized", () => {
	__test_resetProviderQuota();
	noteProviderResponse("openai", 200, {
		"x-ratelimit-remaining-requests": "2",
		"x-ratelimit-reset-requests": "1s",
	});
	assert.equal(isProviderDeprioritized("openai"), true);
});

test("Go-duration header '120s' with low remaining marks provider as deprioritized", () => {
	__test_resetProviderQuota();
	noteProviderResponse("openai", 200, {
		"x-ratelimit-remaining-requests": "1",
		"x-ratelimit-reset-requests": "120s",
	});
	assert.equal(isProviderDeprioritized("openai"), true);
});

test("RFC3339 future timestamp with low remaining marks provider as deprioritized", () => {
	__test_resetProviderQuota();
	const futureIso = new Date(Date.now() + 60_000).toISOString();
	noteProviderResponse("anthropic", 200, {
		"x-ratelimit-remaining-requests": "2",
		"x-ratelimit-reset-requests": futureIso,
	});
	assert.equal(isProviderDeprioritized("anthropic"), true);
});

test("RFC3339 past timestamp with low remaining does NOT mark provider as deprioritized", () => {
	__test_resetProviderQuota();
	const pastIso = new Date(Date.now() - 60_000).toISOString();
	noteProviderResponse("anthropic", 200, {
		"x-ratelimit-remaining-requests": "2",
		"x-ratelimit-reset-requests": pastIso,
	});
	assert.equal(isProviderDeprioritized("anthropic"), false);
});

test("clearProviderQuotaCache clears quota state on session switch", () => {
	__test_resetProviderQuota();
	noteProviderResponse("openai", 429, {});
	assert.equal(isProviderDeprioritized("openai"), true);
	clearProviderQuotaCache();
	assert.equal(isProviderDeprioritized("openai"), false);
});

test("stale entries older than 2*QUOTA_TTL_MS are evicted on next noteProviderResponse", () => {
	__test_resetProviderQuota();
	const now = Date.now();
	// Entry 11 minutes old — beyond eviction threshold (2 * 5min = 10min)
	noteProviderResponse("stale-provider", 200, { "x-ratelimit-remaining-requests": "42" }, now - 11 * 60 * 1000);
	// Fresh entry — triggers eviction of the stale one
	noteProviderResponse("fresh-provider", 200, { "x-ratelimit-remaining-requests": "42" }, now);
	// The stale entry should have been evicted from the cache
	assert.equal(__test_quotaCacheHasProvider("stale-provider"), false);
	// The fresh entry should still be present
	assert.equal(__test_quotaCacheHasProvider("fresh-provider"), true);
});

test("stale entries are not deprioritized", () => {
	__test_resetProviderQuota();
	const oldTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
	noteProviderResponse("openai", 429, {}, oldTime);
	assert.equal(isProviderDeprioritized("openai"), false);
});

test("deprioritizedProviders filters correctly", () => {
	__test_resetProviderQuota();
	noteProviderResponse("anthropic", 200, { "x-ratelimit-remaining-requests": "100" });
	noteProviderResponse("openai", 429, {});
	noteProviderResponse("gemini", 200, { "x-ratelimit-remaining-requests": "50" });
	assert.deepEqual(deprioritizedProviders(["anthropic", "openai", "gemini"]), ["openai"]);
});

test("providerRankFromQuota ranks by remaining capacity", () => {
	__test_resetProviderQuota();
	noteProviderResponse("anthropic", 200, { "x-ratelimit-remaining-requests": "100" });
	noteProviderResponse("openai", 200, { "x-ratelimit-remaining-requests": "10" });
	const rank = providerRankFromQuota(["anthropic", "openai", "gemini"]);
	assert.ok(rank.anthropic < rank.openai, "more remaining = lower rank");
	assert.equal(rank.gemini, Number.MAX_SAFE_INTEGER, "unknown = last");
});

test("providerRankFromQuota deprioritizes exhausted providers", () => {
	__test_resetProviderQuota();
	noteProviderResponse("openai", 429, {});
	noteProviderResponse("anthropic", 200, { "x-ratelimit-remaining-requests": "50" });
	const rank = providerRankFromQuota(["openai", "anthropic"]);
	assert.ok(rank.openai > rank.anthropic, "exhausted provider ranks higher (worse)");
});

test("provider names are case-insensitive", () => {
	__test_resetProviderQuota();
	noteProviderResponse("OpenAI", 429, {});
	assert.equal(isProviderDeprioritized("openai"), true);
	assert.equal(isProviderDeprioritized("OPENAI"), true);
});

test("Go-duration multi-segment '1h30m' with low remaining marks provider as deprioritized", () => {
	__test_resetProviderQuota();
	noteProviderResponse("openai", 200, {
		"x-ratelimit-remaining-requests": "1",
		"x-ratelimit-reset-requests": "1h30m",
	});
	assert.equal(isProviderDeprioritized("openai"), true);
});

test("malformed reset header does not crash and does not spuriously deprioritize", () => {
	__test_resetProviderQuota();
	noteProviderResponse("openai", 200, {
		"x-ratelimit-remaining-requests": "100",
		"x-ratelimit-reset-requests": "not-a-duration",
	});
	// High remaining + unparseable reset → not deprioritized, no throw.
	assert.equal(isProviderDeprioritized("openai"), false);
});
