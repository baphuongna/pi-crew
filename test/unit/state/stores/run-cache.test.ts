import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { computeRunCacheKey, getCachedRun, getCacheStats } from "../../../../src/state/stores/run-cache.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { projectCrewRoot } from "../../../../src/utils/paths.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// Note: saveRunToCache/clearCache were removed (Round 7 R7-5: 0 production
// callers; getCachedRun is the live read-only consumer). Cache state for these
// tests is built by writing index.json + entry fixtures directly, exactly as
// a previous saveRunToCache run would have laid them out on disk.

interface FixtureEntry {
	key: string;
	runId: string;
	status?: string;
	tasks?: TeamTaskState[];
	goal?: string;
	team?: string;
	cachedAt?: number;
	expiresAt: number;
}

/**
 * Write one cache entry fixture (entry JSON + index.json merge) under
 * <projectCrewRoot(cwd)>/cache — mirroring the on-disk layout produced by
 * the removed saveRunToCache writer.
 */
function writeCacheEntry(cwd: string, entry: FixtureEntry): string {
	const dir = path.join(projectCrewRoot(cwd), "cache");
	fs.mkdirSync(dir, { recursive: true });
	const entryPath = path.join(dir, `${entry.key}.json`);
	fs.writeFileSync(
		entryPath,
		JSON.stringify({
			key: entry.key,
			runId: entry.runId,
			status: entry.status ?? "completed",
			tasks: entry.tasks ?? [],
			cachedAt: entry.cachedAt ?? Date.now(),
			expiresAt: entry.expiresAt,
			goal: entry.goal ?? "goal",
			team: entry.team ?? "default",
		}),
		"utf-8",
	);
	const indexPath = path.join(dir, "index.json");
	let index: Record<string, string> = {};
	if (fs.existsSync(indexPath)) {
		index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as Record<string, string>;
	}
	index[entry.key] = entryPath;
	fs.writeFileSync(indexPath, JSON.stringify(index), "utf-8");
	return entryPath;
}

function makeTmp(): string {
	// Tracked temp dir WITH a .git marker so projectCrewRoot(tmp) resolves
	// inside the temp tree (bug-029: on macOS CI the raw-mkdtemp walk escaped
	// the symlinked tmpdir boundary and shared a runner-adjacent .crew/cache —
	// the last two getCacheStats tests read entries accumulated by earlier
	// tests in this file and failed deterministically).
	return createTrackedTempDir("pi-crew-run-cache-");
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

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
	const tmp = makeTmp();
	try {
		const key = computeRunCacheKey("nonexistent goal", "default", "default", tmp);
		assert.equal(getCachedRun(tmp, key), null);
	} finally {
		cleanup(tmp);
	}
});

test("getCachedRun: returns entry written by fixture", () => {
	const tmp = makeTmp();
	try {
		const goal = "create test file";
		const team = "default";
		const key = computeRunCacheKey(goal, team, "fast-fix", tmp);

		const tasks = [
			{
				taskId: "01_test",
				role: "test-engineer",
				status: "completed",
			} as unknown as TeamTaskState,
		];
		writeCacheEntry(tmp, { key, runId: "run_123", status: "completed", tasks, goal, team, expiresAt: Date.now() + 60_000 });

		const cached = getCachedRun(tmp, key);
		assert.ok(cached !== null);
		assert.equal(cached!.runId, "run_123");
		assert.equal(cached!.status, "completed");
		assert.equal(cached!.goal, goal);
		assert.equal(cached!.team, team);
		assert.equal(cached!.tasks.length, 1);
		assert.equal((cached!.tasks[0] as unknown as { taskId?: string }).taskId, "01_test");
	} finally {
		cleanup(tmp);
	}
});

test("getCachedRun: expired entry returns null and is purged (live expiry path)", () => {
	const tmp = makeTmp();
	try {
		const key = computeRunCacheKey("expired test", "default", "default", tmp);
		const entryPath = writeCacheEntry(tmp, { key, runId: "run_expired", expiresAt: Date.now() - 1 });

		assert.equal(getCachedRun(tmp, key), null);

		// Expiry is destructive: the entry file is removed and the index no
		// longer maps the key (atomic unlink + index rewrite under lock).
		assert.ok(!fs.existsSync(entryPath), "expired entry file should be unlinked");
		const indexPath = path.join(projectCrewRoot(tmp), "cache", "index.json");
		const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as Record<string, string>;
		assert.equal(index[key], undefined);
	} finally {
		cleanup(tmp);
	}
});

test("getCachedRun: corrupt index.json returns null instead of throwing", () => {
	const tmp = makeTmp();
	try {
		const key = computeRunCacheKey("corrupt index", "default", "default", tmp);
		const cacheDir = path.join(projectCrewRoot(tmp), "cache");
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, "index.json"), "{ not valid json", "utf-8");

		assert.doesNotThrow(() => getCachedRun(tmp, key));
		assert.equal(getCachedRun(tmp, key), null);
	} finally {
		cleanup(tmp);
	}
});

test("getCachedRun: corrupt entry file returns null", () => {
	const tmp = makeTmp();
	try {
		const key = computeRunCacheKey("corrupt entry", "default", "default", tmp);
		const cacheDir = path.join(projectCrewRoot(tmp), "cache");
		const entryPath = path.join(cacheDir, `${key}.json`);
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(entryPath, "{ not valid json", "utf-8");
		fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify({ [key]: entryPath }), "utf-8");

		assert.equal(getCachedRun(tmp, key), null);
	} finally {
		cleanup(tmp);
	}
});

test("getCachedRun: index entry pointing at missing file returns null", () => {
	const tmp = makeTmp();
	try {
		const key = computeRunCacheKey("missing entry file", "default", "default", tmp);
		const cacheDir = path.join(projectCrewRoot(tmp), "cache");
		fs.mkdirSync(cacheDir, { recursive: true });
		const ghost = path.join(cacheDir, "ghost.json");
		fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify({ [key]: ghost }), "utf-8");

		assert.equal(getCachedRun(tmp, key), null);
	} finally {
		cleanup(tmp);
	}
});

test("getCacheStats: empty cache returns zeros", () => {
	const tmp = makeTmp();
	try {
		const stats = getCacheStats(tmp);
		assert.equal(stats.entries, 0);
		assert.equal(stats.sizeBytes, 0);
	} finally {
		cleanup(tmp);
	}
});

test("getCacheStats: counts entries correctly", () => {
	const tmp = makeTmp();
	try {
		for (let i = 0; i < 5; i++) {
			const key = computeRunCacheKey(`goal ${i}`, "default", "default", tmp);
			writeCacheEntry(tmp, { key, runId: `run_${i}`, goal: `goal ${i}`, expiresAt: Date.now() + 60_000 });
		}

		const stats = getCacheStats(tmp);
		assert.equal(stats.entries, 5);
		assert.ok(stats.sizeBytes > 0);
	} finally {
		cleanup(tmp);
	}
});
