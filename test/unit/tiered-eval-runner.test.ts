import assert from "node:assert/strict";
import test from "node:test";
import { createRunner, defaultRunner, TIER_CONFIGS, TieredEvalRunner } from "../../src/state/tiered-eval.ts";

/**
 * Round 24 (test coverage gaps): `tiered-eval.ts` provides a public API class
 * `TieredEvalRunner` for hierarchical evaluation checks. This test file covers
 * constructor, config, timeouts, tier sorting, fail-fast, and error handling.
 */

// ─── Constructor & Config ──────────────────────────────────────────────────

test("TieredEvalRunner: default constructor has correct tier configs", () => {
	const runner = new TieredEvalRunner();
	assert.equal(runner.getTimeout(1), 1000);
	assert.equal(runner.getTimeout(2), 5000);
	assert.equal(runner.getTimeout(3), 60000);
});

test("TieredEvalRunner: getTierConfig returns correct config", () => {
	const runner = new TieredEvalRunner();
	const t1 = runner.getTierConfig(1);
	assert.equal(t1.tier, 1);
	assert.equal(t1.name, "deterministic");
	assert.equal(t1.timeoutMs, 1000);
});

test("TieredEvalRunner: timeoutMultiplier scales timeouts", () => {
	const runner = new TieredEvalRunner({ timeoutMultiplier: 2.0 });
	assert.equal(runner.getTimeout(1), 2000);
	assert.equal(runner.getTimeout(2), 10000);
	assert.equal(runner.getTimeout(3), 120000);
});

test("TieredEvalRunner: custom tier config overrides", () => {
	const runner = new TieredEvalRunner({
		tierConfigs: {
			3: {
				tier: 3,
				name: "custom",
				description: "custom tier",
				timeoutMs: 120000,
			},
		},
	});
	assert.equal(runner.getTimeout(3), 120000);
	// Other tiers unchanged
	assert.equal(runner.getTimeout(1), 1000);
});

test("TieredEvalRunner: withConfig creates new runner with overrides", () => {
	const base = new TieredEvalRunner({ timeoutMultiplier: 1.5 });
	const derived = base.withConfig({
		1: {
			tier: 1,
			name: "fast",
			description: "fast checks",
			timeoutMs: 500,
		},
	});
	assert.equal(derived.getTimeout(1), 500 * 1.5);
	// Other tiers still use base multiplier
	assert.equal(derived.getTimeout(2), 5000 * 1.5);
});

test("createRunner: factory creates a new TieredEvalRunner", () => {
	const runner = createRunner({ timeoutMultiplier: 3.0 });
	assert.ok(runner instanceof TieredEvalRunner);
	assert.equal(runner.getTimeout(1), 3000);
});

test("defaultRunner: singleton exists and is a TieredEvalRunner", () => {
	assert.ok(defaultRunner instanceof TieredEvalRunner);
	assert.equal(defaultRunner.getTimeout(1), TIER_CONFIGS[1].timeoutMs);
});

// ─── runTieredEval ─────────────────────────────────────────────────────────

test("runTieredEval: all passing checks returns all passed", async () => {
	const runner = new TieredEvalRunner();
	const results = await runner.runTieredEval("task-1", [
		{ tier: 1, check: () => true },
		{ tier: 2, check: () => true },
	]);
	assert.equal(results.length, 2);
	assert.ok(results.every((r) => r.passed));
});

test("runTieredEval: sorts by tier by default (lower first)", async () => {
	const order: number[] = [];
	const runner = new TieredEvalRunner();
	await runner.runTieredEval("task-2", [
		{
			tier: 3,
			check: () => {
				order.push(3);
				return true;
			},
		},
		{
			tier: 1,
			check: () => {
				order.push(1);
				return true;
			},
		},
		{
			tier: 2,
			check: () => {
				order.push(2);
				return true;
			},
		},
	]);
	assert.deepEqual(order, [1, 2, 3]);
});

test("runTieredEval: does NOT sort when sortByTier is false", async () => {
	const order: number[] = [];
	const runner = new TieredEvalRunner({ sortByTier: false });
	await runner.runTieredEval("task-3", [
		{
			tier: 3,
			check: () => {
				order.push(3);
				return true;
			},
		},
		{
			tier: 1,
			check: () => {
				order.push(1);
				return true;
			},
		},
		{
			tier: 2,
			check: () => {
				order.push(2);
				return true;
			},
		},
	]);
	assert.deepEqual(order, [3, 1, 2]);
});

