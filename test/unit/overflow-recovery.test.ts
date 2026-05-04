import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OverflowRecoveryTracker } from "../../src/runtime/overflow-recovery.ts";

describe("OverflowRecoveryTracker", () => {
	it("starts in none phase", () => {
		const tracker = new OverflowRecoveryTracker();
		assert.equal(tracker.getPhase("task-1"), "none");
		assert.equal(tracker.getState("task-1"), undefined);
		tracker.dispose();
	});

	it("transitions to compaction on compaction_start", () => {
		const phases: string[] = [];
		const tracker = new OverflowRecoveryTracker({
			onPhaseChange: (state, prev) => { phases.push(`${prev}->${state.phase}`); },
		});
		const phase = tracker.feedEvent("task-1", "run-1", "compaction_start");
		assert.equal(phase, "compaction");
		assert.equal(tracker.getPhase("task-1"), "compaction");
		const state = tracker.getState("task-1");
		assert.ok(state);
		assert.equal(state.compactionCount, 1);
		assert.equal(phases.length, 1);
		assert.equal(phases[0], "none->compaction");
		tracker.dispose();
	});

	it("transitions compaction -> retrying -> recovered", () => {
		const phases: string[] = [];
		const tracker = new OverflowRecoveryTracker({
			onPhaseChange: (state, prev) => { phases.push(`${prev}->${state.phase}`); },
		});
		tracker.feedEvent("task-1", "run-1", "compaction_start");
		assert.equal(tracker.getPhase("task-1"), "compaction");

		tracker.feedEvent("task-1", "run-1", "compaction_end");
		assert.equal(tracker.getPhase("task-1"), "compaction"); // stays compaction

		tracker.feedEvent("task-1", "run-1", "auto_retry_start");
		assert.equal(tracker.getPhase("task-1"), "retrying");

		tracker.feedEvent("task-1", "run-1", "auto_retry_end");
		assert.equal(tracker.getPhase("task-1"), "recovered");

		assert.deepEqual(phases, ["none->compaction", "compaction->retrying", "retrying->recovered"]);
		tracker.dispose();
	});

	it("transitions to failed on agent_end during compaction", () => {
		const tracker = new OverflowRecoveryTracker();
		tracker.feedEvent("task-1", "run-1", "compaction_start");
		const phase = tracker.feedEvent("task-1", "run-1", "agent_end");
		assert.equal(phase, "failed");
		assert.equal(tracker.getPhase("task-1"), "failed");
		tracker.dispose();
	});

	it("stays recovered once recovered", () => {
		const tracker = new OverflowRecoveryTracker();
		tracker.feedEvent("task-1", "run-1", "compaction_start");
		tracker.feedEvent("task-1", "run-1", "auto_retry_start");
		tracker.feedEvent("task-1", "run-1", "auto_retry_end");
		assert.equal(tracker.getPhase("task-1"), "recovered");
		// Feed more events — should stay recovered
		tracker.feedEvent("task-1", "run-1", "compaction_start");
		assert.equal(tracker.getPhase("task-1"), "recovered");
		tracker.dispose();
	});

	it("stays failed once failed", () => {
		const tracker = new OverflowRecoveryTracker();
		tracker.feedEvent("task-1", "run-1", "compaction_start");
		tracker.feedEvent("task-1", "run-1", "agent_end");
		assert.equal(tracker.getPhase("task-1"), "failed");
		tracker.feedEvent("task-1", "run-1", "auto_retry_start");
		assert.equal(tracker.getPhase("task-1"), "failed");
		tracker.dispose();
	});

	it("increments compaction and retry counts", () => {
		const tracker = new OverflowRecoveryTracker();
		// First overflow cycle
		tracker.feedEvent("task-1", "run-1", "compaction_start");
		tracker.feedEvent("task-1", "run-1", "auto_retry_start");
		let state = tracker.getState("task-1");
		assert.equal(state?.compactionCount, 1);
		assert.equal(state?.retryCount, 1);

		// Mark recovered
		tracker.feedEvent("task-1", "run-1", "auto_retry_end");
		assert.equal(tracker.getPhase("task-1"), "recovered");
		tracker.dispose();
	});

	it("removeTask cleans up", () => {
		const tracker = new OverflowRecoveryTracker();
		tracker.feedEvent("task-1", "run-1", "compaction_start");
		assert.ok(tracker.getState("task-1"));
		tracker.removeTask("task-1");
		assert.equal(tracker.getState("task-1"), undefined);
		assert.equal(tracker.getPhase("task-1"), "none");
		tracker.dispose();
	});

	it("dispose clears all state", () => {
		const tracker = new OverflowRecoveryTracker();
		tracker.feedEvent("task-1", "run-1", "compaction_start");
		tracker.feedEvent("task-2", "run-1", "compaction_start");
		tracker.dispose();
		assert.equal(tracker.getPhase("task-1"), "none");
		assert.equal(tracker.getPhase("task-2"), "none");
	});

	it("unknown events do not change phase", () => {
		const tracker = new OverflowRecoveryTracker();
		const phase = tracker.feedEvent("task-1", "run-1", "tool_call");
		assert.equal(phase, "none");
		tracker.dispose();
	});
});