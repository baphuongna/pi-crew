import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildTaskExplainContext,
  formatTaskExplain,
  handleExplain,
} from "../../src/extension/team-tool/explain.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

test("buildTaskExplainContext: builds context for task", () => {
  const manifest = {
    schemaVersion: 1 as const,
    runId: "test_run_123",
    team: "default",
    workflow: "default",
    status: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goal: "test goal",
    cwd: "/tmp",
    stateRoot: "/tmp/.crew/state/runs/test_run_123",
    artifactsRoot: os.tmpdir(),
    tasksPath: "/tmp/.crew/state/runs/test_run_123/tasks.json",
    eventsPath: "/tmp/.crew/state/runs/test_run_123/events.jsonl",
    workspaceMode: "single" as const,
    artifacts: [],
  } as TeamRunManifest;

  const tasks: TeamTaskState[] = [
    {
      id: "01_explore",
      runId: "test_run_123",
      role: "explorer",
      agent: "explorer",
      title: "Explore",
      status: "completed",
      dependsOn: [],
      cwd: "/tmp",
    } as TeamTaskState,
    {
      id: "02_plan",
      runId: "test_run_123",
      role: "planner",
      agent: "planner",
      title: "Plan",
      status: "completed",
      dependsOn: ["01_explore"],
      cwd: "/tmp",
    } as TeamTaskState,
    {
      id: "03_execute",
      runId: "test_run_123",
      role: "executor",
      agent: "executor",
      title: "Execute",
      status: "completed",
      dependsOn: ["02_plan"],
      cwd: "/tmp",
    } as TeamTaskState,
  ];

  const ctx = buildTaskExplainContext(manifest, tasks, "02_plan");

  assert.equal(ctx.taskId, "02_plan");
  assert.equal(ctx.role, "planner");
  assert.equal(ctx.status, "completed");
  assert.equal(ctx.complexity, "simple"); // 3 tasks <= 3 threshold
  assert.ok(ctx.why.includes("Depends on"));
  assert.ok(ctx.what.includes("planner"));
  assert.equal(ctx.connectedTasks.length, 2); // 1 dep + 1 dependent
});

test("formatTaskExplain: produces markdown", () => {
  const ctx = {
    taskId: "01_explore",
    role: "explorer",
    status: "completed",
    phase: "explore",
    why: "Part of default workflow.",
    what: "Ran agent: explorer (minimax/MiniMax-M2.7-highspeed).",
    filesTouched: [],
    connectedTasks: [],
    layer: "exploration",
    complexity: "simple" as const,
  };

  const output = formatTaskExplain(ctx);

  assert.ok(output.includes("# Task: 01_explore"));
  assert.ok(output.includes("explorer"));
  assert.ok(output.includes("## Why it exists"));
  assert.ok(output.includes("## What it did"));
  assert.ok(output.includes("exploration"));
});

test("buildTaskExplainContext: throws for missing task", () => {
  const manifest = { runId: "test" } as TeamRunManifest;
  const tasks: TeamTaskState[] = [];

  assert.throws(() => {
    buildTaskExplainContext(manifest, tasks, "nonexistent");
  }, /not found/);
});

test("handleExplain: requires runId", () => {
  const res = handleExplain({}, "/tmp");
  assert.equal(res.isError, true);
  assert.ok(res.text.includes("runId"));
});

test("handleExplain: explains full run without taskId", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "explain-test-"));
  const runId = `test_explain_${Date.now()}`;
  const crewRoot = path.join(tmp, ".crew");
  const stateRoot = path.join(crewRoot, "state", "runs", runId);
  const artifactsRoot = path.join(crewRoot, "artifacts", runId);
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(artifactsRoot, { recursive: true });

  const manifestData = {
    schemaVersion: 1,
    runId,
    team: "default",
    workflow: "default",
    status: "completed",
    goal: "test",
    cwd: tmp,
    stateRoot,
    artifactsRoot,
    tasksPath: path.join(stateRoot, "tasks.json"),
    eventsPath: path.join(stateRoot, "events.jsonl"),
    workspaceMode: "single",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: [],
  };

  fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifestData), "utf-8");
  fs.writeFileSync(path.join(stateRoot, "tasks.json"), "[]", "utf-8");

  const res = handleExplain({ runId }, tmp);
  assert.equal(res.isError, false);
  assert.ok(res.text.includes("# Run:"));
  assert.ok(res.text.includes("## Tasks"));

  // Cleanup
  fs.rmSync(tmp, { recursive: true, force: true });
});
