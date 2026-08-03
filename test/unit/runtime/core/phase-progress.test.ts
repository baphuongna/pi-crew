import assert from "node:assert/strict";
import test from "node:test";
import { computePhaseProgress, formatPhaseProgressLine } from "../../../../src/runtime/phase-progress.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TeamTaskState> & { id: string }): TeamTaskState {
	return {
		runId: "run-1",
		role: "agent",
		agent: "executor",
		title: "test task",
		status: "queued",
		dependsOn: [],
		cwd: "/tmp",
		...overrides,
	};
}

function adaptiveTask(id: string, phase: string, status: TeamTaskState["status"], startedAt?: string, finishedAt?: string): TeamTaskState {
	return makeTask({
		id,
		status,
		stepId: `adaptive-${phase}-1-executor`,
		adaptive: { phase, task: "do work" },
		startedAt,
		finishedAt,
	});
}

// ---------------------------------------------------------------------------
// Tests: phase grouping
// ---------------------------------------------------------------------------

test("computePhaseProgress groups tasks by adaptive.phase", () => {
	const tasks = [
		adaptiveTask("t1", "explore", "completed"),
		adaptiveTask("t2", "explore", "completed"),
		adaptiveTask("t3", "execute", "running"),
		adaptiveTask("t4", "execute", "queued"),
	];

	const result = computePhaseProgress(tasks);
	assert.equal(result.phases.length, 2);
	assert.equal(result.phases[0]!.phase, "explore");
	assert.equal(result.phases[1]!.phase, "execute");
	assert.equal(result.phases[0]!.total, 2);
	assert.equal(result.phases[1]!.total, 2);
});

test("computePhaseProgress infers phase from stepId when adaptive.phase is absent", () => {
	const tasks = [
		makeTask({
			id: "t1",
			stepId: "adaptive-1-1-explorer",
			status: "completed",
		}),
		makeTask({
			id: "t2",
			stepId: "adaptive-2-1-executor",
			status: "running",
		}),
	];

	const result = computePhaseProgress(tasks);
	assert.equal(result.phases.length, 2);
	assert.equal(result.phases[0]!.phase, "1");
	assert.equal(result.phases[1]!.phase, "2");
});

test("computePhaseProgress uses 'default' for tasks without phase info", () => {
	const tasks = [makeTask({ id: "t1", status: "completed" }), makeTask({ id: "t2", status: "running" })];

	const result = computePhaseProgress(tasks);
	assert.equal(result.phases.length, 1);
	assert.equal(result.phases[0]!.phase, "default");
});

// ---------------------------------------------------------------------------
// Tests: percentage calculation
// ---------------------------------------------------------------------------

test("computePhaseProgress calculates percentage per phase", () => {
	const tasks = [
		adaptiveTask("t1", "explore", "completed"),
		adaptiveTask("t2", "explore", "failed"),
		adaptiveTask("t3", "explore", "running"),
	];

	const result = computePhaseProgress(tasks);
	const explore = result.phases[0]!;
	assert.equal(explore.percentage, 66.7); // 2/3 * 100 = 66.666 → rounded to 66.7
});

test("computePhaseProgress calculates overallPercentage", () => {
	const tasks = [
		adaptiveTask("t1", "explore", "completed"),
		adaptiveTask("t2", "explore", "completed"),
		adaptiveTask("t3", "execute", "running"),
		adaptiveTask("t4", "verify", "queued"),
	];

	const result = computePhaseProgress(tasks);
	// 2 completed out of 4 total = 50%
	assert.equal(result.overallPercentage, 50);
});

test("computePhaseProgress counts failed as terminal for percentage", () => {
	const tasks = [adaptiveTask("t1", "explore", "failed"), adaptiveTask("t2", "explore", "completed")];

	const result = computePhaseProgress(tasks);
	assert.equal(result.phases[0]!.percentage, 100);
	assert.equal(result.overallPercentage, 100);
});

// ---------------------------------------------------------------------------
// Tests: empty / running / completed states
// ---------------------------------------------------------------------------

test("computePhaseProgress handles empty task list", () => {
	const result = computePhaseProgress([]);
	assert.equal(result.phases.length, 0);
	assert.equal(result.overallPercentage, 0);
	assert.equal(result.currentPhase, null);
	assert.equal(result.estimatedRemainingMs, 0);
	assert.equal(result.totalTasks, 0);
	assert.equal(result.completedTasks, 0);
});

