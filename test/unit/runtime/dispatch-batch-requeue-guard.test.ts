import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldRequeueForRetry } from "../../../src/runtime/dispatch-batch.ts";

/**
 * Finding 7 regression (2026-09-23 live battery, run team_20260923164504_e9c6907a72ac42bc):
 * a cross-session cancel raced the retry loop — cancel wrote task.cancelled at
 * 16:46:22.930 and run.cancelled at 16:46:22.987, but the re-queue branch
 * (`attempt > 1 && status !== queued && status !== running`) treated the external
 * CANCELLED state as "our own failure" and resurrected the task at 16:46:23.948;
 * the replacement worker ran 47s after the user cancelled.
 *
 * The guard must re-queue ONLY: attempt > 1 AND run still active AND task === "failed".
 */
describe("shouldRequeueForRetry (cancel-race guard, finding 7)", () => {
	it("attempt 1 never re-queues (original externally-terminal guard owns that path)", () => {
		assert.equal(shouldRequeueForRetry({ attempt: 1, taskStatus: "failed", manifestStatus: "running" }), false);
	});

	it("attempt 2 re-queues OUR OWN terminal failure on an active run (US-003 semantics preserved)", () => {
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "failed", manifestStatus: "running" }), true);
		assert.equal(shouldRequeueForRetry({ attempt: 3, taskStatus: "failed", manifestStatus: "planning" }), true);
	});

	it("NEVER re-queues an externally CANCELLED task — the live-battery race", () => {
		// exact live timeline: task cancelled before manifest flipped
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "cancelled", manifestStatus: "running" }), false);
		// both already terminal
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "cancelled", manifestStatus: "cancelled" }), false);
	});

	it("NEVER re-queues when the RUN manifest is terminal, even for our own failure (belt-and-suspenders)", () => {
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "failed", manifestStatus: "cancelled" }), false);
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "failed", manifestStatus: "completed" }), false);
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "failed", manifestStatus: "failed" }), false);
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "failed", manifestStatus: "blocked" }), false);
	});

	it("externally COMPLETED tasks are never resurrected", () => {
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "completed", manifestStatus: "running" }), false);
	});

	it("normal queued/running states need no re-queue (retry proceeds as-is)", () => {
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "queued", manifestStatus: "running" }), false);
		assert.equal(shouldRequeueForRetry({ attempt: 2, taskStatus: "running", manifestStatus: "running" }), false);
	});
});
