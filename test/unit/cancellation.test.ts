import assert from "node:assert/strict";
import test from "node:test";
import {
	CrewCancellationError,
	cancellationErrorFromSignal,
	cancellationReasonFromSignal,
	throwIfCancelled,
} from "../../src/runtime/process/cancellation.ts";

test("cancellationReasonFromSignal preserves structured abort reason", () => {
	const controller = new AbortController();
	controller.abort({
		code: "worker_timeout",
		message: "worker stopped responding",
	});
	assert.deepEqual(cancellationReasonFromSignal(controller.signal), {
		code: "worker_timeout",
		message: "worker stopped responding",
		cause: { code: "worker_timeout", message: "worker stopped responding" },
	});
});

test("throwIfCancelled throws CrewCancellationError", () => {
	const controller = new AbortController();
	controller.abort("shutdown");
	assert.throws(
		() => throwIfCancelled(controller.signal),
		(error) => {
			assert.equal(error instanceof CrewCancellationError, true);
			assert.equal((error as CrewCancellationError).reason.code, "shutdown");
			return true;
		},
	);
});

test("cancellationErrorFromSignal falls back to caller_cancelled", () => {
	const controller = new AbortController();
	controller.abort(new Error("user cancelled"));
	const error = cancellationErrorFromSignal(controller.signal);
	assert.equal(error.reason.code, "caller_cancelled");
	assert.equal(error.message, "user cancelled");
});
