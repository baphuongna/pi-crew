import assert from "node:assert/strict";
import test from "node:test";
import {
	__test_resetProviderQuota,
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

test("low remaining with future reset marks provider as deprioritized", () => {
	__test_resetProviderQuota();
	const futureReset = Math.floor((Date.now() + 60_000) / 1000);
	noteProviderResponse("openai", 200, {
		"x-ratelimit-remaining-requests": "3",
		"x-ratelimit-reset-requests": String(futureReset),
	});
	assert.equal(isProviderDeprioritized("openai"), true);
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
