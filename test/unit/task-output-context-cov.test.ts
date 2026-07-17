import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	aggregateTaskOutputs,
	collectDependencyOutputContext,
	type DependencyOutputContext,
	renderDependencyOutputContext,
	sharedPath,
} from "../../src/runtime/task-output-context.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import type { WorkflowStep } from "../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeManifest(artifactsRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-toc-test",
		team: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: "/tmp",
		stateRoot: path.join(artifactsRoot, "..", "state"),
		artifactsRoot,
		tasksPath: "/tmp/tasks",
		eventsPath: "/tmp/events",
		artifacts: [],
	};
}

function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "task_01",
		runId: "run-toc-test",
		stepId: "step_01",
		role: "agent",
		agent: "test-agent",
		title: "Test task",
		status: "completed",
		dependsOn: [],
		cwd: "/tmp",
		...overrides,
	};
}

describe("sharedPath", () => {
	it("resolves to shared directory under artifacts root", () => {
		const tmp = createTrackedTempDir("pi-crew-toc-");
		try {
			const manifest = makeManifest(tmp);
			const p = sharedPath(manifest, "mydata.json");
			assert.ok(p.includes("shared"));
			assert.ok(p.endsWith("mydata.json"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("rejects path traversal attempts", () => {
		const tmp = createTrackedTempDir("pi-crew-toc-");
		try {
			const manifest = makeManifest(tmp);
			assert.throws(() => sharedPath(manifest, "../etc/passwd"), /Invalid/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("rejects absolute paths", () => {
		const tmp = createTrackedTempDir("pi-crew-toc-");
		try {
			const manifest = makeManifest(tmp);
			assert.throws(() => sharedPath(manifest, "/etc/passwd"), /Invalid/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("normalizes backslashes", () => {
		const tmp = createTrackedTempDir("pi-crew-toc-");
		try {
			const manifest = makeManifest(tmp);
			const p = sharedPath(manifest, "sub/file.txt");
			// Cross-platform: use path.sep or check for both / and \
			assert.ok(p.endsWith("sub/file.txt") || p.endsWith("sub\\file.txt"), `expected path to end with sub/file.txt, got: ${p}`);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("collectDependencyOutputContext", () => {
	it("returns empty dependencies when task has none", () => {
		const tmp = createTrackedTempDir("pi-crew-toc-");
		try {
			const manifest = makeManifest(tmp);
			const task = makeTask({ dependsOn: [] });
			const step: WorkflowStep = {
				id: "step_01",
				role: "agent",
				task: "do it",
			};
			const ctx = collectDependencyOutputContext(manifest, [task], task, step);
			assert.equal(ctx.dependencies.length, 0);
			assert.equal(ctx.sharedReads.length, 0);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("resolves dependencies by stepId", () => {
		const tmp = createTrackedTempDir("pi-crew-toc-");
		try {
			const manifest = makeManifest(tmp);
			const depTask = makeTask({
				id: "task_dep",
				stepId: "step_dep",
				status: "completed",
			});
			const mainTask = makeTask({
				id: "task_main",
				dependsOn: ["step_dep"],
			});
			const step: WorkflowStep = {
				id: "step_main",
				role: "agent",
				task: "do it",
			};
			const ctx = collectDependencyOutputContext(manifest, [depTask, mainTask], mainTask, step);
			assert.equal(ctx.dependencies.length, 1);
			assert.equal(ctx.dependencies[0].taskId, "task_dep");
			assert.equal(ctx.dependencies[0].status, "completed");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("includes shared reads when step.reads is specified", () => {
		const tmp = createTrackedTempDir("pi-crew-toc-");
		try {
			const manifest = makeManifest(tmp);
			// Create shared file
			const sharedDir = path.join(tmp, "shared");
			fs.mkdirSync(sharedDir, { recursive: true });
			fs.writeFileSync(path.join(sharedDir, "input.txt"), "hello world", "utf-8");

			const task = makeTask({ dependsOn: [] });
			const step: WorkflowStep = {
				id: "step_01",
				role: "agent",
				task: "do it",
				reads: ["input.txt"],
			};
			const ctx = collectDependencyOutputContext(manifest, [task], task, step);
			assert.equal(ctx.sharedReads.length, 1);
			assert.equal(ctx.sharedReads[0].name, "input.txt");
			assert.equal(ctx.sharedReads[0].content, "hello world");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("skips reads when step.reads is false", () => {
		const tmp = createTrackedTempDir("pi-crew-toc-");
		try {
			const manifest = makeManifest(tmp);
			const task = makeTask({ dependsOn: [] });
			const step: WorkflowStep = {
				id: "step_01",
				role: "agent",
				task: "do it",
				reads: false,
			};
			const ctx = collectDependencyOutputContext(manifest, [task], task, step);
			assert.equal(ctx.sharedReads.length, 0);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("renderDependencyOutputContext", () => {
	it("renders empty context as empty string", () => {
		const ctx: DependencyOutputContext = {
			dependencies: [],
			sharedReads: [],
		};
		const text = renderDependencyOutputContext(ctx);
		assert.equal(text, "");
	});

	it("renders dependency information", () => {
		const ctx: DependencyOutputContext = {
			dependencies: [
				{
					taskId: "task_01",
					role: "agent",
					status: "completed",
					resultSummary: "did the thing",
				},
			],
			sharedReads: [],
		};
		const text = renderDependencyOutputContext(ctx);
		assert.ok(text.includes("task_01"));
		assert.ok(text.includes("completed"));
		assert.ok(text.includes("did the thing"));
	});

	it("renders shared reads section", () => {
		const ctx: DependencyOutputContext = {
			dependencies: [],
			sharedReads: [
				{
					name: "data.json",
					path: "/tmp/shared/data.json",
					content: '{"key": "value"}',
				},
			],
		};
		const text = renderDependencyOutputContext(ctx);
		assert.ok(text.includes("Shared Run Context Reads"));
		assert.ok(text.includes("data.json"));
		assert.ok(text.includes('"key": "value"'));
	});

	it("renders usage information when present", () => {
		const ctx: DependencyOutputContext = {
			dependencies: [
				{
					taskId: "task_01",
					role: "agent",
					status: "completed",
					resultSummary: "done",
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						durationMs: 5000,
					},
				},
			],
			sharedReads: [],
		};
		const text = renderDependencyOutputContext(ctx);
		assert.ok(text.includes("100 input tokens"));
		assert.ok(text.includes("50 output tokens"));
		assert.ok(text.includes("5000ms"));
	});

	it("renders artifacts produced", () => {
		const ctx: DependencyOutputContext = {
			dependencies: [
				{
					taskId: "task_01",
					role: "agent",
					status: "completed",
					resultSummary: "done",
					artifactsProduced: ["result.md", "log.txt"],
				},
			],
			sharedReads: [],
		};
		const text = renderDependencyOutputContext(ctx);
		assert.ok(text.includes("result.md"));
		assert.ok(text.includes("log.txt"));
	});
});

describe("aggregateTaskOutputs", () => {
	it("handles empty tasks list", () => {
		const result = aggregateTaskOutputs([]);
		assert.equal(result, "");
	});

	it("formats a single completed task", () => {
		const tasks = [makeTask({ status: "completed" })];
		const result = aggregateTaskOutputs(tasks);
		assert.ok(result.includes("task_01"));
		assert.ok(result.includes("EMPTY OUTPUT"));
	});

	it("formats a failed task with error", () => {
		const tasks = [makeTask({ status: "failed", error: "something broke" })];
		const result = aggregateTaskOutputs(tasks);
		assert.ok(result.includes("FAILED"));
		assert.ok(result.includes("something broke"));
	});

	it("formats a skipped task", () => {
		const tasks = [makeTask({ status: "skipped" })];
		const result = aggregateTaskOutputs(tasks);
		assert.ok(result.includes("SKIPPED"));
	});

	it("includes usage when present", () => {
		const tasks = [
			makeTask({
				status: "completed",
				usage: { input: 100, output: 50 },
			}),
		];
		const result = aggregateTaskOutputs(tasks);
		assert.ok(result.includes("Usage"));
	});
});
