import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AutoResumeRuntime, TaskProgressSignal } from "../../src/runtime/loop-gates.ts";
import { computeTaskProgressSignal, shouldAutoResume } from "../../src/runtime/loop-gates.ts";
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

describe("shouldAutoResume", () => {
	it("returns true when both gates pass", () => {
		const runtime: AutoResumeRuntime = { autoResumeTurns: 0, maxTurns: 20 };
		const progress: TaskProgressSignal = {
			editedFiles: true,
			producedArtifacts: false,
			ranTests: false,
		};
		assert.equal(shouldAutoResume(runtime, progress), true);
	});

	it("returns false when no progress signals are true (Gate 1 fails)", () => {
		const runtime: AutoResumeRuntime = { autoResumeTurns: 0, maxTurns: 20 };
		const progress: TaskProgressSignal = {
			editedFiles: false,
			producedArtifacts: false,
			ranTests: false,
		};
		assert.equal(shouldAutoResume(runtime, progress), false);
	});

	it("returns false when turn limit is reached (Gate 2 fails)", () => {
		const runtime: AutoResumeRuntime = {
			autoResumeTurns: 20,
			maxTurns: 20,
		};
		const progress: TaskProgressSignal = {
			editedFiles: true,
			producedArtifacts: true,
			ranTests: true,
		};
		assert.equal(shouldAutoResume(runtime, progress), false);
	});

	it("returns true with producedArtifacts only", () => {
		const runtime: AutoResumeRuntime = { autoResumeTurns: 5, maxTurns: 20 };
		const progress: TaskProgressSignal = {
			editedFiles: false,
			producedArtifacts: true,
			ranTests: false,
		};
		assert.equal(shouldAutoResume(runtime, progress), true);
	});

	it("returns true with ranTests only", () => {
		const runtime: AutoResumeRuntime = {
			autoResumeTurns: 19,
			maxTurns: 20,
		};
		const progress: TaskProgressSignal = {
			editedFiles: false,
			producedArtifacts: false,
			ranTests: true,
		};
		assert.equal(shouldAutoResume(runtime, progress), true);
	});

	it("returns false when exactly at turn limit with progress", () => {
		const runtime: AutoResumeRuntime = {
			autoResumeTurns: 20,
			maxTurns: 20,
		};
		const progress: TaskProgressSignal = {
			editedFiles: true,
			producedArtifacts: false,
			ranTests: false,
		};
		assert.equal(shouldAutoResume(runtime, progress), false);
	});

	it("returns true when one below turn limit", () => {
		const runtime: AutoResumeRuntime = {
			autoResumeTurns: 19,
			maxTurns: 20,
		};
		const progress: TaskProgressSignal = {
			editedFiles: true,
			producedArtifacts: false,
			ranTests: false,
		};
		assert.equal(shouldAutoResume(runtime, progress), true);
	});
});

describe("computeTaskProgressSignal", () => {
	it("detects editedFiles from resultArtifact", () => {
		const task = makeTask({
			resultArtifact: {
				kind: "result",
				path: "/tmp/result.md",
				createdAt: "2026-01-01T00:00:00.000Z",
				producer: "agent",
				retention: "run",
			},
		});
		const signal = computeTaskProgressSignal(task, "/tmp/artifacts");
		assert.equal(signal.editedFiles, true);
	});

	it("editedFiles is false without result artifact", () => {
		const task = makeTask();
		const signal = computeTaskProgressSignal(task, "/tmp/artifacts");
		assert.equal(signal.editedFiles, false);
	});

	it("detects producedArtifacts from artifacts directory", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			// Create an artifact file matching the task ID
			fs.writeFileSync(path.join(dir, "task-1-result.md"), "result");
			const task = makeTask({ id: "task-1" });
			const signal = computeTaskProgressSignal(task, dir);
			assert.equal(signal.producedArtifacts, true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("producedArtifacts is false for empty directory", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const task = makeTask({ id: "task-99" });
			const signal = computeTaskProgressSignal(task, dir);
			assert.equal(signal.producedArtifacts, false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("producedArtifacts is false for non-existent directory", () => {
		const task = makeTask();
		const signal = computeTaskProgressSignal(task, "/nonexistent/path");
		assert.equal(signal.producedArtifacts, false);
	});

	it("detects ranTests from error text with test keywords", () => {
		const task = makeTask({
			error: "npm test failed: 2 tests failed",
		});
		const signal = computeTaskProgressSignal(task, "/tmp");
		assert.equal(signal.ranTests, true);
	});

	it("detects ranTests from task packet objective is no longer used", () => {
		// Note: objective is instructions, not output — removed from search text per review
		const task = makeTask({
			taskPacket: {
				objective: "Run all tests and report results",
				scope: "workspace",
				repo: "test",
				branchPolicy: "default",
				acceptanceTests: [],
				commitPolicy: "no commit",
				reportingContract: "report",
				escalationPolicy: "stop",
				constraints: [],
				expectedArtifacts: [],
				verification: {
					requiredGreenLevel: "none",
					commands: [],
					allowManualEvidence: false,
				},
			},
		});
		const signal = computeTaskProgressSignal(task, "/tmp");
		// Objective alone should NOT trigger ranTests — it's instructions, not output
		assert.equal(signal.ranTests, false);
	});

	it("detects ranTests from task diagnostics with test keywords", () => {
		const task = makeTask({
			diagnostics: {
				result: "all tests passed: 42 tests ran successfully",
			},
		});
		const signal = computeTaskProgressSignal(task, "/tmp");
		assert.equal(signal.ranTests, true);
	});

	it("detects ranTests from task result field with test keywords", () => {
		const task = makeTask({
			terminalEvidence: [
				{
					operation: "worker",
					status: "completed",
					finishedAt: "2026-01-01T00:01:00Z",
					reason: {
						code: "success",
						message: "Test suite completed: 15 passed, 0 failed",
					},
				},
			],
		});
		const signal = computeTaskProgressSignal(task, "/tmp");
		assert.equal(signal.ranTests, true);
	});

	it("ranTests is false when no test keywords present", () => {
		const task = makeTask({
			error: "Build failed: missing dependency",
		});
		const signal = computeTaskProgressSignal(task, "/tmp");
		assert.equal(signal.ranTests, false);
	});
});
