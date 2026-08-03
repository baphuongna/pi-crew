import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { crewHooks } from "../../../src/runtime/crew-hooks.ts";
import { getHookStats, resetHookStats } from "../../../src/state/hook-integrations.ts";

describe("getHookStats", () => {
	beforeEach(() => {
		resetHookStats();
	});

	it("returns all zeros after reset", () => {
		const stats = getHookStats();
		assert.equal(stats.tasksCompleted, 0);
		assert.equal(stats.tasksFailed, 0);
		assert.equal(stats.runsCompleted, 0);
		assert.equal(stats.runsFailed, 0);
	});

	it("returns all fields with correct types", () => {
		const stats = getHookStats();
		assert.equal(typeof stats.tasksCompleted, "number");
		assert.equal(typeof stats.tasksFailed, "number");
		assert.equal(typeof stats.runsCompleted, "number");
		assert.equal(typeof stats.runsFailed, "number");
	});
});

describe("resetHookStats", () => {
	it("resets all counters to zero", () => {
		// Reset first to ensure clean state
		resetHookStats();
		const stats = getHookStats();
		assert.equal(stats.tasksCompleted, 0);
		assert.equal(stats.tasksFailed, 0);
		assert.equal(stats.runsCompleted, 0);
		assert.equal(stats.runsFailed, 0);
	});
});

describe("hook-integrations event subscriptions", () => {
	beforeEach(() => {
		resetHookStats();
	});

	it("increments tasksCompleted on task_completed event", () => {
		crewHooks.emit({
			type: "task_completed",
			timestamp: new Date().toISOString(),
			runId: "run-1",
		});
		const stats = getHookStats();
		assert.equal(stats.tasksCompleted, 1);
	});

	it("increments tasksFailed on task_failed event", () => {
		crewHooks.emit({
			type: "task_failed",
			timestamp: new Date().toISOString(),
			runId: "run-1",
		});
		const stats = getHookStats();
		assert.equal(stats.tasksFailed, 1);
	});

	it("increments runsCompleted on run_completed event", () => {
		crewHooks.emit({
			type: "run_completed",
			timestamp: new Date().toISOString(),
			runId: "run-1",
		});
		const stats = getHookStats();
		assert.equal(stats.runsCompleted, 1);
	});

	it("increments runsFailed on run_failed event", () => {
		crewHooks.emit({
			type: "run_failed",
			timestamp: new Date().toISOString(),
			runId: "run-1",
		});
		const stats = getHookStats();
		assert.equal(stats.runsFailed, 1);
	});

	it("accumulates multiple events", () => {
		crewHooks.emit({
			type: "task_completed",
			timestamp: new Date().toISOString(),
			runId: "run-1",
		});
		crewHooks.emit({
			type: "task_completed",
			timestamp: new Date().toISOString(),
			runId: "run-1",
		});
		crewHooks.emit({
			type: "run_failed",
			timestamp: new Date().toISOString(),
			runId: "run-1",
		});
		const stats = getHookStats();
		assert.equal(stats.tasksCompleted, 2);
		assert.equal(stats.runsFailed, 1);
	});
});
