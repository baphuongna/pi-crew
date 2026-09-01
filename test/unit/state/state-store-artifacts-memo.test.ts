import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { flushPendingAtomicWrites } from "../../../src/state/atomic-write.ts";
import {
	__test__artifactsVerdictCacheSize,
	__test__clearArtifactsVerdictCache,
	__test__clearManifestCache,
	__test__getManifestCacheEntry,
	createRunManifest,
	loadRunManifestById,
	saveRunTasksCoalesced,
} from "../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

/**
 * Temp project fixture resolved through realpath (macOS /var → /private/var).
 * LEAK PREVENTION: BOTH markers are required to keep every run record inside
 * <tmpdir>/.crew — `.git` makes findRepoRoot treat the tmp dir as the project
 * root, and `.crew` pins projectCrewRoot at <tmpdir>/.crew. Without them the
 * fixture state leaks into the user-global crew root.
 */
function makeProjectTempDir(prefix: string): string {
	let dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
	try {
		const r = fs.realpathSync.native(dir);
		dir = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		try {
			dir = fs.realpathSync(dir);
		} catch {
			/* keep as-is */
		}
	}
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
	return dir;
}

function isUsableDirectoryLink(linkPath: string): boolean {
	try {
		fs.lstatSync(linkPath);
		fs.realpathSync.native(linkPath);
		return true;
	} catch {
		removeDirectoryLink(linkPath);
		return false;
	}
}

function tryDirectorySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath, "dir");
		return isUsableDirectoryLink(linkPath);
	} catch {
		try {
			fs.symlinkSync(target, linkPath, "junction");
			return isUsableDirectoryLink(linkPath);
		} catch {
			return false;
		}
	}
}

function removeDirectoryLink(linkPath: string): void {
	try {
		fs.unlinkSync(linkPath);
	} catch {
		fs.rmSync(linkPath, { recursive: false, force: true });
	}
}

