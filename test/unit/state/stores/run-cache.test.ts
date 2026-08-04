import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { clearCache, computeRunCacheKey, getCachedRun, getCacheStats, saveRunToCache } from "../../../../src/state/stores/run-cache.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";

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
		{
			taskId: "01_test",
			role: "test-engineer",
			status: "completed",
		} as unknown as TeamTaskState,
	];

	saveRunToCache(tmp, key, "run_123", "completed", tasks, goal, team);

	const cached = getCachedRun(tmp, key);
	assert.ok(cached !== null);
	assert.equal(cached!.runId, "run_123");
	assert.equal(cached!.status, "completed");
	assert.equal(cached!.goal, goal);
	assert.equal(cached!.team, team);
	assert.equal(cached!.tasks.length, 1);
	assert.equal((cached!.tasks[0] as unknown as { taskId?: string }).taskId, "01_test");

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
	while (Date.now() - start < 10) {
		/* spin */
	}

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

// NEW-P4 (TOCTOU): saveRunToCache now reads index.json via readFileSync + ENOENT
// catch instead of existsSync+read. These tests pin the three behaviors:
// 1) missing index.json → falls back to {} without throwing,
// 2) present index.json → parsed and merged correctly,
// 3) corrupt-but-present index.json → SyntaxError still propagates (only ENOENT
//    is swallowed — parse-error semantics unchanged from the existsSync era).
test("saveRunToCache: missing index.json falls back to empty index without throwing (NEW-P4)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-cache-nop4-"));
	try {
		const key = computeRunCacheKey("nop4 missing index", "default", "default", cwd);
		assert.doesNotThrow(() =>
			saveRunToCache(cwd, key, "run_nop4_missing", "completed", [], "nop4 missing index", "default"),
		);
		const cached = getCachedRun(cwd, key);
		assert.ok(cached !== null);
		assert.equal(cached!.runId, "run_nop4_missing");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveRunToCache: present index.json is parsed and merged (NEW-P4)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-cache-nop4-"));
	try {
		const key1 = computeRunCacheKey("nop4 index present 1", "default", "default", cwd);
		const key2 = computeRunCacheKey("nop4 index present 2", "default", "default", cwd);
		saveRunToCache(cwd, key1, "run_nop4_1", "completed", [], "nop4 index present 1", "default");
		// index.json exists now; second save must read + merge, not clobber
		assert.doesNotThrow(() =>
			saveRunToCache(cwd, key2, "run_nop4_2", "completed", [], "nop4 index present 2", "default"),
		);
		assert.equal(getCachedRun(cwd, key1)?.runId, "run_nop4_1");
		assert.equal(getCachedRun(cwd, key2)?.runId, "run_nop4_2");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveRunToCache: corrupt index.json still throws (NEW-P4 parse-error semantics preserved)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-cache-nop4-"));
	try {
		const key = computeRunCacheKey("nop4 corrupt index", "default", "default", cwd);
		saveRunToCache(cwd, key, "run_nop4_corrupt", "completed", [], "nop4 corrupt index", "default");
		// Corrupt the index — a SyntaxError must propagate (only ENOENT is swallowed).
		fs.writeFileSync(path.join(cwd, ".crew", "cache", "index.json"), "{ not valid json", "utf-8");
		assert.throws(() =>
			saveRunToCache(cwd, key, "run_nop4_corrupt2", "completed", [], "nop4 corrupt index", "default"),
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
