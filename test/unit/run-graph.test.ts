import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRunGraph,
  saveRunGraph,
  loadRunGraph,
  listRunGraphs,
  buildAndSaveRunGraph,
} from "../../src/state/run-graph.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

function makeManifest(runId: string): TeamRunManifest {
  return {
    runId,
    team: "default",
    workflow: "default",
    status: "completed",
    goal: "test",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    schemaVersion: "1.0.0",
    workspaceMode: "single",
    updatedAt: new Date().toISOString(),
    cwd: os.tmpdir(),
    stateRoot: os.tmpdir(),
    tasksPath: path.join(os.tmpdir(), "tasks.json"),
    eventsPath: path.join(os.tmpdir(), "events.jsonl"),
    artifactsRoot: path.join(os.tmpdir(), "artifacts"),
    manifestPath: path.join(os.tmpdir(), "manifest.json"),
  } as unknown as TeamRunManifest;
}

function makeTask(id: string, role: string, dependsOn: string[] = []): TeamTaskState {
  return {
    id,
    runId: "test_run",
    role,
    status: "completed",
    dependsOn,
    cwd: os.tmpdir(),
    agent: role,
    title: `Task ${id}`,
  } as unknown as TeamTaskState;
}

test("buildRunGraph: creates run node", () => {
  const manifest = makeManifest("test_run_123");
  const tasks: TeamTaskState[] = [];

  const graph = buildRunGraph(manifest, tasks);

  assert.equal(graph.version, "1.0.0");
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].type, "run");
  assert.equal(graph.edges.length, 0);
});

test("buildRunGraph: creates task nodes with edges", () => {
  const manifest = makeManifest("test_run_123");
  const tasks: TeamTaskState[] = [
    makeTask("01_explore", "explorer"),
    makeTask("02_plan", "planner", ["01_explore"]),
    makeTask("03_execute", "executor", ["02_plan"]),
  ];

  const graph = buildRunGraph(manifest, tasks);

  assert.equal(graph.nodes.length, 4); // run + 3 tasks
  assert.equal(graph.edges.length, 5); // run->task (3) + dependsOn (2)

  // Check run->task edges
  const runToTaskEdges = graph.edges.filter((e) => e.type === "contains");
  assert.equal(runToTaskEdges.length, 3);

  // Check dependsOn edge
  const dependsEdges = graph.edges.filter((e) => e.type === "dependsOn");
  assert.equal(dependsEdges.length, 2);
  assert.ok(dependsEdges.some((e) => e.source === "task:01_explore" && e.target === "task:02_plan"));
  assert.ok(dependsEdges.some((e) => e.source === "task:02_plan" && e.target === "task:03_execute"));
});

test("buildRunGraph: creates layers from phases", () => {
  const manifest = makeManifest("test_phases");
  const tasks: TeamTaskState[] = [
    makeTask("01_explore", "explorer"),
    makeTask("02_plan", "planner"),
    makeTask("03_execute", "executor"),
  ];

  const graph = buildRunGraph(manifest, tasks);

  // Should create 3 layers: explorer, planner, executor
  assert.ok(graph.layers.length >= 3, `Expected at least 3 layers, got ${graph.layers.length}`);
  assert.deepEqual(graph.layers.map(l => l.name), ["explorer", "planner", "executor"]);
});

test("saveRunGraph + loadRunGraph: roundtrip", () => {
  const tmp = os.tmpdir();
  fs.mkdirSync(path.join(tmp, ".crew", "graphs"), { recursive: true });
  const manifest = makeManifest("test_save_load");
  const tasks: TeamTaskState[] = [makeTask("01", "explorer")];

  const graph = buildRunGraph(manifest, tasks);
  const savedPath = saveRunGraph(graph, tmp);

  assert.ok(fs.existsSync(savedPath));

  const loaded = loadRunGraph(tmp, "test_save_load");
  assert.ok(loaded !== null);
  assert.equal(loaded.runId, "test_save_load");
  assert.equal(loaded.nodes.length, 2);
  assert.equal(loaded.status, "completed");

  // Cleanup
  fs.unlinkSync(savedPath);
});

test("loadRunGraph: returns null for missing graph", () => {
  const tmp = os.tmpdir();
  const result = loadRunGraph(tmp, "nonexistent_run");
  assert.equal(result, null);
});

test("listRunGraphs: returns empty for missing directory", () => {
  const tmp = os.tmpdir();
  const result = listRunGraphs(tmp);
  assert.equal(result.length, 0);
});

test("listRunGraphs: returns saved graph IDs", () => {
  const tmp = os.tmpdir();
  const manifest = makeManifest("test_list");

  buildAndSaveRunGraph(manifest, [], tmp);

  const graphs = listRunGraphs(tmp);
  assert.ok(graphs.includes("test_list"));

  // Cleanup
  const graphPath = path.join(tmp, ".crew", "graphs", "test_list.json");
  if (fs.existsSync(graphPath)) fs.unlinkSync(graphPath);
});

test("buildRunGraph: includes agent nodes when agentModel is present", () => {
  const manifest = makeManifest("test_agent");
  const tasks: TeamTaskState[] = [makeTask("01", "explorer")];

  const graph = buildRunGraph(manifest, tasks);

  // Should have run node + 1 task node = 2 nodes
  assert.equal(graph.nodes.filter((n) => n.type !== "agent").length, 2);
});