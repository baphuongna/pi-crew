import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTaskExplainContext, formatTaskExplain, type TaskExplainContext } from "../../src/extension/team-tool/explain.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

function makeManifest(overrides?: Partial<TeamRunManifest>): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "test-run",
		team: "test-team",
		goal: "test goal",
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T01:00:00.000Z",
		cwd: "/tmp",
		stateRoot: "/tmp/state",
		artifactsRoot: "/nonexistent-artifacts-path",
		tasksPath: "/tmp/tasks.json",
		eventsPath: "/tmp/events.jsonl",
		artifacts: [],
		...overrides,
	};
}

function makeTask(id: string, overrides?: Partial<TeamTaskState>): TeamTaskState {
	return {
		id,
		runId: "test-run",
		role: "agent",
		agent: "default-agent",
		title: `Task ${id}`,
		status: "completed",
		dependsOn: [],
		cwd: "/tmp",
		...overrides,
	};
}

describe("buildTaskExplainContext", () => {
	it("throws for non-existent task ID", () => {
		const manifest = makeManifest();
		const tasks = [makeTask("t1")];
		assert.throws(() => buildTaskExplainContext(manifest, tasks, "nonexistent"), /not found/);
	});

	it("returns basic context for a completed task", () => {
		const manifest = makeManifest();
		const tasks = [makeTask("t1")];
		const ctx = buildTaskExplainContext(manifest, tasks, "t1");
		assert.equal(ctx.taskId, "t1");
		assert.equal(ctx.role, "agent");
		assert.equal(ctx.status, "completed");
	});

	it("includes dependency information in why", () => {
		const tasks = [
			makeTask("t1"),
			makeTask("t2", { dependsOn: ["t1"] }),
		];
		const manifest = makeManifest();
		const ctx = buildTaskExplainContext(manifest, tasks, "t2");
		assert.ok(ctx.why.includes("t1"));
		assert.ok(ctx.connectedTasks.some((c) => c.taskId === "t1" && c.relation === "depends on"));
	});

	it("includes dependents in connected tasks", () => {
		const tasks = [
			makeTask("t1", { dependsOn: [] }),
			makeTask("t2", { dependsOn: ["t1"] }),
		];
		const manifest = makeManifest();
		const ctx = buildTaskExplainContext(manifest, tasks, "t1");
		assert.ok(ctx.connectedTasks.some((c) => c.taskId === "t2" && c.relation === "depended on by"));
	});

	it("includes model info in what", () => {
		const tasks = [makeTask("t1", { model: "claude-3" })];
		const manifest = makeManifest();
		const ctx = buildTaskExplainContext(manifest, tasks, "t1");
		assert.ok(ctx.what.includes("claude-3"));
	});

	it("includes failure info for failed task", () => {
		const tasks = [makeTask("t1", { status: "failed", error: "OOM" })];
		const manifest = makeManifest();
		const ctx = buildTaskExplainContext(manifest, tasks, "t1");
		assert.ok(ctx.what.includes("FAILED"));
		assert.ok(ctx.what.includes("OOM"));
	});

	it("computes duration from startedAt/finishedAt", () => {
		const tasks = [makeTask("t1", {
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:10:00.000Z",
		})];
		const manifest = makeManifest();
		const ctx = buildTaskExplainContext(manifest, tasks, "t1");
		assert.equal(ctx.duration, 600);
	});

	it("computes layer from adaptive phase", () => {
		const tasks = [makeTask("t1", { adaptive: { phase: "execute" } } as any)];
		const manifest = makeManifest();
		const ctx = buildTaskExplainContext(manifest, tasks, "t1");
		assert.equal(ctx.layer, "execution");
	});

	it("returns unknown layer for unrecognized phase", () => {
		const tasks = [makeTask("t1", { adaptive: { phase: "custom-phase" } } as any)];
		const manifest = makeManifest();
		const ctx = buildTaskExplainContext(manifest, tasks, "t1");
		assert.equal(ctx.layer, "unknown");
	});

	it("computes complexity based on task count", () => {
		const manifest = makeManifest();
		// simple: <=3 tasks
		assert.equal(buildTaskExplainContext(manifest, [makeTask("t1")], "t1").complexity, "simple");
		// moderate: 4-8 tasks
		const moderateTasks = Array.from({ length: 5 }, (_, i) => makeTask(`t${i}`));
		assert.equal(buildTaskExplainContext(manifest, moderateTasks, "t0").complexity, "moderate");
		// complex: >8 tasks
		const complexTasks = Array.from({ length: 10 }, (_, i) => makeTask(`t${i}`));
		assert.equal(buildTaskExplainContext(manifest, complexTasks, "t0").complexity, "complex");
	});

	it("includes usage info in context", () => {
		const tasks = [makeTask("t1", { usage: { input: 100, output: 200 } })];
		const manifest = makeManifest();
		const ctx = buildTaskExplainContext(manifest, tasks, "t1");
		assert.ok(ctx.usage);
		assert.equal(ctx.usage!.inputTokens, 100);
		assert.equal(ctx.usage!.outputTokens, 200);
	});
});

