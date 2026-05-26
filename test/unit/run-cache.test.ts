import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import type { TeamTaskState } from "../../src/state/types.ts";
import {
  computeRunCacheKey,
  getCachedRun,
  saveRunToCache,
  clearCache,
  getCacheStats,
} from "../../src/state/run-cache.ts";

test("computeRunCacheKey: deterministic", () => {
  const key1 = computeRunCacheKey("fix bug", "default", "default", "/tmp");
  const key2 = computeRunCacheKey("fix bug", "default", "default", "/tmp");
  assert.equal(key1, key2);
});

test("computeRunCacheKey: different goals produce different keys", () => {
  const key1 = computeRunCacheKey("fix bug", "default", "default", "/tmp");
  const key2 = computeRunCacheKey("add feature", "default", "default", "/tmp");
  assert.notEqual(key1, key2);
});

test("computeRunCacheKey: case insensitive", () => {
  const key1 = computeRunCacheKey("FIX BUG", "default", "default", "/tmp");
  const key2 = computeRunCacheKey("fix bug", "default", "default", "/tmp");
  assert.equal(key1, key2);
});

test("computeRunCacheKey: whitespace normalized", () => {
  const key1 = computeRunCacheKey("fix bug", "default", "default", "/tmp");
  const key2 = computeRunCacheKey("  fix   bug  ", "default", "default", "/tmp");
  assert.equal(key1, key2);
});

test("getCachedRun: cache miss returns null", () => {
  const tmp = os.tmpdir();
  const key = computeRunCacheKey("nonexistent goal", "default", "default", tmp);
  const result = getCachedRun(tmp, key);
  assert.equal(result, null);
});

test("saveRunToCache + getCachedRun: roundtrip", () => {
  const tmp = os.tmpdir();
  const goal = "create test file";
  const team = "default";
  const workflow = "fast-fix";
  const key = computeRunCacheKey(goal, team, workflow, tmp);

  const tasks = [
    { taskId: "01_test", role: "test-engineer", status: "completed" } as unknown as TeamTaskState,
  ];

  saveRunToCache(tmp, key, "run_123", "completed", tasks, goal, team);

  const cached = getCachedRun(tmp, key);
  assert.ok(cached !== null);
  assert.equal(cached!.runId, "run_123");
  assert.equal(cached!.status, "completed");
  assert.equal(cached!.goal, goal);
  assert.equal(cached!.team, team);
  assert.equal(cached!.tasks.length, 1);
  assert.equal(cached!.tasks[0].taskId, "01_test");

  // Cleanup
  clearCache(tmp);
});

test("getCachedRun: expired entry returns null", () => {
  const tmp = os.tmpdir();
  const goal = "expired test";
  const key = computeRunCacheKey(goal, "default", "default", tmp);

  // Save with 1ms TTL
  const tasks = [{ taskId: "01", role: "agent", status: "completed" }] as unknown as TeamTaskState[];
  saveRunToCache(tmp, key, "run_expired", "completed", tasks, goal, "default", 1);

  // Wait for expiry
  const start = Date.now();
  while (Date.now() - start < 10) { /* spin */ }

  const cached = getCachedRun(tmp, key);
  assert.equal(cached, null);

  // Cleanup
  clearCache(tmp);
});

test("clearCache: removes all entries", () => {
  const tmp = os.tmpdir();

  const key1 = computeRunCacheKey("goal1", "default", "default", tmp);
  const key2 = computeRunCacheKey("goal2", "default", "default", tmp);

  saveRunToCache(tmp, key1, "run1", "completed", [], "goal1", "default");
  saveRunToCache(tmp, key2, "run2", "completed", [], "goal2", "default");

  const statsBefore = getCacheStats(tmp);
  assert.ok(statsBefore.entries >= 2);

  clearCache(tmp);

  const statsAfter = getCacheStats(tmp);
  assert.equal(statsAfter.entries, 0);

  const cached1 = getCachedRun(tmp, key1);
  const cached2 = getCachedRun(tmp, key2);
  assert.equal(cached1, null);
  assert.equal(cached2, null);
});

test("getCacheStats: empty cache returns zeros", () => {
  const tmp = os.tmpdir();
  clearCache(tmp);
  const stats = getCacheStats(tmp);
  assert.equal(stats.entries, 0);
  assert.equal(stats.sizeBytes, 0);
});

test("getCacheStats: counts entries correctly", () => {
  const tmp = os.tmpdir();
  clearCache(tmp);

  for (let i = 0; i < 5; i++) {
    const key = computeRunCacheKey(`goal ${i}`, "default", "default", tmp);
    saveRunToCache(tmp, key, `run_${i}`, "completed", [], `goal ${i}`, "default");
  }

  const stats = getCacheStats(tmp);
  assert.ok(stats.entries >= 5);
  assert.ok(stats.sizeBytes > 0);

  clearCache(tmp);
});
