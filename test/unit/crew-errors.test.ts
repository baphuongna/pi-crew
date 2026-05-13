/**
 * Unit tests for crew-errors.ts
 * Based on oh-my-pi pattern from compaction/errors.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
	CrewError,
	CrewCancelledError,
	CrewTimeoutError,
	CrewDeadletterError,
	CrewAbortError,
	CrewManifestError,
	CrewLockError,
	CrewTurnLimitError,
	CrewGateError,
	CrewSessionError,
	classifyError,
	isInterruptError,
	isAgentError,
	type CrewRunOutcome,
} from "../../src/runtime/errors/crew-errors.ts";

describe("CrewError hierarchy", () => {
	it("CrewError base class exists and has correct code", () => {
		// Check base class exists
		assert.strictEqual(CrewError.prototype.constructor, CrewError);
		// Check subclasses have correct codes
		assert.strictEqual(CrewCancelledError.prototype.constructor.name, "CrewCancelledError");
		assert.strictEqual(CrewTimeoutError.prototype.constructor.name, "CrewTimeoutError");
		assert.strictEqual(CrewDeadletterError.prototype.constructor.name, "CrewDeadletterError");
	});

	it("CrewCancelledError has correct code and message", () => {
		const err = new CrewCancelledError();
		assert.strictEqual(err.code, "CREW_CANCELLED");
		assert.strictEqual(err.message, "Crew run cancelled");
		assert(err instanceof Error);
		assert(err instanceof CrewError);
	});

	it("CrewCancelledError accepts custom message", () => {
		const err = new CrewCancelledError("User cancelled at step 3");
		assert.strictEqual(err.message, "User cancelled at step 3");
	});

	it("CrewTimeoutError includes duration in message", () => {
		const err = new CrewTimeoutError(60_000);
		assert.strictEqual(err.code, "CREW_TIMEOUT");
		assert.strictEqual(err.maxDurationMs, 60_000);
		assert.match(err.message, /60000ms/);
	});

	it("CrewTimeoutError accepts custom message", () => {
		const err = new CrewTimeoutError(30_000, "Step 2 exceeded 30s limit");
		assert.strictEqual(err.message, "Step 2 exceeded 30s limit");
	});

	it("CrewDeadletterError includes agentId and reason", () => {
		const err = new CrewDeadletterError("agent-42", "OOM killed");
		assert.strictEqual(err.code, "CREW_DEADLETTER");
		assert.strictEqual(err.agentId, "agent-42");
		assert.strictEqual(err.reason, "OOM killed");
		assert.match(err.message, /agent-42/);
		assert.match(err.message, /OOM killed/);
	});

	it("CrewAbortError has correct defaults", () => {
		const err = new CrewAbortError();
		assert.strictEqual(err.code, "CREW_ABORT");
		assert.strictEqual(err.message, "Crew run aborted");
	});

	it("CrewManifestError includes runId and taskId", () => {
		const err = new CrewManifestError("Missing step 'build'", "run-abc", "task-123");
		assert.strictEqual(err.code, "CREW_MANIFEST_ERROR");
		assert.strictEqual(err.runId, "run-abc");
		assert.strictEqual(err.taskId, "task-123");
		assert.match(err.message, /Missing step/);
	});

	it("CrewLockError includes lockPath", () => {
		const err = new CrewLockError("Lock held by stale process", "/tmp/crew.lock");
		assert.strictEqual(err.code, "CREW_LOCK_ERROR");
		assert.strictEqual(err.lockPath, "/tmp/crew.lock");
	});

	it("CrewTurnLimitError includes agentId and maxTurns", () => {
		const err = new CrewTurnLimitError("agent-5", 10);
		assert.strictEqual(err.code, "CREW_TURN_LIMIT");
		assert.strictEqual(err.agentId, "agent-5");
		assert.strictEqual(err.maxTurns, 10);
		assert.match(err.message, /agent-5.*10/);
	});

	it("CrewGateError includes gateName", () => {
		const err = new CrewGateError("quality-check", "Score 0.3 below threshold 0.8");
		assert.strictEqual(err.code, "CREW_GATE_ERROR");
		assert.strictEqual(err.gateName, "quality-check");
	});

	it("CrewSessionError includes optional agentId", () => {
		const err1 = new CrewSessionError("Model 'gpt-5' not found");
		assert.strictEqual(err1.code, "CREW_SESSION_ERROR");
		assert.strictEqual(err1.agentId, undefined);
		const err2 = new CrewSessionError("Model not found", "agent-3");
		assert.strictEqual(err2.agentId, "agent-3");
	});

	it("toString returns [ClassName] message", () => {
		const err = new CrewDeadletterError("a1", "crash");
		assert.strictEqual(err.toString(), "[CrewDeadletterError] Agent a1 deadlettered: crash");
	});
});

describe("classifyError", () => {
	const testCases: Array<{ error: Error; expected: CrewRunOutcome }> = [
		{ error: new CrewCancelledError(), expected: "cancelled" },
		{ error: new CrewTimeoutError(60_000), expected: "timeout" },
		{ error: new CrewDeadletterError("a1", "OOM"), expected: "deadletter" },
		{ error: new CrewAbortError(), expected: "aborted" },
		{ error: new CrewGateError("gate1", "failed"), expected: "failed" },
		{ error: new CrewManifestError("bad manifest"), expected: "failed" },
		{ error: new Error("unknown error"), expected: "failed" },
	];

	for (const { error, expected } of testCases) {
		it(`classifies ${error.constructor.name} as ${expected}`, () => {
			assert.strictEqual(classifyError(error), expected);
		});
	}
});

describe("isInterruptError", () => {
	it("returns true for CrewCancelledError", () => {
		assert.strictEqual(isInterruptError(new CrewCancelledError()), true);
	});

	it("returns true for CrewAbortError", () => {
		assert.strictEqual(isInterruptError(new CrewAbortError()), true);
	});

	it("returns true for CrewTimeoutError", () => {
		assert.strictEqual(isInterruptError(new CrewTimeoutError(60_000)), true);
	});

	it("returns false for CrewDeadletterError", () => {
		assert.strictEqual(isInterruptError(new CrewDeadletterError("a1", "crash")), false);
	});

	it("returns false for generic Error", () => {
		assert.strictEqual(isInterruptError(new Error("boom")), false);
	});
});

describe("isAgentError", () => {
	it("returns true for CrewDeadletterError", () => {
		assert.strictEqual(isAgentError(new CrewDeadletterError("a1", "OOM")), true);
	});

	it("returns true for CrewTurnLimitError", () => {
		assert.strictEqual(isAgentError(new CrewTurnLimitError("a1", 10)), true);
	});

	it("returns true for CrewSessionError", () => {
		assert.strictEqual(isAgentError(new CrewSessionError("model not found")), true);
	});

	it("returns false for CrewGateError", () => {
		assert.strictEqual(isAgentError(new CrewGateError("g1", "bad score")), false);
	});

	it("returns false for generic Error", () => {
		assert.strictEqual(isAgentError(new Error("boom")), false);
	});
});