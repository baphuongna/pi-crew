import assert from "node:assert/strict";
import test from "node:test";
import { CrewCancellationError } from "../../src/runtime/cancellation.ts";
import { calculateRetryDelay, executeWithRetry } from "../../src/runtime/recovery/retry-executor.ts";

test("executeWithRetry succeeds on first try", async () => {
	let attempts = 0;
	const result = await executeWithRetry(
		async () => {
			attempts += 1;
			return "ok";
		},
		{ maxAttempts: 3, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1 },
	);
	assert.equal(result, "ok");
	assert.equal(attempts, 1);
});

test("executeWithRetry retries then succeeds", async () => {
	let attempts = 0;
	const failures: Array<{ attempt: number; attemptId: string }> = [];
	const seenAttemptIds: string[] = [];
	const result = await executeWithRetry(
		async (_attempt, info) => {
			attempts += 1;
			seenAttemptIds.push(info.attemptId);
			if (attempts < 3) throw new Error("temporary");
			return "ok";
		},
		{ maxAttempts: 3, backoffMs: 1, jitterRatio: 0, exponentialFactor: 1 },
		{
			attemptId: (attempt) => `task:attempt-${attempt}`,
			onAttemptFailed: (attempt, _error, _delay, info) => failures.push({ attempt, attemptId: info.attemptId }),
		},
	);
	assert.equal(result, "ok");
	assert.deepEqual(failures, [
		{ attempt: 1, attemptId: "task:attempt-1" },
		{ attempt: 2, attemptId: "task:attempt-2" },
	]);
	assert.deepEqual(seenAttemptIds, ["task:attempt-1", "task:attempt-2", "task:attempt-3"]);
});

test("executeWithRetry gives up after max attempts and respects retryable patterns", async () => {
	let givenUp = 0;
	let givenUpAttemptId = "";
	await assert.rejects(
		() =>
			executeWithRetry(
				async () => {
					throw new Error("fatal");
				},
				{
					maxAttempts: 3,
					backoffMs: 1,
					jitterRatio: 0,
					exponentialFactor: 1,
					retryableErrors: ["temporary*"],
				},
				{
					onRetryGivenUp: (attempts, _error, info) => {
						givenUp = attempts;
						givenUpAttemptId = info.attemptId;
					},
				},
			),
		/fatal/,
	);
	assert.equal(givenUp, 1);
	assert.equal(givenUpAttemptId, "retry_attempt_1");
});

test("executeWithRetry reports structured cancellation before first attempt", async () => {
	const controller = new AbortController();
	controller.abort({
		code: "leader_interrupted",
		message: "leader stopped retry",
	});
	await assert.rejects(
		() =>
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
		(error: unknown) =>
			error instanceof CrewCancellationError &&
			error.reason.code === "leader_interrupted" &&
			/leader stopped retry/.test(error.message),
	);
});

test("executeWithRetry preserves structured cancellation during retry backoff", async () => {
	const controller = new AbortController();
	await assert.rejects(
		() =>
			executeWithRetry(
				async () => {
					throw new Error("temporary");
				},
				{
					maxAttempts: 3,
					backoffMs: 50,
					jitterRatio: 0,
					exponentialFactor: 1,
				},
				{
					signal: controller.signal,
					onAttemptFailed: () =>
						controller.abort({
							code: "leader_interrupted",
							message: "leader stopped during retry backoff",
						}),
				},
			),
		(error: unknown) =>
			error instanceof CrewCancellationError &&
			error.reason.code === "leader_interrupted" &&
			/leader stopped during retry backoff/.test(error.message),
	);
});

test("calculateRetryDelay applies exponential backoff and jitter bounds", () => {
	assert.equal(
		calculateRetryDelay(3, {
			maxAttempts: 3,
			backoffMs: 100,
			jitterRatio: 0,
			exponentialFactor: 2,
		}),
		400,
	);
	const jittered = calculateRetryDelay(
		1,
		{
			maxAttempts: 3,
			backoffMs: 100,
			jitterRatio: 0.5,
			exponentialFactor: 2,
		},
		() => 1,
	);
	assert.equal(jittered, 150);
});
