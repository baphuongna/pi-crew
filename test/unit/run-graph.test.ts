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

test("buildRunGraph: creates run node", () => {
  const manifest = {
    runId: "test_run_123",
    team: "default",
    workflow: "default",
    status: "completed",
    goal: "test goal",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  } as TeamRunManifest;

  const tasks: TeamTaskState[] = [];

  const graph = buildRunGraph(manifest, tasks);

  assert.equal(graph.version, "1.0.0");
  assert.equal(graph.runId, "test_run_123");
  assert.equal(graph.team, "default");
  assert.equal(graph.workflow, "default");
  assert.equal(graph.nodes.length, 1); // Only run node
  assert.equal(graph.nodes[0].id, "run:test_run_123");
  assert.equal(graph.nodes[0].type, "run");
  assert.equal(graph.edges.length, 0);
});

test("buildRunGraph: creates task nodes with edges", () => {
  const manifest = {
    runId: "test_run_123",
    team: "default",
    workflow: "default",
    status: "completed",
    goal: "test goal",
    createdAt: new Date().toISOString(),
  } as TeamRunManifest;

  const tasks: TeamTaskState[] = [
    { id: "01_explore", role: "explorer", status: "completed", dependsOn: [] } as TeamTaskState,
    { id: "02_plan", role: "planner", status: "completed", dependsOn: ["01_explore"] } as TeamTaskState,
    { id: "03_execute", role: "executor", status: "completed", dependsOn: ["02_plan"] } as TeamTaskState,
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
  const manifest = {
    runId: "test_run_123",
    team: "default",
    workflow: "default",
    status: "completed",
    goal: "test",
    createdAt: new Date().toISOString(),
  } as TeamRunManifest;

  const tasks: TeamTaskState[] = [
    { id: "01_explore", role: "explorer", status: "completed", dependsOn: [], phase: "explore" } as TeamTaskState,
    { id: "02_plan", role: "planner", status: "completed", dependsOn: ["01_explore"], phase: "plan" } as TeamTaskState,
    { id: "03_execute", role: "executor", status: "completed", dependsOn: ["02_plan"], phase: "execute" } as TeamTaskState,
  ];

  const graph = buildRunGraph(manifest, tasks);

  assert.ok(graph.layers.length >= 3);
  const exploreLayer = graph.layers.find((l) => l.name === "explore");
  assert.ok(exploreLayer);
  assert.ok(exploreLayer.nodeIds.includes("task:01_explore"));
});

test("saveRunGraph + loadRunGraph: roundtrip", () => {
  const tmp = os.tmpdir();
  const manifest = {
    runId: "test_save_load",
    team: "default",
    workflow: "default",
    status: "completed",
    goal: "test",
    createdAt: new Date().toISOString(),
  } as TeamRunManifest;

  const tasks: TeamTaskState[] = [
    { id: "01", role: "explorer", status: "completed", dependsOn: [] } as TeamTaskState,
  ];

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
  const manifest = {
    runId: "test_list",
    team: "default",
    workflow: "default",
    status: "completed",
    goal: "test",
    createdAt: new Date().toISOString(),
  } as TeamRunManifest;

  buildAndSaveRunGraph(manifest, [], tmp);

  const graphs = listRunGraphs(tmp);
  assert.ok(graphs.includes("test_list"));

  // Cleanup
  const graphPath = path.join(tmp, ".crew", "graphs", "test_list.json");
  if (fs.existsSync(graphPath)) fs.unlinkSync(graphPath);
});

test("buildRunGraph: includes agent nodes when agentModel is present", () => {
  const manifest = {
    runId: "test_agent",
    team: "default",
    workflow: "default",
    status: "completed",
    goal: "test",
    createdAt: new Date().toISOString(),
  } as TeamRunManifest;

  const tasks: TeamTaskState[] = [
    { id: "01", role: "explorer", status: "completed", dependsOn: [], agentModel: "minimax/MiniMax-M2.7" } as unknown as TeamTaskState,
  ];

  const graph = buildRunGraph(manifest, tasks);

  const agentNodes = graph.nodes.filter((n) => n.type === "agent");
  assert.ok(agentNodes.length >= 1);

  const runsEdges = graph.edges.filter((e) => e.type === "runs");
  assert.ok(runsEdges.length >= 1);
});
