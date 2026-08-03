import assert from "node:assert/strict";
import test from "node:test";
import {
	acquirePooledChild,
	DEFAULT_WARM_POOL_OPTIONS,
	disposeWarmPool,
	releasePooledChild,
	resolveWarmPoolSize,
} from "../../../../src/runtime/child-pi/child-pi-pool.ts";

test("DEFAULT_WARM_POOL_OPTIONS keeps the pool off (2.6)", () => {
	assert.equal(DEFAULT_WARM_POOL_OPTIONS.size, 0);
	assert.ok(DEFAULT_WARM_POOL_OPTIONS.maxIdleMs > 0);
});

test("resolveWarmPoolSize prefers env, then configured, then default (2.6)", () => {
	assert.equal(resolveWarmPoolSize({ PI_CREW_WARM_POOL_SIZE: "3" } as NodeJS.ProcessEnv, 1), 3);
	assert.equal(resolveWarmPoolSize({} as NodeJS.ProcessEnv, 2), 2);
	assert.equal(resolveWarmPoolSize({} as NodeJS.ProcessEnv), 0);
	assert.equal(resolveWarmPoolSize({ PI_CREW_WARM_POOL_SIZE: "abc" } as NodeJS.ProcessEnv, 5), 5);
});

test("acquirePooledChild returns null while skeleton is disabled (2.6)", () => {
	assert.equal(acquirePooledChild(), null);
	assert.equal(acquirePooledChild({ size: 4 }), null);
});

test("releasePooledChild and disposeWarmPool are safe no-ops (2.6)", () => {
	assert.doesNotThrow(() => releasePooledChild(null));
	assert.doesNotThrow(() => releasePooledChild(undefined));
	assert.doesNotThrow(() => disposeWarmPool());
});
