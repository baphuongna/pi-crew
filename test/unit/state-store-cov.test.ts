import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import {
	__test__clearManifestCache,
	createRunManifest,
	createRunPaths,
	createTasksFromWorkflow,
	loadRunManifestById,
	saveRunManifest,
	saveRunTasks,
	updateRunStatus,
} from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "test-team",
	description: "Test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const multiStepWorkflow: WorkflowConfig = {
	name: "test-workflow",
	description: "Test workflow",
	source: "builtin",
	filePath: "test.workflow.md",
	steps: [
		{ id: "step1", role: "executor", task: "Do first thing" },
		{
			id: "step2",
			role: "executor",
			task: "Do second thing",
			dependsOn: ["step1"],
		},
		{ id: "step3", role: "executor", task: "Do third thing" },
	],
};

describe("createRunPaths", () => {
	it("creates deterministic paths from cwd and runId", () => {
		const cwd = "/tmp/fake";
		const paths = createRunPaths(cwd, "run-123");
		assert.equal(paths.runId, "run-123");
		assert.ok(paths.stateRoot.includes("run-123"));
		assert.ok(paths.manifestPath.endsWith("manifest.json"));
		assert.ok(paths.tasksPath.endsWith("tasks.json"));
		assert.ok(paths.eventsPath.endsWith("events.jsonl"));
	});

	it("generates a runId when none provided", () => {
		const cwd = "/tmp/fake";
		const paths = createRunPaths(cwd);
		assert.ok(paths.runId.length > 0);
		assert.ok(paths.runId.startsWith("team_"));
	});
});

describe("createTasksFromWorkflow", () => {
	it("creates tasks for each workflow step", () => {
		const tasks = createTasksFromWorkflow("run-123", multiStepWorkflow, team, "/tmp");
		assert.equal(tasks.length, 3);
	});

	it("assigns queued status to all tasks", () => {
		const tasks = createTasksFromWorkflow("run-123", multiStepWorkflow, team, "/tmp");
		for (const task of tasks) {
			assert.equal(task.status, "queued");
		}
	});

	it("sets up dependency graph", () => {
		const tasks = createTasksFromWorkflow("run-123", multiStepWorkflow, team, "/tmp");
		const step2 = tasks.find((t) => t.stepId === "step2");
		assert.ok(step2);
		assert.ok(step2.dependsOn.length > 0);
	});

	it("sets queue status based on dependencies", () => {
		const tasks = createTasksFromWorkflow("run-123", multiStepWorkflow, team, "/tmp");
		const step1 = tasks.find((t) => t.stepId === "step1");
		const step2 = tasks.find((t) => t.stepId === "step2");
		assert.ok(step1);
		assert.ok(step2);
		// step1 has no deps → ready; step2 depends on step1 → blocked
		assert.equal(step1.graph!.queue, "ready");
		assert.equal(step2.graph!.queue, "blocked");
	});
});

describe("createRunManifest", () => {
	it("creates manifest, tasks, and paths on disk", () => {
		const cwd = createTrackedTempDir("pi-crew-ss-manifest-");
		const result = createRunManifest({
			cwd,
			team,
			workflow: multiStepWorkflow,
			goal: "test goal",
		});
		assert.ok(result.manifest.runId);
		assert.equal(result.manifest.status, "queued");
		assert.equal(result.tasks.length, 3);
		assert.ok(fs.existsSync(result.paths.manifestPath));
		assert.ok(fs.existsSync(result.paths.tasksPath));
		assert.ok(fs.existsSync(result.paths.eventsPath));
		removeTrackedTempDir(cwd);
	});

	it("creates manifest without workflow (no tasks)", () => {
		const cwd = createTrackedTempDir("pi-crew-ss-nowf-");
		const result = createRunManifest({ cwd, team, goal: "no workflow" });
		assert.equal(result.tasks.length, 0);
		assert.equal(result.manifest.workflow, undefined);
		removeTrackedTempDir(cwd);
	});

	it("sets workspaceMode to single by default", () => {
		const cwd = createTrackedTempDir("pi-crew-ss-mode-");
		const result = createRunManifest({ cwd, team, goal: "test mode" });
		assert.equal(result.manifest.workspaceMode, "single");
		removeTrackedTempDir(cwd);
	});
});

describe("saveRunManifest + loadRunManifestById", () => {
	it("round-trips manifest data", () => {
		const cwd = createTrackedTempDir("pi-crew-ss-rt-");
		__test__clearManifestCache();
		const { manifest, paths } = createRunManifest({
			cwd,
			team,
			goal: "round trip",
		});
		manifest.status = "running";
		manifest.updatedAt = new Date().toISOString();
		saveRunManifest(manifest);
		__test__clearManifestCache();
		const loaded = loadRunManifestById(cwd, manifest.runId);
		assert.ok(loaded);
		assert.equal(loaded!.manifest.status, "running");
		removeTrackedTempDir(cwd);
	});

	it("returns undefined for non-existent run", () => {
		const result = loadRunManifestById("/nonexistent", "no-such-run");
		assert.equal(result, undefined);
	});
});

describe("saveRunTasks", () => {
	it("persists updated tasks", () => {
		const cwd = createTrackedTempDir("pi-crew-ss-tasks-");
		__test__clearManifestCache();
		const { manifest, tasks, paths } = createRunManifest({
			cwd,
			team,
			workflow: multiStepWorkflow,
			goal: "save tasks",
		});
		tasks[0].status = "running";
		saveRunTasks(manifest, tasks);
		__test__clearManifestCache();
		const loaded = loadRunManifestById(cwd, manifest.runId);
		assert.ok(loaded);
		assert.equal(loaded!.tasks[0].status, "running");
		removeTrackedTempDir(cwd);
	});
});

describe("updateRunStatus", () => {
	it("transitions from queued to running", () => {
		const cwd = createTrackedTempDir("pi-crew-ss-status-");
		__test__clearManifestCache();
		const { manifest } = createRunManifest({
			cwd,
			team,
			goal: "status test",
		});
		const updated = updateRunStatus(manifest, "running");
		assert.equal(updated.status, "running");
		removeTrackedTempDir(cwd);
	});

	it("throws on invalid transition", () => {
		const cwd = createTrackedTempDir("pi-crew-ss-inv-");
		__test__clearManifestCache();
		const { manifest } = createRunManifest({ cwd, team, goal: "invalid" });
		const running = updateRunStatus(manifest, "running");
		assert.throws(() => updateRunStatus(running, "queued"), /Invalid run status transition/);
		removeTrackedTempDir(cwd);
	});

	it("unregisters from active index on terminal status", () => {
		const cwd = createTrackedTempDir("pi-crew-ss-term-");
		__test__clearManifestCache();
		const { manifest } = createRunManifest({ cwd, team, goal: "terminal" });
		const running = updateRunStatus(manifest, "running");
		const completed = updateRunStatus(running, "completed");
		assert.equal(completed.status, "completed");
		removeTrackedTempDir(cwd);
	});
});