describe("formatTaskExplain", () => {
	it("includes task ID and role in header", () => {
		const ctx: TaskExplainContext = {
			taskId: "t1", role: "agent", status: "completed",
			why: "Part of team.", what: "Ran agent.",
			filesTouched: [], connectedTasks: [], layer: "unknown", complexity: "simple",
		};
		const md = formatTaskExplain(ctx);
		assert.ok(md.includes("t1"));
		assert.ok(md.includes("agent"));
		assert.ok(md.includes("completed"));
	});

	it("includes files section when files exist", () => {
		const ctx: TaskExplainContext = {
			taskId: "t1", role: "agent", status: "completed",
			why: "Part of team.", what: "Ran agent.",
			filesTouched: ["file1.ts", "file2.ts"],
			connectedTasks: [], layer: "unknown", complexity: "simple",
		};
		const md = formatTaskExplain(ctx);
		assert.ok(md.includes("Files produced"));
		assert.ok(md.includes("file1.ts"));
	});

	it("omits files section when no files", () => {
		const ctx: TaskExplainContext = {
			taskId: "t1", role: "agent", status: "completed",
			why: "Part of team.", what: "Ran agent.",
			filesTouched: [],
			connectedTasks: [], layer: "unknown", complexity: "simple",
		};
		const md = formatTaskExplain(ctx);
		assert.ok(!md.includes("Files produced"));
	});

	it("includes connected tasks section", () => {
		const ctx: TaskExplainContext = {
			taskId: "t1", role: "agent", status: "completed",
			why: "Part of team.", what: "Ran agent.",
			filesTouched: [],
			connectedTasks: [{ taskId: "t2", status: "completed", relation: "depends on" }],
			layer: "unknown", complexity: "simple",
		};
		const md = formatTaskExplain(ctx);
		assert.ok(md.includes("Connected tasks"));
		assert.ok(md.includes("t2"));
	});

	it("includes usage row when usage is present", () => {
		const ctx: TaskExplainContext = {
			taskId: "t1", role: "agent", status: "completed",
			why: "Part of team.", what: "Ran agent.",
			filesTouched: [], connectedTasks: [], layer: "unknown", complexity: "simple",
			usage: { inputTokens: 50, outputTokens: 100 },
		};
		const md = formatTaskExplain(ctx);
		assert.ok(md.includes("Usage"));
		assert.ok(md.includes("50"));
		assert.ok(md.includes("100"));
	});

	it("includes duration row when duration is present", () => {
		const ctx: TaskExplainContext = {
			taskId: "t1", role: "agent", status: "completed",
			why: "Part of team.", what: "Ran agent.",
			filesTouched: [], connectedTasks: [], layer: "unknown", complexity: "simple",
			duration: 300,
		};
		const md = formatTaskExplain(ctx);
		assert.ok(md.includes("Duration"));
	});
});