test("computePhaseProgress identifies currentPhase as phase with running tasks", () => {
	const tasks = [
		adaptiveTask("t1", "explore", "completed"),
		adaptiveTask("t2", "execute", "running"),
		adaptiveTask("t3", "verify", "queued"),
	];

	const result = computePhaseProgress(tasks);
	assert.equal(result.currentPhase, "execute");
});

test("computePhaseProgress identifies currentPhase as phase with queued tasks (no running)", () => {
	const tasks = [adaptiveTask("t1", "explore", "completed"), adaptiveTask("t2", "execute", "queued")];

	const result = computePhaseProgress(tasks);
	assert.equal(result.currentPhase, "execute");
});

test("computePhaseProgress returns null currentPhase when all done", () => {
	const tasks = [adaptiveTask("t1", "explore", "completed"), adaptiveTask("t2", "execute", "completed")];

	const result = computePhaseProgress(tasks);
	assert.equal(result.currentPhase, null);
});

test("computePhaseProgress counts task statuses correctly", () => {
	const tasks = [
		adaptiveTask("t1", "explore", "completed"),
		adaptiveTask("t2", "explore", "failed"),
		adaptiveTask("t3", "explore", "running"),
		adaptiveTask("t4", "explore", "queued"),
		adaptiveTask("t5", "explore", "waiting"),
		adaptiveTask("t6", "explore", "cancelled"),
		adaptiveTask("t7", "explore", "skipped"),
	];

	const result = computePhaseProgress(tasks);
	const phase = result.phases[0]!;
	assert.equal(phase.total, 7);
	assert.equal(phase.completed, 1);
	assert.equal(phase.failed, 1);
	assert.equal(phase.running, 2); // running + waiting
	assert.equal(phase.queued, 1);
	assert.equal(result.completedTasks, 1);
});

// ---------------------------------------------------------------------------
// Tests: estimated time remaining
// ---------------------------------------------------------------------------

test("computePhaseProgress estimates remaining time from avg task duration", () => {
	const now = Date.now();
	const tasks = [
		adaptiveTask("t1", "explore", "completed", new Date(now - 60_000).toISOString(), new Date(now).toISOString()), // 60s
		adaptiveTask("t2", "explore", "completed", new Date(now - 120_000).toISOString(), new Date(now - 30_000).toISOString()), // 90s
		adaptiveTask("t3", "execute", "queued"),
		adaptiveTask("t4", "execute", "queued"),
	];

	const result = computePhaseProgress(tasks);
	// avg = (60000 + 90000) / 2 = 75000ms, remaining = 2 → 150000ms
	assert.equal(result.estimatedRemainingMs, 150_000);
});

test("computePhaseProgress returns 0 estimated time when no completed tasks", () => {
	const tasks = [adaptiveTask("t1", "explore", "running"), adaptiveTask("t2", "execute", "queued")];

	const result = computePhaseProgress(tasks);
	assert.equal(result.estimatedRemainingMs, 0);
});

test("computePhaseProgress returns 0 estimated time when all tasks are terminal", () => {
	const now = Date.now();
	const tasks = [adaptiveTask("t1", "explore", "completed", new Date(now - 60_000).toISOString(), new Date(now).toISOString())];

	const result = computePhaseProgress(tasks);
	assert.equal(result.estimatedRemainingMs, 0);
});

// ---------------------------------------------------------------------------
// Tests: formatPhaseProgressLine
// ---------------------------------------------------------------------------

test("formatPhaseProgressLine returns empty string for no phases", () => {
	const result = computePhaseProgress([]);
	assert.equal(formatPhaseProgressLine(result), "");
});

test("formatPhaseProgressLine shows current phase info", () => {
	const tasks = [
		adaptiveTask("t1", "explore", "completed"),
		adaptiveTask("t2", "execute", "running"),
		adaptiveTask("t3", "execute", "queued"),
		adaptiveTask("t4", "verify", "queued"),
	];

	const result = computePhaseProgress(tasks);
	const line = formatPhaseProgressLine(result);
	assert.ok(line.includes("Phase 2/3"));
	assert.ok(line.includes("execute"));
	assert.ok(line.includes("0%"));
});

test("formatPhaseProgressLine shows all done when currentPhase is null", () => {
	const tasks = [adaptiveTask("t1", "explore", "completed"), adaptiveTask("t2", "execute", "completed")];

	const result = computePhaseProgress(tasks);
	const line = formatPhaseProgressLine(result);
	assert.ok(line.includes("All 2 phases done"));
	assert.ok(line.includes("100%"));
});
