import test from "node:test";
import assert from "node:assert/strict";
import { calculateRetryDelay, executeWithRetry } from "../../src/runtime/retry-executor.ts";

test("executeWithRetry succeeds on first try", async () => {
	let attempts = 0;
	const result = await executeWithRetry(async () => { attempts += 1; return "ok"; }, { maxAttempts: 3, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1 });
	assert.equal(result, "ok");
	assert.equal(attempts, 1);
});

test("executeWithRetry retries then succeeds", async () => {
	let attempts = 0;
	const failures: number[] = [];
	const result = await executeWithRetry(async () => {
		attempts += 1;
		if (attempts < 3) throw new Error("temporary");
		return "ok";
	}, { maxAttempts: 3, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1 }, { onAttemptFailed: (attempt) => failures.push(attempt) });
	assert.equal(result, "ok");
	assert.deepEqual(failures, [1, 2]);
});

test("executeWithRetry gives up after max attempts and respects retryable patterns", async () => {
	let givenUp = 0;
	await assert.rejects(() => executeWithRetry(async () => { throw new Error("fatal"); }, { maxAttempts: 3, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1, retryableErrors: ["temporary*"] }, { onRetryGivenUp: (attempts) => { givenUp = attempts; } }), /fatal/);
	assert.equal(givenUp, 1);
});

test("calculateRetryDelay applies exponential backoff and jitter bounds", () => {
	assert.equal(calculateRetryDelay(3, { maxAttempts: 3, backoffMs: 100, jitterRatio: 0, exponentialFactor: 2 }), 400);
	const jittered = calculateRetryDelay(1, { maxAttempts: 3, backoffMs: 100, jitterRatio: 0.5, exponentialFactor: 2 }, () => 1);
	assert.equal(jittered, 150);
});