test("runTieredEval: continues through failures", async () => {
	const runner = new TieredEvalRunner();
	const results = await runner.runTieredEval("task-4", [
		{ tier: 1, check: () => false },
		{ tier: 1, check: () => true },
	]);
	assert.equal(results.length, 2);
	assert.equal(results[0]?.passed, false);
	assert.equal(results[1]?.passed, true);
});

test("runTieredEval: handles async checks", async () => {
	const runner = new TieredEvalRunner();
	const results = await runner.runTieredEval("task-5", [
		{
			tier: 1,
			check: async () => {
				await new Promise((r) => setTimeout(r, 10));
				return true;
			},
		},
	]);
	assert.equal(results.length, 1);
	assert.equal(results[0]?.passed, true);
});

test("runTieredEval: synchronous throw propagates (known behavior)", async () => {
	// NOTE: runCheckWithTimeout uses Promise.resolve(check()) which does NOT
	// catch synchronous throws — they propagate to the caller. This is a
	// known limitation. If this is fixed in the future, update this test.
	const runner = new TieredEvalRunner();
	await assert.rejects(
		() =>
			runner.runTieredEval("task-6", [
				{
					tier: 1,
					check: () => {
						throw new Error("boom");
					},
				},
			]),
		/boom/,
	);
});

test("runTieredEval: check timing out returns failure", async () => {
	// Use a very short timeout so the check times out
	const runner = new TieredEvalRunner({
		tierConfigs: {
			1: { tier: 1, name: "fast", description: "fast", timeoutMs: 10 },
		},
	});
	const results = await runner.runTieredEval("task-7", [
		{
			tier: 1,
			check: async () => {
				await new Promise((r) => setTimeout(r, 5000));
				return true;
			},
		},
	]);
	assert.equal(results.length, 1);
	assert.equal(results[0]?.passed, false);
	assert.match((results[0] as { error?: string }).error ?? "", /timed out/i);
});

// ─── runTieredEvalFailFast ─────────────────────────────────────────────────

test("runTieredEvalFailFast: stops at first failure", async () => {
	const order: number[] = [];
	const runner = new TieredEvalRunner();
	const results = await runner.runTieredEvalFailFast("task-8", [
		{
			tier: 1,
			check: () => {
				order.push(1);
				return true;
			},
		},
		{
			tier: 1,
			check: () => {
				order.push(2);
				return false;
			},
		},
		{
			tier: 1,
			check: () => {
				order.push(3);
				return true;
			},
		},
	]);
	assert.equal(results.length, 2, "should stop after first failure");
	assert.equal(order.length, 2, "should not execute third check");
	assert.equal(results[1]?.passed, false);
});

test("runTieredEvalFailFast: runs all if all pass", async () => {
	const runner = new TieredEvalRunner();
	const results = await runner.runTieredEvalFailFast("task-9", [
		{ tier: 1, check: () => true },
		{ tier: 2, check: () => true },
		{ tier: 3, check: () => true },
	]);
	assert.equal(results.length, 3);
	assert.ok(results.every((r) => r.passed));
});

// ─── runEval (structured result) ───────────────────────────────────────────

test("runEval: returns structured result with passed=true when all pass", async () => {
	const runner = new TieredEvalRunner();
	const result = await runner.runEval("task-10", [
		{ tier: 1, check: () => true },
		{ tier: 1, check: () => true },
	]);
	assert.equal(result.passed, true);
	assert.equal(result.results.length, 2);
	assert.ok(result.totalDurationMs >= 0);
	assert.equal(result.failedAtTier, undefined);
	assert.equal(result.failedAtIndex, undefined);
});

test("runEval: failFast=true returns structured failure info", async () => {
	const runner = new TieredEvalRunner();
	const result = await runner.runEval(
		"task-11",
		[
			{ tier: 1, check: () => true },
			{ tier: 2, check: () => false },
			{ tier: 2, check: () => true },
		],
		true,
	);
	assert.equal(result.passed, false);
	assert.equal(result.failedAtTier, 2);
	assert.ok(result.failedAtIndex !== undefined);
	// Should have stopped after the failure
	assert.ok(result.results.length < 3, "failFast should stop early");
});
