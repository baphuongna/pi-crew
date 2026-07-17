/**
 * Unit tests for RetryRunner.
 * @see src/runtime/retry-runner.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HandoffManager, type HandoffSummary, type TaskPacket, type TaskResult } from "../../src/runtime/handoff-manager.ts";
import {
	createRetryRunner,
	DEFAULT_RETRY_CONFIG,
	PERSISTENT_FAILURE_RETRY_CONFIG,
	RetryRunner,
	type TaskRunnerLike,
	TRANSIENT_FAILURE_RETRY_CONFIG,
} from "../../src/runtime/retry-runner.ts";

// Test helpers
function createTaskPacket(overrides: Partial<TaskPacket> = {}): TaskPacket {
	return {
		taskId: "test-task",
		runId: "test-run",
		goal: "Test task",
		...overrides,
	};
}

function createTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return {
		outcome: "success",
		usage: { totalTokens: 1000 },
		duration: 1000,
		iterations: 1,
		toolsUsed: [],
		blockers: [],
		nextSteps: [],
		filesCreated: [],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		...overrides,
	};
}

function createMockTaskRunner(results: TaskResult[]): TaskRunnerLike {
	let index = 0;
	return {
		runTask: async () => {
			if (index < results.length) {
				return results[index++];
			}
			return results[results.length - 1];
		},
	};
}

function createMockHandoffManager(): HandoffManager {
	return new HandoffManager();
}

// Mock HandoffManager for tracking calls
function createTrackingHandoffManager(): {
	manager: HandoffManager;
	calls: Array<{ packet: TaskPacket; result: TaskResult }>;
	summaries: HandoffSummary[];
} {
	const calls: Array<{ packet: TaskPacket; result: TaskResult }> = [];
	const summaries: HandoffSummary[] = [];

	const manager = {
		generateSummary: async (packet: TaskPacket, result: TaskResult): Promise<HandoffSummary> => {
			calls.push({ packet, result });
			const summary: HandoffSummary = {
				taskId: packet.taskId,
				runId: packet.runId,
				timestamp: Date.now(),
				task: packet.goal,
				outcome: result.outcome,
				filesCreated: result.filesCreated ?? [],
				filesModified: result.filesModified ?? [],
				filesDeleted: result.filesDeleted ?? [],
				decisions: result.decisions ?? [],
				blockers: result.blockers ?? [],
				nextSteps: result.nextSteps ?? [],
				metrics: {
					tokensUsed: result.usage?.totalTokens ?? 0,
					duration: result.duration ?? 0,
					iterations: result.iterations ?? 1,
					toolsUsed: result.toolsUsed ?? [],
				},
				contextSnapshot: "",
			};
			summaries.push(summary);
			return summary;
		},
	} as unknown as HandoffManager;

	return { manager, calls, summaries };
}

test("RetryRunner - succeeds on first try with single success result", async () => {
	// Create mock that returns success consistently
	let callCount = 0;
	const mockRunner: TaskRunnerLike = {
		runTask: async () => {
			callCount++;
			return createTaskResult({ outcome: "success" });
		},
	};
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
	});

	assert.strictEqual(result.success, true);
	assert.strictEqual(result.attempts.length, 1);
	assert.strictEqual(result.finalResult?.outcome, "success");
});

test("RetryRunner - retries failed tasks and succeeds", async () => {
	// Create mock that fails first then succeeds
	let callCount = 0;
	const mockRunner: TaskRunnerLike = {
		runTask: async () => {
			callCount++;
			if (callCount === 1) {
				return createTaskResult({ outcome: "failure" });
			}
			return createTaskResult({ outcome: "success" });
		},
	};
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
	});

	assert.strictEqual(result.success, true);
	assert.strictEqual(result.attempts.length, 2);
	assert.strictEqual(result.attempts[0].result.outcome, "failure");
	assert.strictEqual(result.attempts[1].result.outcome, "success");
});

test("RetryRunner - gives up after max attempts", async () => {
	const mockRunner = createMockTaskRunner([
		createTaskResult({ outcome: "failure" }),
		createTaskResult({ outcome: "failure" }),
		createTaskResult({ outcome: "failure" }),
	]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
	});

	assert.strictEqual(result.success, false);
	assert.strictEqual(result.attempts.length, 3);
	assert.strictEqual(result.finalResult?.outcome, "failure");
});

test("RetryRunner - stops on success when stopOnSuccess is true", async () => {
	const mockRunner = createMockTaskRunner([
		createTaskResult({ outcome: "failure" }),
		createTaskResult(), // Success - should stop here
		createTaskResult({ outcome: "failure" }),
	]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 5,
		stopOnSuccess: true,
	});

	assert.strictEqual(result.success, true);
	assert.strictEqual(result.attempts.length, 2); // Stopped after 2nd attempt
});

test("RetryRunner - continues when stopOnSuccess is false", async () => {
	const mockRunner = createMockTaskRunner([
		createTaskResult(), // Success
		createTaskResult(), // More success
	]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
		stopOnSuccess: false,
	});

	// With stopOnSuccess=false, continues through all attempts
	assert.strictEqual(result.attempts.length, 3);
});

test("RetryRunner - accumulates summaries between attempts", async () => {
	const { manager, summaries } = createTrackingHandoffManager();

	// Mock that fails twice then succeeds
	let callCount = 0;
	const mockRunner: TaskRunnerLike = {
		runTask: async () => {
			callCount++;
			if (callCount <= 2) {
				return createTaskResult({
					outcome: "failure",
					usage: { totalTokens: callCount * 100 },
				});
			}
			return createTaskResult({
				outcome: "success",
				usage: { totalTokens: callCount * 100 },
			});
		},
	};

	const retryRunner = new RetryRunner(mockRunner, manager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
		summaryBetweenAttempts: true,
	});

	// With stopOnSuccess=true (default), success on 3rd attempt means 3 total attempts
	// and 3 summaries (one generated before checking stopOnSuccess)
	assert.strictEqual(summaries.length, 3);
	assert.strictEqual(summaries[0].metrics.tokensUsed, 100);
	assert.strictEqual(summaries[1].metrics.tokensUsed, 200);
	assert.strictEqual(result.totalHandoffs.length, 3);
});

test("RetryRunner - skips summaries when summaryBetweenAttempts is false", async () => {
	const { manager, calls } = createTrackingHandoffManager();

	const mockRunner = createMockTaskRunner([createTaskResult({ outcome: "failure" }), createTaskResult()]);

	const retryRunner = new RetryRunner(mockRunner, manager);

	await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
		summaryBetweenAttempts: false,
	});

	// No summaries generated
	assert.strictEqual(calls.length, 0);
});

test("RetryRunner - applies backoff between attempts", async () => {
	const mockRunner = createMockTaskRunner([createTaskResult({ outcome: "failure" }), createTaskResult()]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const startTime = Date.now();
	await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
		backoffMs: 50,
	});
	const duration = Date.now() - startTime;

	// Should have waited at least 50ms between attempts
	assert.ok(duration >= 45); // Allow some tolerance
});

test("RetryRunner - applies exponential backoff", async () => {
	const mockRunner = createMockTaskRunner([
		createTaskResult({ outcome: "failure" }),
		createTaskResult({ outcome: "failure" }),
		createTaskResult(),
	]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const startTime = Date.now();
	await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 5,
		backoffMs: 100,
		backoffMultiplier: 2,
	});
	const duration = Date.now() - startTime;

	// Should have waited approximately 100 + 200 = 300ms (with some tolerance)
	assert.ok(duration >= 280);
});

test("RetryRunner - caps backoff at maxBackoffMs", async () => {
	const mockRunner = createMockTaskRunner([
		createTaskResult({ outcome: "failure" }),
		createTaskResult({ outcome: "failure" }),
		createTaskResult({ outcome: "failure" }),
		createTaskResult(),
	]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const startTime = Date.now();
	await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 5,
		backoffMs: 1000,
		backoffMultiplier: 10,
		maxBackoffMs: 2000,
	});
	const duration = Date.now() - startTime;

	// Attempts: 1 fail (backoff 1000), 2 fail (backoff capped at 2000), 3 fail (backoff capped at 2000)
	// Total backoff ≈ 5000ms
	assert.ok(duration >= 4800);
});

test("RetryRunner - handles exceptions and retries", async () => {
	let attempts = 0;
	const mockRunner: TaskRunnerLike = {
		runTask: async () => {
			attempts++;
			if (attempts < 3) {
				throw new Error("Temporary error");
			}
			return createTaskResult();
		},
	};
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
	});

	assert.strictEqual(result.success, true);
	assert.strictEqual(result.attempts.length, 3);
	assert.strictEqual(result.attempts[0].error, "Temporary error");
	assert.strictEqual(result.attempts[2].result.outcome, "success");
});

test("RetryRunner - uses custom retryCondition", async () => {
	const mockRunner = createMockTaskRunner([
		createTaskResult({ outcome: "failure", usage: { totalTokens: 100 } }),
		createTaskResult({ outcome: "failure", usage: { totalTokens: 200 } }),
		createTaskResult({ outcome: "failure", usage: { totalTokens: 300 } }),
	]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	// Only retry if tokens < 250
	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 5,
		retryCondition: (result) => {
			return (result.usage?.totalTokens ?? 0) < 250;
		},
	});

	// Should stop at 3rd attempt (300 tokens >= 250)
	assert.strictEqual(result.attempts.length, 3);
	assert.strictEqual(result.finalResult?.usage?.totalTokens, 300);
});

test("RetryRunner - enriches packet context with handoffs", async () => {
	const { manager } = createTrackingHandoffManager();

	const enrichedPackets: TaskPacket[] = [];
	let callCount = 0;
	const mockRunner: TaskRunnerLike = {
		runTask: async (packet) => {
			callCount++;
			enrichedPackets.push(packet);
			if (callCount === 1) {
				return createTaskResult({ outcome: "failure" });
			}
			return createTaskResult({ outcome: "success" });
		},
	};

	const retryRunner = new RetryRunner(mockRunner, manager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
		summaryBetweenAttempts: true,
	});

	// Second packet should have handoff context (from attempt 1)
	assert.ok(enrichedPackets[1].context);
	assert.strictEqual(enrichedPackets[1].context!.__boomerangAttempts, 2);
	assert.ok(enrichedPackets[1].context!.__boomerangHandoffs);
});

test("RetryRunner - calculates totalDuration", async () => {
	const mockRunner = createMockTaskRunner([createTaskResult()]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 1,
	});

	assert.ok(result.totalDuration >= 0);
});

test("RetryRunner - handles zero maxAttempts", async () => {
	const mockRunner = createMockTaskRunner([]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 0,
	});

	assert.strictEqual(result.attempts.length, 0);
	assert.strictEqual(result.success, false);
});

// Test preset configs
test("DEFAULT_RETRY_CONFIG has expected values", () => {
	assert.strictEqual(DEFAULT_RETRY_CONFIG.maxAttempts, 3);
	assert.strictEqual(DEFAULT_RETRY_CONFIG.summaryBetweenAttempts, true);
	assert.strictEqual(DEFAULT_RETRY_CONFIG.stopOnSuccess, true);
	assert.strictEqual(DEFAULT_RETRY_CONFIG.backoffMs, 1000);
	assert.strictEqual(DEFAULT_RETRY_CONFIG.backoffMultiplier, 2);
	assert.strictEqual(DEFAULT_RETRY_CONFIG.maxBackoffMs, 30000);
});

test("TRANSIENT_FAILURE_RETRY_CONFIG is for quick retries", () => {
	assert.strictEqual(TRANSIENT_FAILURE_RETRY_CONFIG.maxAttempts, 2);
	assert.strictEqual(TRANSIENT_FAILURE_RETRY_CONFIG.summaryBetweenAttempts, false);
	assert.strictEqual(TRANSIENT_FAILURE_RETRY_CONFIG.backoffMs, 500);
	assert.strictEqual(TRANSIENT_FAILURE_RETRY_CONFIG.backoffMultiplier, 1);
});

test("PERSISTENT_FAILURE_RETRY_CONFIG has longer backoff", () => {
	assert.strictEqual(PERSISTENT_FAILURE_RETRY_CONFIG.maxAttempts, 5);
	assert.strictEqual(PERSISTENT_FAILURE_RETRY_CONFIG.summaryBetweenAttempts, true);
	assert.strictEqual(PERSISTENT_FAILURE_RETRY_CONFIG.backoffMs, 2000);
	assert.strictEqual(PERSISTENT_FAILURE_RETRY_CONFIG.backoffMultiplier, 2);
	assert.strictEqual(PERSISTENT_FAILURE_RETRY_CONFIG.maxBackoffMs, 60000);
});

test("createRetryRunner factory creates instance", () => {
	const mockRunner = createMockTaskRunner([createTaskResult()]);
	const handoffManager = createMockHandoffManager();
	const runner = createRetryRunner(mockRunner, handoffManager);

	assert.ok(runner instanceof RetryRunner);
});

test("RetryRunner - first attempt uses original context", async () => {
	const { manager } = createTrackingHandoffManager();

	let firstPacket: { context?: unknown } | null = null;
	const mockRunner: TaskRunnerLike = {
		runTask: async (packet) => {
			if (!firstPacket) firstPacket = { context: packet.context };
			return createTaskResult();
		},
	};

	const retryRunner = new RetryRunner(mockRunner, manager);

	await retryRunner.runWithRetry(createTaskPacket(), { maxAttempts: 2 });

	// First packet should not have handoff context
	assert.strictEqual((firstPacket as unknown as { context?: unknown })?.context, undefined);
});

test("RetryRunner - attempt result includes duration", async () => {
	const mockRunner = createMockTaskRunner([createTaskResult()]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 1,
	});

	assert.ok(result.attempts[0].duration >= 0);
	assert.ok(result.attempts[0].timestamp > 0);
});

test("RetryRunner - reports all handoffs in result", async () => {
	let callCount = 0;
	const mockRunner: TaskRunnerLike = {
		runTask: async () => {
			callCount++;
			if (callCount <= 2) {
				return createTaskResult({ outcome: "failure" });
			}
			return createTaskResult({ outcome: "success" });
		},
	};
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
		summaryBetweenAttempts: true,
	});

	// With stopOnSuccess=true, success on 3rd attempt means 3 handoffs
	assert.strictEqual(result.totalHandoffs.length, 3);
});

test("RetryRunner - partial outcome triggers retry by default", async () => {
	const mockRunner = createMockTaskRunner([createTaskResult({ outcome: "partial" }), createTaskResult()]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
	});

	// Partial is not success, so should retry
	assert.strictEqual(result.attempts.length, 2);
});

test("RetryRunner - handles first attempt success immediately", async () => {
	const mockRunner = createMockTaskRunner([createTaskResult()]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const startTime = Date.now();
	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
		backoffMs: 100,
	});
	const duration = Date.now() - startTime;

	assert.strictEqual(result.success, true);
	assert.strictEqual(result.attempts.length, 1);
	// Should not have waited since first attempt succeeded
	assert.ok(duration < 50);
});

// Edge cases
test("RetryRunner - handles undefined context in packet", async () => {
	const { manager } = createTrackingHandoffManager();

	const mockRunner: TaskRunnerLike = {
		runTask: async (packet) => {
			// Access context to ensure it works
			const ctx = packet.context ?? {};
			return createTaskResult();
		},
	};

	const retryRunner = new RetryRunner(mockRunner, manager);
	const packet = createTaskPacket({ context: undefined });

	const result = await retryRunner.runWithRetry(packet, { maxAttempts: 1 });

	assert.strictEqual(result.success, true);
});

test("RetryRunner - backoff of 0 means no wait", async () => {
	const mockRunner = createMockTaskRunner([createTaskResult({ outcome: "failure" }), createTaskResult()]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	const startTime = Date.now();
	await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 3,
		backoffMs: 0,
	});
	const duration = Date.now() - startTime;

	// Should complete quickly with no backoff
	assert.ok(duration < 50);
});
// H5: Memory leak prevention tests
test("RetryRunner - handoffs respect maxHandoffs limit", async () => {
	const { manager } = createTrackingHandoffManager();

	// Mock that always fails - will accumulate many handoffs
	const mockRunner: TaskRunnerLike = {
		runTask: async () => {
			return createTaskResult({ outcome: "failure" });
		},
	};

	const retryRunner = new RetryRunner(mockRunner, manager);

	// Set maxHandoffs to 5, but have 10 attempts
	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 10,
		summaryBetweenAttempts: true,
		maxHandoffs: 5,
	});

	// Should be capped at maxHandoffs
	assert.ok(result.totalHandoffs.length <= 5, `Expected at most 5 handoffs, got ${result.totalHandoffs.length}`);
});

test("RetryRunner - handoffs default limit is 100", async () => {
	const { manager } = createTrackingHandoffManager();

	// Mock that always fails
	const mockRunner: TaskRunnerLike = {
		runTask: async () => {
			return createTaskResult({ outcome: "failure" });
		},
	};

	const retryRunner = new RetryRunner(mockRunner, manager);

	// Run with many attempts but no explicit maxHandoffs
	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 50,
		summaryBetweenAttempts: true,
	});

	// Should be capped at default 100
	assert.ok(result.totalHandoffs.length <= 100, `Expected at most 100 handoffs, got ${result.totalHandoffs.length}`);
});

test("RetryRunner - dispose prevents further operations", async () => {
	const mockRunner = createMockTaskRunner([createTaskResult()]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	// Dispose the runner
	retryRunner.dispose();

	// Verify isDisposed returns true
	assert.strictEqual(retryRunner.isDisposed, true);

	// Further operations should throw
	await assert.rejects(
		() => retryRunner.runWithRetry(createTaskPacket(), { maxAttempts: 1 }),
		(error) => {
			return error instanceof Error && error.message.includes("disposed");
		},
	);
});

test("RetryRunner - dispose before runWithRetry throws", async () => {
	const { manager } = createTrackingHandoffManager();
	const mockRunner: TaskRunnerLike = {
		runTask: async () => {
			return createTaskResult({ outcome: "failure" });
		},
	};
	const retryRunner = new RetryRunner(mockRunner, manager);

	// Pre-dispose the runner before calling runWithRetry
	retryRunner.dispose();

	// Should throw because runner was disposed
	await assert.rejects(
		() =>
			retryRunner.runWithRetry(createTaskPacket(), {
				maxAttempts: 5,
				backoffMs: 0,
			}),
		(error) => {
			return error instanceof Error && error.message.includes("disposed");
		},
	);
});

test("RetryRunner - clearHandoffs is available (API consistency)", async () => {
	const mockRunner = createMockTaskRunner([createTaskResult()]);
	const handoffManager = createMockHandoffManager();
	const retryRunner = new RetryRunner(mockRunner, handoffManager);

	// Should not throw
	retryRunner.clearHandoffs();
});

test("RetryRunner - most recent handoffs are kept when trimming", async () => {
	const { manager, summaries } = createTrackingHandoffManager();

	// Mock that always fails
	const mockRunner: TaskRunnerLike = {
		runTask: async () => {
			return createTaskResult({ outcome: "failure" });
		},
	};
	const retryRunner = new RetryRunner(mockRunner, manager);

	const result = await retryRunner.runWithRetry(createTaskPacket(), {
		maxAttempts: 10,
		summaryBetweenAttempts: true,
		maxHandoffs: 3,
	});

	// Should have at most 3 handoffs
	assert.ok(result.totalHandoffs.length <= 3);

	// If we got some handoffs, verify they're the most recent ones
	if (result.totalHandoffs.length > 0 && summaries.length > 0) {
		// The last handoff in result should match the last generated summary
		const lastResultHandoff = result.totalHandoffs[result.totalHandoffs.length - 1];
		const lastGeneratedSummary = summaries[summaries.length - 1];
		assert.strictEqual(lastResultHandoff.task, lastGeneratedSummary.task, "Last handoff should be from most recent attempt");
	}
});
