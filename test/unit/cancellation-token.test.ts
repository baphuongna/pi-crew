import assert from "node:assert/strict";
import test from "node:test";
import { CrewCancellationError } from "../../src/runtime/process/cancellation.ts";
import { CancellationToken, createCancellationToken } from "../../src/runtime/process/cancellation-token.ts";

test("CancellationToken records heartbeat stage and emits state", () => {
	const states: unknown[] = [];
	const token = createCancellationToken({
		onHeartbeat: (state) => states.push(state),
		now: () => new Date("2026-05-06T00:00:00.000Z"),
	});
	const state = token.heartbeat("scan:runs");
	assert.equal(state.aborted, false);
	assert.equal(state.lastHeartbeatAt, "2026-05-06T00:00:00.000Z");
	assert.equal(state.lastHeartbeatStage, "scan:runs");
	assert.deepEqual(states, [state]);
});

test("CancellationToken throws structured cancellation and ignores duplicate abort", () => {
	const token = new CancellationToken();
	token.abort({ code: "shutdown", message: "session ended" });
	token.abort({ code: "caller_cancelled", message: "later" });
	assert.equal(token.aborted, true);
	assert.equal(token.reason?.code, "shutdown");
	assert.throws(
		() => token.throwIfCancelled(),
		(error: unknown) => {
			assert.ok(error instanceof CrewCancellationError);
			assert.equal(error.reason.code, "shutdown");
			assert.equal(error.reason.message, "session ended");
			return true;
		},
	);
});

test("CancellationToken follows parent AbortSignal", () => {
	const controller = new AbortController();
	const token = createCancellationToken({ signal: controller.signal });
	controller.abort({ code: "worker_timeout", message: "worker timed out" });
	assert.equal(token.aborted, true);
	assert.equal(token.reason?.code, "worker_timeout");
});

test("CancellationToken wait rejects when aborted", async () => {
	const token = new CancellationToken();
	const waiting = token.wait(10_000);
	token.abort("leader stopped wait");
	await assert.rejects(waiting, (error: unknown) => {
		assert.ok(error instanceof CrewCancellationError);
		assert.equal(error.reason.message, "leader stopped wait");
		return true;
	});
});
