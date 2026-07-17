import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RetryPolicy } from "../../src/runtime/retry-executor.ts";
import { calculateRetryDelay, executeWithRetry } from "../../src/runtime/retry-executor.ts";

// ── calculateRetryDelay ──

describe("calculateRetryDelay", () => {
	it("returns base delay for first attempt", () => {
		const policy: RetryPolicy = {
			maxAttempts: 3,
			backoffMs: 1000,
			jitterRatio: 0,
			exponentialFactor: 2,
		};
		const delay = calculateRetryDelay(1, policy, () => 0.5);
		assert.strictEqual(delay, 1000);
	});

	it("applies exponential backoff", () => {
		const policy: RetryPolicy = {
			maxAttempts: 5,
			backoffMs: 1000,
			jitterRatio: 0,
			exponentialFactor: 2,
		};
		assert.strictEqual(
			calculateRetryDelay(1, policy, () => 0.5),
			1000,
		);
		assert.strictEqual(
			calculateRetryDelay(2, policy, () => 0.5),
			2000,
		);
		assert.strictEqual(
			calculateRetryDelay(3, policy, () => 0.5),
			4000,
		);
	});

	it("applies jitter within expected range", () => {
		const policy: RetryPolicy = {
			maxAttempts: 3,
			backoffMs: 1000,
			jitterRatio: 0.5,
			exponentialFactor: 1,
		};
		// With jitterRatio=0.5, jitter = (random * 2 - 1) * 0.5 * 1000
		// random=0 → jitter=-500, random=1 → jitter=500
		const minDelay = calculateRetryDelay(1, policy, () => 0);
		const maxDelay = calculateRetryDelay(1, policy, () => 1);
		assert.ok(minDelay >= 0);
		assert.ok(maxDelay >= 0);
		assert.ok(minDelay <= maxDelay);
	});

	it("never returns negative delay", () => {
		const policy: RetryPolicy = {
			maxAttempts: 3,
			backoffMs: 100,
			jitterRatio: 1,
			exponentialFactor: 1,
		};
		for (let r = 0; r <= 1; r += 0.1) {
			const delay = calculateRetryDelay(1, policy, () => r);
			assert.ok(delay >= 0, `Delay should be >= 0 for random=${r}, got ${delay}`);
		}
	});

	it("uses DEFAULT_RETRY_POLICY when no policy provided", () => {
		const delay = calculateRetryDelay(1, undefined, () => 0.5);
		assert.ok(typeof delay === "number");
		assert.ok(delay >= 0);
	});
});

// ── executeWithRetry ──

describe("executeWithRetry", () => {
	it("returns result on first successful attempt", async () => {
		const result = await executeWithRetry(async () => "ok");
		assert.strictEqual(result, "ok");
	});

	it("retries on failure and succeeds", async () => {
		let attempt = 0;
		const result = await executeWithRetry(
			async () => {
				attempt++;
				if (attempt < 2) throw new Error("fail");
				return "recovered";
			},
			{
				maxAttempts: 3,
				backoffMs: 1,
				jitterRatio: 0,
				exponentialFactor: 1,
			},
		);
		assert.strictEqual(result, "recovered");
		assert.strictEqual(attempt, 2);
	});

	it("throws after all attempts exhausted", async () => {
		await assert.rejects(
			async () =>
				executeWithRetry(
					async () => {
						throw new Error("always fail");
					},
					{
						maxAttempts: 2,
						backoffMs: 1,
						jitterRatio: 0,
						exponentialFactor: 1,
					},
				),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.strictEqual(err.message, "always fail");
				return true;
			},
		);
	});

	it("calls onAttemptFailed hook on retry", async () => {
		const failedAttempts: number[] = [];
		let attempt = 0;
		await executeWithRetry(
			async () => {
				attempt++;
				if (attempt < 2) throw new Error("fail");
				return "ok";
			},
			{
				maxAttempts: 3,
				backoffMs: 1,
				jitterRatio: 0,
				exponentialFactor: 1,
			},
			{
				onAttemptFailed: (a) => {
					failedAttempts.push(a);
				},
			},
		);
		assert.deepStrictEqual(failedAttempts, [1]);
	});

	it("calls onRetryGivenUp when all attempts fail", async () => {
		const givenUp: { attempts: number; error: Error }[] = [];
		try {
			await executeWithRetry(
				async () => {
					throw new Error("nope");
				},
				{
					maxAttempts: 2,
					backoffMs: 1,
					jitterRatio: 0,
					exponentialFactor: 1,
				},
				{
					onRetryGivenUp: (a, e) => {
						givenUp.push({ attempts: a, error: e });
					},
				},
			);
		} catch {
			// expected
		}
		assert.strictEqual(givenUp.length, 1);
		assert.strictEqual(givenUp[0].attempts, 2);
		assert.strictEqual(givenUp[0].error.message, "nope");
	});

	it("filters errors by retryableErrors patterns", async () => {
		let attempts = 0;
		await assert.rejects(async () =>
			executeWithRetry(
				async () => {
					attempts++;
					throw new Error("timeout error");
				},
				{
					maxAttempts: 3,
					backoffMs: 1,
					jitterRatio: 0,
					exponentialFactor: 1,
					retryableErrors: ["rate*"],
				},
			),
		);
		// Should only attempt once because "timeout error" doesn't match "rate*"
		assert.strictEqual(attempts, 1);
	});

	it("retries when error matches retryableErrors pattern", async () => {
		let attempts = 0;
		try {
			await executeWithRetry(
				async () => {
					attempts++;
					throw new Error("rate limit exceeded");
				},
				{
					maxAttempts: 3,
					backoffMs: 1,
					jitterRatio: 0,
					exponentialFactor: 1,
					retryableErrors: ["rate*"],
				},
			);
		} catch {
			// expected
		}
		assert.strictEqual(attempts, 3);
	});

	it("respects AbortSignal", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(async () =>
			executeWithRetry(
				async () => "never",
				{
					maxAttempts: 3,
					backoffMs: 1,
					jitterRatio: 0,
					exponentialFactor: 1,
				},
				{ signal: controller.signal },
			),
		);
	});

	it("provides attempt info with custom attemptId", async () => {
		const infos: string[] = [];
		let attempt = 0;
		await executeWithRetry(
			async (_n, info) => {
				infos.push(info.attemptId);
				attempt++;
				if (attempt < 2) throw new Error("fail");
				return "ok";
			},
			{
				maxAttempts: 3,
				backoffMs: 1,
				jitterRatio: 0,
				exponentialFactor: 1,
			},
			{ attemptId: (n) => `custom-${n}` },
		);
		assert.ok(infos[0].startsWith("custom-"));
	});

	it("uses DEFAULT_RETRY_POLICY as base", async () => {
		// Just ensure it doesn't throw with no policy
		const result = await executeWithRetry(async () => 42);
		assert.strictEqual(result, 42);
	});

	it("normalizes maxAttempts to at least 1", async () => {
		// maxAttempts: 0 should be normalized to at least 1
		let called = false;
		try {
			await executeWithRetry(
				async () => {
					called = true;
					throw new Error("fail");
				},
				{
					maxAttempts: 0,
					backoffMs: 1,
					jitterRatio: 0,
					exponentialFactor: 1,
				} as any,
			);
		} catch {
			// expected
		}
		assert.strictEqual(called, true);
	});
});
