import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TaskQualityScore } from "../../src/runtime/task-quality.ts";
import { computeTaskQuality, formatQualityScore } from "../../src/runtime/task-quality.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

/** Helper to create a minimal TeamTaskState. */
function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: overrides.id ?? "task-1",
		runId: overrides.runId ?? "run-1",
		role: overrides.role ?? "agent",
		agent: overrides.agent ?? "default",
		title: overrides.title ?? "Test task",
		status: overrides.status ?? "completed",
		dependsOn: overrides.dependsOn ?? [],
		cwd: overrides.cwd ?? "/tmp",
		...overrides,
	} as TeamTaskState;
}

describe("computeTaskQuality", () => {
	it("scores A (5/5) when all criteria are met", () => {
		const now = new Date();
		const started = new Date(now.getTime() - 30_000).toISOString(); // 30 seconds ago
		const finished = now.toISOString();

		const task = makeTask({
			diagnostics: { errors: 0, warnings: 2 },
			metrics: { files_changed: 5, tests_passed: 12 },
			startedAt: started,
			finishedAt: finished,
			error: "Task completed successfully with all changes applied",
		});

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-quality-"));
		try {
			// Create artifact files for the task
			fs.mkdirSync(path.join(dir, "task-1"));
			fs.writeFileSync(path.join(dir, "task-1", "result.md"), "done");

			const score = computeTaskQuality(task, dir);

			assert.equal(score.score, 5);
			assert.equal(score.grade, "A");
			assert.equal(score.breakdown.hasDiagnostics, true);
			assert.equal(score.breakdown.hasMetrics, true);
			assert.equal(score.breakdown.producedArtifacts, true);
			assert.equal(score.breakdown.hasDescription, true);
			assert.equal(score.breakdown.durationReasonable, true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scores B (3/5) when diagnostics are missing", () => {
		const now = new Date();
		const started = new Date(now.getTime() - 30_000).toISOString();
		const finished = now.toISOString();

		const task = makeTask({
			// No diagnostics
			metrics: { tests_passed: 5 },
			startedAt: started,
			finishedAt: finished,
			error: "Task completed with results",
		});

		// No artifactsDir provided → producedArtifacts = false
		const score = computeTaskQuality(task);

		assert.equal(score.score, 3);
		assert.equal(score.grade, "B");
		assert.equal(score.breakdown.hasDiagnostics, false);
		assert.equal(score.breakdown.hasMetrics, true);
		assert.equal(score.breakdown.producedArtifacts, false);
		assert.equal(score.breakdown.hasDescription, true);
		assert.equal(score.breakdown.durationReasonable, true);
	});

	it("scores D (1/5) with only description", () => {
		const task = makeTask({
			// No diagnostics, no metrics, no timestamps
			resultArtifact: {
				kind: "result",
				path: "/some/result.md",
				createdAt: new Date().toISOString(),
				producer: "test",
				retention: "run",
			},
		});

		const score = computeTaskQuality(task);

		assert.equal(score.score, 1);
		assert.equal(score.grade, "D");
		assert.equal(score.breakdown.hasDiagnostics, false);
		assert.equal(score.breakdown.hasMetrics, false);
		assert.equal(score.breakdown.producedArtifacts, false);
		assert.equal(score.breakdown.hasDescription, true);
		assert.equal(score.breakdown.durationReasonable, false);
	});

	it("scores D (0/5) with zero criteria met", () => {
		const task = makeTask({
			// Nothing set — all criteria should fail
		});

		const score = computeTaskQuality(task);

		assert.equal(score.score, 0);
		assert.equal(score.grade, "D");
		assert.equal(score.breakdown.hasDiagnostics, false);
		assert.equal(score.breakdown.hasMetrics, false);
		assert.equal(score.breakdown.producedArtifacts, false);
		assert.equal(score.breakdown.hasDescription, false);
		assert.equal(score.breakdown.durationReasonable, false);
	});

	it("deducts for duration > 1 hour", () => {
		const now = new Date();
		const started = new Date(now.getTime() - 3_600_000 - 1000).toISOString(); // > 1 hour ago
		const finished = now.toISOString();

		const task = makeTask({
			diagnostics: { info: "done" },
			metrics: { count: 1 },
			startedAt: started,
			finishedAt: finished,
			error: "Task finished",
		});

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-quality-"));
		try {
			fs.mkdirSync(path.join(dir, "task-1"));
			fs.writeFileSync(path.join(dir, "task-1", "r.txt"), "x");

			const score = computeTaskQuality(task, dir);

			assert.equal(score.score, 4);
			assert.equal(score.grade, "A");
			assert.equal(score.breakdown.durationReasonable, false);
			// Still A because 4/5 meets the A threshold
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deducts for duration > 1 hour dropping to B", () => {
		const now = new Date();
		const started = new Date(now.getTime() - 3_600_000 - 1000).toISOString();
		const finished = now.toISOString();

		const task = makeTask({
			diagnostics: { info: "done" },
			metrics: { count: 1 },
			// No artifactsDir provided → producedArtifacts = false
			startedAt: started,
			finishedAt: finished,
			error: "Task finished",
		});

		const score = computeTaskQuality(task);

		assert.equal(score.score, 3);
		assert.equal(score.grade, "B");
		assert.equal(score.breakdown.durationReasonable, false);
		assert.equal(score.breakdown.producedArtifacts, false);
	});

	it("treats empty diagnostics as not meeting criteria", () => {
		const task = makeTask({
			diagnostics: {},
		});

		const score = computeTaskQuality(task);
		assert.equal(score.breakdown.hasDiagnostics, false);
	});

	it("treats empty metrics as not meeting criteria", () => {
		const task = makeTask({
			metrics: {},
		});

		const score = computeTaskQuality(task);
		assert.equal(score.breakdown.hasMetrics, false);
	});

	it("returns producedArtifacts=false when artifactsDir is not provided", () => {
		const task = makeTask();
		const score = computeTaskQuality(task);
		assert.equal(score.breakdown.producedArtifacts, false);
	});

	it("returns producedArtifacts=false when artifactsDir doesn't exist", () => {
		const task = makeTask();
		const score = computeTaskQuality(task, "/nonexistent/path");
		assert.equal(score.breakdown.producedArtifacts, false);
	});

	it("returns durationReasonable=false when only startedAt is set", () => {
		const task = makeTask({
			startedAt: new Date().toISOString(),
		});

		const score = computeTaskQuality(task);
		assert.equal(score.breakdown.durationReasonable, false);
	});
});

describe("formatQualityScore", () => {
	it("formats a perfect score", () => {
		const score: TaskQualityScore = {
			score: 5,
			grade: "A",
			breakdown: {
				hasDiagnostics: true,
				hasMetrics: true,
				producedArtifacts: true,
				hasDescription: true,
				durationReasonable: true,
			},
		};
		const formatted = formatQualityScore(score);
		assert.equal(formatted, "Quality: A (5/5: diagnostics, metrics, artifacts, description, duration)");
	});

	it("formats a partial score with specific criteria", () => {
		const score: TaskQualityScore = {
			score: 2,
			grade: "C",
			breakdown: {
				hasDiagnostics: false,
				hasMetrics: true,
				producedArtifacts: false,
				hasDescription: true,
				durationReasonable: false,
			},
		};
		const formatted = formatQualityScore(score);
		assert.equal(formatted, "Quality: C (2/5: metrics, description)");
	});

	it("formats a zero score", () => {
		const score: TaskQualityScore = {
			score: 0,
			grade: "D",
			breakdown: {
				hasDiagnostics: false,
				hasMetrics: false,
				producedArtifacts: false,
				hasDescription: false,
				durationReasonable: false,
			},
		};
		const formatted = formatQualityScore(score);
		assert.equal(formatted, "Quality: D (0/5)");
	});

	it("formats a B grade", () => {
		const score: TaskQualityScore = {
			score: 3,
			grade: "B",
			breakdown: {
				hasDiagnostics: true,
				hasMetrics: true,
				producedArtifacts: false,
				hasDescription: false,
				durationReasonable: true,
			},
		};
		const formatted = formatQualityScore(score);
		assert.equal(formatted, "Quality: B (3/5: diagnostics, metrics, duration)");
	});
});
