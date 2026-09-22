import assert from "node:assert/strict";
import test from "node:test";
import { __test__registryModelCacheHas, availableModelInfosFromRegistry } from "../../../../src/runtime/model/model-fallback.ts";

/**
 * US-012 (2026-09-22): cache the registry-derived model list. It is rebuilt on
 * every model resolution / worker spawn (a 4-worker team = 4 rebuilds) even
 * though the registry is config-derived and invariant per session.
 *
 * The cache is a WeakMap keyed on the registry object, validated by the
 * getAvailable() array identity — so a rebuilt list (new array) is re-normalized
 * and a new registry instance (config reload) starts fresh.
 *
 * Mutation: drop the cache hit (`if (cached && ...)`) → the second-call test
 * sees a rebuild (cache miss counter) and the identity-return assertion fails.
 */

function makeRegistry(models: Array<{ provider: string; id: string }>, rebuildEachCall = false): { getAvailable: () => unknown[] } {
	let list = models;
	return {
		getAvailable: () => {
			if (rebuildEachCall) list = [...models];
			return list;
		},
	};
}

test("US-012: the same registry array is normalized once (cache hit returns the SAME array)", () => {
	const registry = makeRegistry([{ provider: "anthropic", id: "claude-sonnet-4.5" }]);
	const first = availableModelInfosFromRegistry(registry);
	const second = availableModelInfosFromRegistry(registry);
	assert.ok(first && second);
	assert.equal(first, second, "a cache hit must return the identical normalized array (no rebuild)");
	assert.equal(__test__registryModelCacheHas(registry), true, "the registry must be cached after the first call");
});

test("US-012: a REBUILT list (new array identity) is re-normalized, not served stale", () => {
	const registry = makeRegistry([{ provider: "anthropic", id: "claude-sonnet-4.5" }], /* rebuildEachCall */ true);
	const first = availableModelInfosFromRegistry(registry);
	const second = availableModelInfosFromRegistry(registry);
	assert.ok(first && second);
	assert.notEqual(first, second, "a new array instance must not be served from cache");
	assert.deepEqual(second, first, "the re-normalized content is identical for identical input");
});

test("US-012: a different registry instance gets its own cache entry", () => {
	const a = makeRegistry([{ provider: "anthropic", id: "claude-sonnet-4.5" }]);
	const b = makeRegistry([{ provider: "openai", id: "gpt-5" }]);
	const ai = availableModelInfosFromRegistry(a);
	const bi = availableModelInfosFromRegistry(b);
	assert.equal(ai?.[0]?.fullId, "anthropic/claude-sonnet-4.5");
	assert.equal(bi?.[0]?.fullId, "openai/gpt-5");
	assert.equal(__test__registryModelCacheHas(a), true);
	assert.equal(__test__registryModelCacheHas(b), true);
});

test("US-012: invalid registries still return undefined (cache does not mask them)", () => {
	assert.equal(availableModelInfosFromRegistry(undefined), undefined);
	assert.equal(availableModelInfosFromRegistry(null), undefined);
	assert.equal(availableModelInfosFromRegistry([]), undefined);
	assert.equal(availableModelInfosFromRegistry({}), undefined, "no getAvailable/getAll → undefined");
});
