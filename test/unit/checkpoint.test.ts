import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FileCheckpointStore,
  getCheckpointStore,
  clearCheckpointStores,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  hasCheckpoint,
  listCheckpoints,
  formatCheckpoint,
  formatAllCheckpoints,
} from "../../src/runtime/checkpoint.ts";

const tmp = path.join(os.tmpdir(), `cp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(tmp, { recursive: true });

test("FileCheckpointStore: saves and loads checkpoint", () => {
  clearCheckpointStores();
  const store = new FileCheckpointStore(tmp);

  store.save({
    runId: "test_run",
    taskId: "01_explore",
    step: 5,
    context: "Exploring codebase structure",
    progress: "Analyzing files...",
    savedAt: Date.now(),
    agentId: "explorer",
    agentModel: "minimax/MiniMax-M2.7",
  });

  const loaded = store.load("test_run", "01_explore");
  assert.ok(loaded !== null);
  assert.equal(loaded.taskId, "01_explore");
  assert.equal(loaded.step, 5);
  assert.equal(loaded.agentId, "explorer");

  store.delete("test_run", "01_explore");
});

test("FileCheckpointStore: returns null for missing", () => {
  clearCheckpointStores();
  const store = new FileCheckpointStore(tmp);
  const result = store.load("nonexistent", "nonexistent");
  assert.equal(result, null);
});

test("FileCheckpointStore: deletes checkpoint", () => {
  clearCheckpointStores();
  const store = new FileCheckpointStore(tmp);

  store.save({ runId: "test_del", taskId: "01", step: 1, context: "", progress: "", savedAt: Date.now(), agentId: "test" });
  assert.ok(store.hasCheckpoint("test_del", "01"));

  store.delete("test_del", "01");
  assert.ok(!store.hasCheckpoint("test_del", "01"));
});

test("FileCheckpointStore: list returns all checkpoints for run", () => {
  clearCheckpointStores();
  const store = new FileCheckpointStore(tmp);

  store.save({ runId: "test_list", taskId: "tl_01", step: 1, context: "", progress: "t1", savedAt: Date.now(), agentId: "test" });
  store.save({ runId: "test_list", taskId: "tl_02", step: 2, context: "", progress: "t2", savedAt: Date.now(), agentId: "test" });
  store.save({ runId: "other_run", taskId: "or_01", step: 1, context: "", progress: "other", savedAt: Date.now(), agentId: "test" });

  const checkpoints = store.list("test_list");
  assert.equal(checkpoints.length, 2);

  store.delete("test_list", "tl_01");
  store.delete("test_list", "tl_02");
  store.delete("other_run", "or_01");
});

test("FileCheckpointStore: wrong runId returns null", () => {
  clearCheckpointStores();
  const store = new FileCheckpointStore(tmp);

  store.save({ runId: "run_a", taskId: "01", step: 1, context: "", progress: "", savedAt: Date.now(), agentId: "test" });

  const loaded = store.load("run_b", "01");
  assert.equal(loaded, null);

  store.delete("run_a", "01");
});

test("getCheckpointStore: returns same store for same stateRoot", () => {
  clearCheckpointStores();
  const store1 = getCheckpointStore(tmp);
  const store2 = getCheckpointStore(tmp);
  assert.strictEqual(store1, store2);
});

test("saveCheckpoint + loadCheckpoint: using cwd-based path", () => {
  clearCheckpointStores();

  // Create a .crew/state/runs/test_run directory structure
  const runDir = path.join(tmp, ".crew/state/runs/test_run");
  fs.mkdirSync(runDir, { recursive: true });

  const origCwd = process.cwd();
  process.chdir(tmp);
  try {
    saveCheckpoint("test_run", "01", 3, "context summary", "step 3/10", "explorer", "minimax/MiniMax-M2.7");

    const loaded = loadCheckpoint("test_run", "01");
    assert.ok(loaded !== null);
    assert.equal(loaded.taskId, "01");
    assert.equal(loaded.step, 3);

    clearCheckpoint("test_run", "01");
  } finally {
    process.chdir(origCwd);
  }
});

test("hasCheckpoint: returns true when exists", () => {
  clearCheckpointStores();

  const runDir = path.join(tmp, ".crew/state/runs/has_cp");
  fs.mkdirSync(runDir, { recursive: true });

  const origCwd = process.cwd();
  process.chdir(tmp);
  try {
    saveCheckpoint("has_cp", "01", 1, "ctx", "progress", "agent");
    assert.equal(hasCheckpoint("has_cp", "01"), true);
    assert.equal(hasCheckpoint("has_cp", "02"), false);

    clearCheckpoint("has_cp", "01");
  } finally {
    process.chdir(origCwd);
  }
});

test("formatCheckpoint: produces markdown", () => {
  clearCheckpointStores();
  const formatted = formatCheckpoint({
    runId: "test",
    taskId: "01_explore",
    step: 5,
    context: "Exploring the codebase structure",
    progress: "Analyzing files...",
    savedAt: Date.now(),
    agentId: "explorer",
    agentModel: "minimax/MiniMax-M2.7",
  });

  assert.ok(formatted.includes("## Checkpoint: 01_explore"));
  assert.ok(formatted.includes("**Agent:** explorer"));
  assert.ok(formatted.includes("**Model:** minimax/MiniMax-M2.7"));
  assert.ok(formatted.includes("**Progress:** Analyzing files..."));
  assert.ok(formatted.includes("**Step:** 5"));
});

test("formatAllCheckpoints: shows all checkpoints", () => {
  clearCheckpointStores();

  const runDir = path.join(tmp, ".crew/state/runs/format_all");
  fs.mkdirSync(runDir, { recursive: true });

  const origCwd = process.cwd();
  process.chdir(tmp);
  try {
    saveCheckpoint("format_all", "01", 1, "ctx", "step 1", "agent");
    saveCheckpoint("format_all", "02", 2, "ctx", "step 2", "agent");

    const formatted = formatAllCheckpoints("format_all");
    assert.ok(formatted.includes("# Checkpoints: format_all"));
    assert.ok(formatted.includes("01"));
    assert.ok(formatted.includes("02"));

    clearCheckpoint("format_all", "01");
    clearCheckpoint("format_all", "02");
  } finally {
    process.chdir(origCwd);
  }
});

test("formatAllCheckpoints: handles empty", () => {
  const formatted = formatAllCheckpoints("nonexistent_run");
  assert.ok(formatted.includes("No checkpoints found"));
});
