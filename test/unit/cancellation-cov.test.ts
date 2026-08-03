import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildSyntheticTerminalEvidence,
	CrewCancellationError,
	cancellationErrorFromSignal,
	cancellationReasonFromSignal,
	cancellationReasonFromUnknown,
	throwIfCancelled,
} from "../../src/runtime/process/cancellation.ts";

describe("cancellation", () => {
	// buildSyntheticTerminalEvidence
	describe("buildSyntheticTerminalEvidence", () => {
		it("creates evidence with cancelled status", () => {
			const reason = {
				code: "caller_cancelled" as const,
				message: "test",
			};
			const evidence = buildSyntheticTerminalEvidence("worker", reason);
			assert.equal(evidence.operation, "worker");
			assert.equal(evidence.status, "cancelled");
			assert.ok(evidence.finishedAt);
			assert.equal(evidence.reason, reason);
		});

		it("preserves startedAt when provided", () => {
			const evidence = buildSyntheticTerminalEvidence("tool", { code: "tool_timeout", message: "timed out" }, "2025-01-01T00:00:00Z");
			assert.equal(evidence.startedAt, "2025-01-01T00:00:00Z");
		});

		it("includes reason when provided", () => {
			const reason = {
				code: "shutdown" as const,
				message: "System shutting down",
			};
			const evidence = buildSyntheticTerminalEvidence("model", reason);
			assert.equal(evidence.reason, reason);
		});
	});

	// CrewCancellationError
	describe("CrewCancellationError", () => {
		it("is an instance of Error", () => {
			const err = new CrewCancellationError({
				code: "caller_cancelled",
				message: "test",
			});
			assert.ok(err instanceof Error);
			assert.equal(err.name, "CrewCancellationError");
		});

		it("stores reason", () => {
			const reason = {
				code: "provider_timeout" as const,
				message: "Provider timed out",
			};
			const err = new CrewCancellationError(reason);
			assert.deepEqual(err.reason, reason);
		});

		it("message matches reason.message", () => {
			const err = new CrewCancellationError({
				code: "unknown",
				message: "Something happened",
			});
			assert.equal(err.message, "Something happened");
		});
	});

	// cancellationReasonFromUnknown
	describe("cancellationReasonFromUnknown", () => {
		it("handles CrewCancellationError input", () => {
			const reason = {
				code: "leader_interrupted" as const,
				message: "Leader stopped",
			};
			const err = new CrewCancellationError(reason);
			const result = cancellationReasonFromUnknown(err);
			assert.equal(result.code, "leader_interrupted");
		});

		it("handles string input with known code", () => {
			const result = cancellationReasonFromUnknown("worker_timeout");
			assert.equal(result.code, "worker_timeout");
			assert.ok(result.message.includes("worker_timeout"));
		});

		it("handles string input with unknown code", () => {
			const result = cancellationReasonFromUnknown("custom message");
			assert.equal(result.code, "caller_cancelled");
			assert.equal(result.message, "custom message");
		});

		it("handles Error input", () => {
			const err = new Error("my error");
			const result = cancellationReasonFromUnknown(err);
			assert.equal(result.code, "caller_cancelled");
			assert.equal(result.message, "my error");
			assert.equal(result.cause, err);
		});

		it("handles object with code and message", () => {
			const result = cancellationReasonFromUnknown({
				code: "shutdown",
				message: "Shutting down",
			});
			assert.equal(result.code, "shutdown");
			assert.equal(result.message, "Shutting down");
		});

		it("handles object with unknown code", () => {
			const result = cancellationReasonFromUnknown({
				code: "custom_code",
				message: "msg",
			});
			assert.equal(result.code, "caller_cancelled");
		});

		it("handles null/undefined", () => {
			assert.equal(cancellationReasonFromUnknown(null).code, "caller_cancelled");
			assert.equal(cancellationReasonFromUnknown(undefined).code, "caller_cancelled");
		});

		it("handles number", () => {
			assert.equal(cancellationReasonFromUnknown(42).code, "caller_cancelled");
		});
	});

	// cancellationReasonFromSignal
	describe("cancellationReasonFromSignal", () => {
		it("returns caller_cancelled for undefined signal", () => {
			const result = cancellationReasonFromSignal(undefined);
			assert.equal(result.code, "caller_cancelled");
		});

		it("returns caller_cancelled for non-aborted signal", () => {
			const controller = new AbortController();
			const result = cancellationReasonFromSignal(controller.signal);
			assert.equal(result.code, "caller_cancelled");
		});

		it("extracts reason from aborted signal", () => {
			const controller = new AbortController();
			controller.abort(
				new CrewCancellationError({
					code: "tool_timeout",
					message: "Tool took too long",
				}),
			);
			const result = cancellationReasonFromSignal(controller.signal);
			assert.equal(result.code, "tool_timeout");
		});
	});

	// cancellationErrorFromSignal
	describe("cancellationErrorFromSignal", () => {
		it("returns CrewCancellationError for undefined signal", () => {
			const err = cancellationErrorFromSignal(undefined);
			assert.ok(err instanceof CrewCancellationError);
		});

		it("returns CrewCancellationError for non-aborted signal", () => {
			const controller = new AbortController();
			const err = cancellationErrorFromSignal(controller.signal);
			assert.ok(err instanceof CrewCancellationError);
			assert.equal(err.reason.code, "caller_cancelled");
		});

		it("returns error with reason from aborted signal", () => {
			const controller = new AbortController();
			controller.abort("worker_timeout");
			const err = cancellationErrorFromSignal(controller.signal);
			assert.equal(err.reason.code, "worker_timeout");
		});
	});

	// throwIfCancelled
	describe("throwIfCancelled", () => {
		it("does not throw for undefined signal", () => {
			assert.doesNotThrow(() => throwIfCancelled(undefined));
		});

		it("does not throw for non-aborted signal", () => {
			const controller = new AbortController();
			assert.doesNotThrow(() => throwIfCancelled(controller.signal));
		});

		it("throws CrewCancellationError for aborted signal", () => {
			const controller = new AbortController();
			controller.abort("shutdown");
			assert.throws(() => throwIfCancelled(controller.signal), CrewCancellationError);
		});
	});
});
