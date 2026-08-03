import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTaskGraphLines, shouldMaterializeAgent, taskById, waitingReason } from "../../../../src/runtime/task-display.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";

function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: overrides.id ?? "task_1",
		runId: overrides.runId ?? "run_1",
		role: overrides.role ?? "executor",
		agent: overrides.agent ?? "test-agent",
		title: overrides.title ?? "Test task",
		status: overrides.status ?? "queued",
		dependsOn: overrides.dependsOn ?? [],
		cwd: overrides.cwd ?? "/tmp",
		...overrides,
	};
}

describe("task-display", () => {
	describe("shouldMaterializeAgent", () => {
		it("returns true for running tasks", () => {
			assert.equal(shouldMaterializeAgent(makeTask({ status: "running" })), true);
		});

		it("returns true for completed tasks", () => {
			assert.equal(shouldMaterializeAgent(makeTask({ status: "completed" })), true);
		});

		it("returns false for queued tasks", () => {
			assert.equal(shouldMaterializeAgent(makeTask({ status: "queued" })), false);
		});

		it("returns false for skipped tasks", () => {
			assert.equal(shouldMaterializeAgent(makeTask({ status: "skipped" })), false);
		});

		it("returns true for failed tasks", () => {
			assert.equal(shouldMaterializeAgent(makeTask({ status: "failed" })), true);
		});
	});

	describe("taskById", () => {
		it("maps tasks by id", () => {
			const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
			const map = taskById(tasks);
			assert.ok(map.has("a"));
			assert.ok(map.has("b"));
		});

		it("maps tasks by stepId when present", () => {
			const tasks = [makeTask({ id: "a", stepId: "step_a" })];
			const map = taskById(tasks);
			assert.ok(map.has("step_a"));
			assert.equal(map.get("step_a"), map.get("a"));
		});

		it("returns empty map for empty array", () => {
			assert.equal(taskById([]).size, 0);
		});
	});

	describe("waitingReason", () => {
		it("returns undefined for non-queued tasks", () => {
			assert.equal(waitingReason(makeTask({ status: "running" }), []), undefined);
		});

		it("returns 'ready' for queued task with no dependencies", () => {
			assert.equal(waitingReason(makeTask({ status: "queued", dependsOn: [] }), []), "ready");
		});

		it("returns 'waiting for ...' for incomplete dependencies", () => {
			const tasks = [makeTask({ id: "a", status: "queued", dependsOn: ["b"] }), makeTask({ id: "b", status: "running" })];
			const reason = waitingReason(tasks[0], tasks);
			assert.ok(reason);
			assert.ok(reason!.includes("b"));
		});

		it("returns 'ready' when all dependencies are completed", () => {
			const tasks = [makeTask({ id: "a", status: "queued", dependsOn: ["b"] }), makeTask({ id: "b", status: "completed" })];
			assert.equal(waitingReason(tasks[0], tasks), "ready");
		});

		it("handles missing dependencies gracefully", () => {
			const tasks = [makeTask({ id: "a", status: "queued", dependsOn: ["missing"] })];
			const reason = waitingReason(tasks[0], tasks);
			assert.ok(reason!.includes("missing"));
		});
	});

	describe("formatTaskGraphLines", () => {
		it("returns '(none)' for empty task list", () => {
			const lines = formatTaskGraphLines([]);
			assert.equal(lines.length, 1);
			assert.ok(lines[0].includes("none"));
		});

		it("formats completed task with checkmark", () => {
			const lines = formatTaskGraphLines([makeTask({ id: "t1", status: "completed" })]);
			assert.ok(lines[0].includes("✓"));
			assert.ok(lines[0].includes("completed"));
		});

		it("formats running task with spinner", () => {
			const lines = formatTaskGraphLines([makeTask({ id: "t1", status: "running" })]);
			assert.ok(lines[0].includes("⠋"));
		});

		it("formats failed task with X", () => {
			const lines = formatTaskGraphLines([makeTask({ id: "t1", status: "failed" })]);
			assert.ok(lines[0].includes("✗"));
		});

		it("formats skipped task with block", () => {
			const lines = formatTaskGraphLines([makeTask({ id: "t1", status: "skipped" })]);
			assert.ok(lines[0].includes("■"));
		});

		it("formats needs_attention task with warning", () => {
			const lines = formatTaskGraphLines([makeTask({ id: "t1", status: "needs_attention" })]);
			assert.ok(lines[0].includes("⚠"));
		});

		it("includes role and agent in output", () => {
			const lines = formatTaskGraphLines([
				makeTask({
					id: "t1",
					role: "planner",
					agent: "gpt",
					status: "running",
				}),
			]);
			assert.ok(lines[0].includes("planner"));
			assert.ok(lines[0].includes("gpt"));
		});

		it("includes waiting reason when not ready", () => {
			const tasks = [makeTask({ id: "t1", status: "queued", dependsOn: ["t2"] }), makeTask({ id: "t2", status: "running" })];
			const lines = formatTaskGraphLines(tasks);
			assert.ok(lines[0].includes("waiting for"));
		});
	});
});
