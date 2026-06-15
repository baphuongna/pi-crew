import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasPendingMutatingTaskAtBoundary } from "../../src/runtime/team-runner.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "task-1",
		runId: "run-1",
		role: "executor",
		agent: "default",
		title: "Test task",
		status: "queued",
		dependsOn: [],
		cwd: "/tmp",
		...overrides,
	} as TeamTaskState;
}

describe("hasPendingMutatingTaskAtBoundary", () => {
	it("returns false when no read-only task has completed yet", () => {
		// At run start: everything queued, nothing completed.
		const tasks = [
			makeTask({ id: "explore", role: "explorer", status: "queued" }),
			makeTask({ id: "execute", role: "executor", status: "queued" }),
		];
		assert.equal(hasPendingMutatingTaskAtBoundary(tasks), false);
	});

	it("returns true at plan→execute boundary (read-only done, mutating pending)", () => {
		// After explore completes, execute is pending → boundary crossed.
		const tasks = [
			makeTask({ id: "explore", role: "explorer", status: "completed" }),
			makeTask({ id: "execute", role: "executor", status: "queued" }),
		];
		assert.equal(hasPendingMutatingTaskAtBoundary(tasks), true);
	});

	it("returns false when mutating task has already completed", () => {
		// Execute already ran → no pending mutating task.
		const tasks = [
			makeTask({ id: "explore", role: "explorer", status: "completed" }),
			makeTask({ id: "execute", role: "executor", status: "completed" }),
		];
		assert.equal(hasPendingMutatingTaskAtBoundary(tasks), false);
	});

	it("returns false with only completed read-only tasks (no pending mutating)", () => {
		const tasks = [
			makeTask({ id: "explore", role: "explorer", status: "completed" }),
			makeTask({ id: "verify", role: "verifier", status: "queued" }),
		];
		assert.equal(hasPendingMutatingTaskAtBoundary(tasks), false);
	});

	it("detects boundary for default workflow (explore+plan done, execute pending)", () => {
		// Real default workflow scenario: explore + plan (both read-only) complete,
		// execute (workspace_write) pending → boundary.
		const tasks = [
			makeTask({ id: "01_explore", role: "explorer", status: "completed" }),
			makeTask({ id: "02_plan", role: "planner", status: "completed" }),
			makeTask({ id: "03_execute", role: "executor", status: "queued" }),
			makeTask({ id: "04_verify", role: "verifier", status: "queued" }),
		];
		assert.equal(hasPendingMutatingTaskAtBoundary(tasks), true);
	});

	it("does not fire when only a mutating task completed (no read-only done)", () => {
		// Edge: a mutating task somehow completed first (shouldn't happen normally,
		// but the detector should be robust).
		const tasks = [
			makeTask({ id: "execute", role: "executor", status: "completed" }),
			makeTask({ id: "review", role: "reviewer", status: "queued" }),
		];
		// execute completed (mutating), review queued (read-only) → no pending mutating → false
		assert.equal(hasPendingMutatingTaskAtBoundary(tasks), false);
	});
});