test("artifacts verdict is memoized across loadRunManifestById calls", () => {
	__test__clearManifestCache();
	__test__clearArtifactsVerdictCache();
	const cwd = makeProjectTempDir("pi-crew-artifacts-memo-");
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "artifacts memo" });
		// First load: cache miss path — validateRunManifestPaths walks the fs and
		// records exactly one positive verdict for (cwd, runId).
		const first = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(first, "first load must return the run");
		assert.equal(first.manifest.runId, created.manifest.runId);
		assert.equal(__test__artifactsVerdictCacheSize(), 1, "first validation records the positive verdict");

		// Second load (manifest-cache hit path) re-validates, but the verdict
		// memo must serve it — still exactly one entry, no second record.
		const second = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(second, "second load must return the run");
		assert.equal(second.manifest.runId, created.manifest.runId);
		assert.equal(__test__artifactsVerdictCacheSize(), 1, "second validation hits the memo instead of adding an entry");
	} finally {
		__test__clearManifestCache();
		__test__clearArtifactsVerdictCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("negative artifacts verdicts are never cached", (t) => {
	__test__clearManifestCache();
	__test__clearArtifactsVerdictCache();
	const cwd = makeProjectTempDir("pi-crew-artifacts-neg-");
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "artifacts negative" });
		const outside = path.join(cwd, "outside-artifacts");
		fs.mkdirSync(outside, { recursive: true });
		fs.rmSync(created.paths.artifactsRoot, { recursive: true, force: true });
		if (!tryDirectorySymlink(outside, created.paths.artifactsRoot)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		// loadRunManifestById should reject — either by returning undefined or by
		// throwing (path containment check on the symlinked dir). Mirror the
		// tolerant shape of the artifact-symlink tests in state-store.test.ts.
		const expectRejectedLoad = (): void => {
			try {
				const result = loadRunManifestById(cwd, created.manifest.runId);
				assert.equal(result, undefined, "symlinked artifacts root must be rejected");
			} catch (e) {
				assert.ok(e instanceof Error && e.message.includes("outside"), `Expected containment error, got: ${e}`);
			}
		};
		expectRejectedLoad();
		assert.equal(__test__artifactsVerdictCacheSize(), 0, "negative verdicts must not be cached");
		// A second load must also fail (the negative was not sticky-cached as a
		// positive either) — repeating the rejected shape proves both directions.
		expectRejectedLoad();
		assert.equal(__test__artifactsVerdictCacheSize(), 0, "negative verdicts still not cached after repeat rejection");
	} finally {
		__test__clearManifestCache();
		__test__clearArtifactsVerdictCache();
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveRunTasksCoalesced keeps the manifest cache entry with zeroed tasks stamps", () => {
	__test__clearManifestCache();
	__test__clearArtifactsVerdictCache();
	const cwd = makeProjectTempDir("pi-crew-coalesced-keep-");
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "coalesced cache keep" });
		const stateRoot = created.paths.stateRoot;
		const loaded1 = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(loaded1, "initial load must succeed");
		assert.equal(loaded1.tasks[0]?.status, "queued");
		assert.ok(__test__getManifestCacheEntry(stateRoot), "initial load populates the manifest cache");

		const updatedTasks = loaded1.tasks.map((item, index) => (index === 0 ? { ...item, status: "running" as const } : item));
		// skipCoalesce=true so the write lands on disk synchronously and the
		// reload below is deterministic.
		saveRunTasksCoalesced(created.manifest, updatedTasks, true);

		// Cache-keep (was a full invalidate before this fix): the entry survives.
		const kept = __test__getManifestCacheEntry(stateRoot);
		assert.ok(kept, "coalesced save must KEEP the cache entry (it was deleted before this fix)");
		assert.equal(kept.tasksMtimeMs, 0, "tasks stamps must be zeroed — forces a tasks re-read, never a stale hit");
		assert.equal(kept.tasksSize, 0, "tasks size stamp must be zeroed too");
		assert.equal(kept.tasks[0]?.status, "running", "kept entry carries the freshly saved in-memory tasks array");
		assert.ok(kept.manifestMtimeMs !== 0, "manifest half of the entry survives for stat-verified hits");

		// Zeroed tasks stamps must MISS (a real on-disk mtime is never 0) and
		// re-read tasks from disk — which now holds the new content.
		const loaded2 = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(loaded2?.tasks[0]?.status, "running", "reload sees the NEW tasks from disk");
		const restamped = __test__getManifestCacheEntry(stateRoot);
		assert.ok(restamped, "reload re-populates the entry");
		assert.notEqual(restamped.tasksMtimeMs, 0, "reload re-stamps the real tasks mtime");
	} finally {
		__test__clearManifestCache();
		__test__clearArtifactsVerdictCache();
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("load after a coalesced save reuses the cached manifest object — manifest.json is not re-parsed", () => {
	__test__clearManifestCache();
	__test__clearArtifactsVerdictCache();
	const cwd = makeProjectTempDir("pi-crew-coalesced-reuse-");
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "coalesced manifest reuse" });
		const stateRoot = created.paths.stateRoot;
		const loaded1 = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(loaded1, "initial load must succeed");
		const cachedAfterLoad = __test__getManifestCacheEntry(stateRoot);
		assert.ok(cachedAfterLoad, "initial load populates the cache");
		assert.ok(cachedAfterLoad.manifest === loaded1.manifest, "cache stores the returned manifest object (identity baseline)");

		const updatedTasks = loaded1.tasks.map((item, index) => (index === 0 ? { ...item, status: "running" as const } : item));
		// Buffered coalesced save (the persistSingleTaskUpdate shape), then land
		// the pending write exactly like its pre-read flush does.
		saveRunTasksCoalesced(created.manifest, updatedTasks);
		flushPendingAtomicWrites();

		const loaded2 = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(loaded2, "reload must succeed");
		assert.equal(loaded2.tasks[0]?.status, "running", "reload returns the merged tasks read from disk");
		// Task 12 realization: the zeroed tasks stamps force the slow path (tasks
		// re-read), but the retained manifest half must be REUSED. Object
		// identity is the proof — a re-read + re-parse of manifest.json would
		// produce a fresh object and === would fail.
		assert.ok(
			loaded2.manifest === loaded1.manifest,
			"reload must reuse the cached manifest object — manifest.json not re-read + re-parsed",
		);
		const restamped = __test__getManifestCacheEntry(stateRoot);
		assert.ok(restamped, "reload re-populates the entry");
		assert.ok(restamped.manifest === loaded1.manifest, "re-populated entry keeps the same manifest object");
		assert.notEqual(restamped.tasksMtimeMs, 0, "reload re-stamps the real tasks mtime");
	} finally {
		__test__clearManifestCache();
		__test__clearArtifactsVerdictCache();
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("buffered coalesced save keeps the entry; next load re-reads disk, not the buffered array", () => {
	__test__clearManifestCache();
	__test__clearArtifactsVerdictCache();
	const cwd = makeProjectTempDir("pi-crew-coalesced-buffered-");
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "coalesced buffered" });
		const stateRoot = created.paths.stateRoot;
		const loaded1 = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(loaded1);
		const updatedTasks = loaded1.tasks.map((item, index) => (index === 0 ? { ...item, status: "running" as const } : item));
		// Buffered write: nothing lands on disk for ~50ms, and the unref'd timer
		// cannot fire during this synchronous test body.
		saveRunTasksCoalesced(created.manifest, updatedTasks);
		const kept = __test__getManifestCacheEntry(stateRoot);
		assert.ok(kept, "buffered save keeps the cache entry");
		assert.equal(kept.tasksMtimeMs, 0, "tasks stamps zeroed while the write is still buffered");

		// The zeroed stamps force a disk re-read, which sees the PREVIOUS
		// on-disk content — the load must NOT serve the buffered in-memory
		// array as a cache hit. That is the "only a miss, never a stale hit"
		// guarantee of the cache-keep branch.
		const loaded2 = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(
			loaded2?.tasks[0]?.status,
			"queued",
			"disk re-read returns the pre-write content while the coalesced write is pending",
		);
	} finally {
		__test__clearManifestCache();
		__test__clearArtifactsVerdictCache();
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
