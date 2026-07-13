import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CACHE } from "../../src/config/defaults.ts";
import { createManifestCache } from "../../src/runtime/manifest-cache.ts";
import {
	__test__clearManifestCache,
	__test__getManifestCacheEntry,
	__test__manifestCacheSize,
	__test__setManifestCache,
	createRunManifest,
	createRunPaths,
	createTasksFromWorkflow,
	getManifestCacheStats,
	loadRunManifestById,
	loadRunManifestByIdAsync,
	saveRunManifest,
	saveRunManifestAsync,
	saveRunTasks,
	saveRunTasksAsync,
	unloadRun,
	updateRunStatus,
} from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

/** Resolve temp dir through realpath to handle macOS /var → /private/var symlink. */
function makeResolvedTempDir(prefix: string): string {
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
	// LEAK PREVENTION: `.git` marker so useProjectState(dir) → true, keeping
	// createRunManifest/writeRunFixture run records inside <tmpdir>/.crew/
	// instead of leaking to the extension-global state dir the crew UI reads.
	try {
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	} catch {
		/* best-effort */
	}
	return dir;
}

/**
 * Retry a file operation a few times on Windows to ride out the brief window
 * where a freshly-created file is locked by the OS / real-time AV scanner
 * (EPERM/EBUSY). On non-Windows this is a passthrough. node:test runs files
 * concurrently in one process; under load the Windows runner can take a few
 * ms to release a just-renamed file handle.
 */
function retryWinFs<T>(fn: () => T): T {
	let lastError: unknown;
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			return fn();
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code;
			if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY" && code !== "EAGAIN")) throw error;
			// brief backoff on Windows AV/lock window
			const end = Date.now() + Math.min(40, 1 * 2 ** attempt);
			while (Date.now() < end) {
				/* spin */
			}
		}
	}
	throw lastError;
}
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

function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = makeResolvedTempDir("pi-crew-state-home-");
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("createRunManifest writes manifest and tasks", () => {
	let cwd = makeResolvedTempDir("pi-crew-state-test-");
	try {
		cwd = fs.realpathSync(cwd);
	} catch {
		/* keep */
	}
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "test",
		});
		assert.ok(fs.existsSync(created.paths.manifestPath));
		assert.ok(fs.existsSync(created.paths.tasksPath));
		assert.equal(created.tasks.length, 1);
		const loaded = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(loaded?.manifest.goal, "test");
		assert.equal(loaded?.tasks[0]?.role, "planner");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadRunManifestById rejects unsafe run ids and manifest path mismatches", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-safe-runid-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "safe",
		});
		assert.throws(() => loadRunManifestById(cwd, "../outside"), /Invalid runId/);
		const manifestPath = path.join(created.paths.stateRoot, "manifest.json");
		const raw = JSON.parse(retryWinFs(() => fs.readFileSync(manifestPath, "utf-8")));
		retryWinFs(() =>
			fs.writeFileSync(manifestPath, `${JSON.stringify({ ...raw, artifactsRoot: path.join(cwd, "outside") }, null, 2)}\n`, "utf-8"),
		);
		__test__clearManifestCache();
		assert.equal(loadRunManifestById(cwd, created.manifest.runId), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadRunManifestById rejects symlinked artifact roots outside artifact parent", (t) => {
	const cwd = makeResolvedTempDir("pi-crew-state-artifact-symlink-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "symlink artifact root",
		});
		const outside = path.join(cwd, "outside-artifacts");
		fs.mkdirSync(outside, { recursive: true });
		fs.rmSync(created.paths.artifactsRoot, {
			recursive: true,
			force: true,
		});
		if (!tryDirectorySymlink(outside, created.paths.artifactsRoot)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		__test__clearManifestCache();
		// loadRunManifestById should reject — either by returning undefined
		// or by throwing (e.g. path containment check on symlinked dirs).
		try {
			const result = loadRunManifestById(cwd, created.manifest.runId);
			assert.equal(result, undefined);
		} catch (e) {
			assert.ok(e instanceof Error && e.message.includes("outside"), `Expected containment error, got: ${e}`);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadRunManifestById revalidates cached artifact root containment", (t) => {
	const cwd = makeResolvedTempDir("pi-crew-state-cache-symlink-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "cache symlink artifact root",
		});
		assert.ok(loadRunManifestById(cwd, created.manifest.runId));
		const outside = path.join(cwd, "outside-artifacts-cache");
		fs.mkdirSync(outside, { recursive: true });
		fs.rmSync(created.paths.artifactsRoot, {
			recursive: true,
			force: true,
		});
		if (!tryDirectorySymlink(outside, created.paths.artifactsRoot)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		// loadRunManifestById should reject — either by returning undefined
		// or by throwing (e.g. path containment check on symlinked dirs).
		try {
			const result = loadRunManifestById(cwd, created.manifest.runId);
			assert.equal(result, undefined);
		} catch (e) {
			assert.ok(e instanceof Error && e.message.includes("outside"), `Expected containment error, got: ${e}`);
		}
	} finally {
		__test__clearManifestCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("runtime manifest cache rejects tampered manifest paths", () => {
	withIsolatedHome(() => {
		const cwd = makeResolvedTempDir("pi-crew-runtime-manifest-cache-safe-");
		fs.mkdirSync(path.join(cwd, ".crew"));
		try {
			const created = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "runtime cache safe",
			});
			const manifestPath = path.join(created.paths.stateRoot, "manifest.json");
			const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
			fs.writeFileSync(manifestPath, `${JSON.stringify({ ...raw, artifactsRoot: path.join(cwd, "outside") }, null, 2)}\n`, "utf-8");
			const cache = createManifestCache(cwd, {
				watch: false,
				debounceMs: 0,
			});
			try {
				assert.equal(cache.get(created.manifest.runId), undefined);
				assert.deepEqual(cache.list(), []);
			} finally {
				cache.dispose();
			}
		} finally {
			__test__clearManifestCache();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("loadRunManifestById resolves symlinks to canonical paths in manifest", (t) => {
	const parent = makeResolvedTempDir("pi-crew-state-workspace-link-");
	const realRoot = path.join(parent, "real-workspace");
	const linkRoot = path.join(parent, "linked-workspace");
	fs.mkdirSync(path.join(realRoot, ".crew"), { recursive: true });
	try {
		if (!tryDirectorySymlink(realRoot, linkRoot)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		const created = createRunManifest({
			cwd: linkRoot,
			team,
			workflow,
			goal: "linked workspace",
		});
		// projectCrewRoot uses realpathSync to resolve symlinks for security
		// boundary enforcement, so the manifest paths use the real path, not
		// the symlinked one. This is intentional — prevents symlink-based
		// state escape where attacker redirects via symlink.
		assert.match(created.manifest.stateRoot, /real-workspace/);
		const loaded = loadRunManifestById(linkRoot, created.manifest.runId);
		assert.equal(loaded?.manifest.goal, "linked workspace");
		assert.equal(loaded?.manifest.stateRoot, created.manifest.stateRoot);
	} finally {
		if (fs.existsSync(linkRoot)) removeDirectoryLink(linkRoot);
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("loadRunManifestById cache invalidates after task save", () => {
	__test__clearManifestCache();
	const cwd = makeResolvedTempDir("pi-crew-state-cache-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "cache",
		});
		const loaded1 = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(loaded1?.tasks[0]?.status, "queued");
		const updatedTasks = loaded1?.tasks.map((item) =>
			item.id === loaded1.tasks[0]?.id ? { ...item, status: "running" as const } : item,
		);
		saveRunTasks(created.manifest, updatedTasks ?? []);
		const loaded2 = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(loaded2?.tasks[0]?.status, "running");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("async save helpers persist run manifest and tasks", async () => {
	__test__clearManifestCache();
	const cwd = makeResolvedTempDir("pi-crew-state-async-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "async",
		});
		const loaded = loadRunManifestById(cwd, created.manifest.runId);
		const updatedTasks = loaded?.tasks.map((item) =>
			item.id === loaded.tasks[0]?.id ? { ...item, status: "completed" as const } : item,
		);
		await saveRunTasksAsync(created.manifest, updatedTasks ?? []);
		const updatedManifest = { ...created.manifest, summary: "Async test" };
		await saveRunManifestAsync(updatedManifest);
		const reloaded = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(reloaded?.tasks[0]?.status, "completed");
		assert.equal(reloaded?.manifest.summary, "Async test");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("createRunManifest resolves project root from parent .git directory", () => {
	let root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-gitroot-"));
	// Canonicalize to long-name form matching production code
	try {
		const r = fs.realpathSync.native(root);
		root = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		try {
			root = fs.realpathSync(root);
		} catch {
			/* keep as-is */
		}
	}
	const subDir = path.join(root, "services", "api");
	const workspace = path.join(root, ".crew");
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(subDir, { recursive: true });
	try {
		const created = createRunManifest({
			cwd: subDir,
			team,
			workflow,
			goal: "subfolder run",
		});
		assert.equal(created.paths.stateRoot, path.join(workspace, "state", "runs", created.manifest.runId));
		const loaded = loadRunManifestById(subDir, created.manifest.runId);
		assert.equal(loaded?.manifest.goal, "subfolder run");
		const manifestPath = path.join(created.paths.stateRoot, "manifest.json");
		assert.equal(fs.existsSync(manifestPath), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// --- New tests appended below ---

test("saveRunManifest persists manifest synchronously", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-save-manifest-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "save-manifest",
		});
		const updatedManifest = {
			...created.manifest,
			summary: "sync save test",
		};
		saveRunManifest(updatedManifest);
		__test__clearManifestCache();
		const loaded = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(loaded?.manifest.summary, "sync save test");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("createRunPaths generates correct directory structure", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-paths-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const paths = createRunPaths(cwd);
		assert.ok(paths.runId.startsWith("team_"));
		assert.match(paths.stateRoot, /state[\\/]runs/);
		assert.match(paths.artifactsRoot, /artifacts/);
		assert.equal(paths.manifestPath, path.join(paths.stateRoot, "manifest.json"));
		assert.equal(paths.tasksPath, path.join(paths.stateRoot, "tasks.json"));
		assert.equal(paths.eventsPath, path.join(paths.stateRoot, "events.jsonl"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("createRunPaths accepts a custom run ID", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-custom-id-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const paths = createRunPaths(cwd, "my_custom_run_123");
		assert.equal(paths.runId, "my_custom_run_123");
		assert.match(paths.stateRoot, /my_custom_run_123/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("createRunPaths rejects unsafe run IDs", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-unsafe-id-");
	try {
		assert.throws(() => createRunPaths(cwd, "../traversal"), /Invalid runId/);
		assert.throws(() => createRunPaths(cwd, "run with spaces"), /Invalid runId/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("createTasksFromWorkflow builds tasks for each step", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-tasks-wf-");
	try {
		const multiStepWorkflow: WorkflowConfig = {
			...workflow,
			steps: [
				{ id: "explore", role: "planner", task: "Explore" },
				{
					id: "execute",
					role: "planner",
					task: "Execute",
					dependsOn: ["explore"],
				},
			],
		};
		const tasks = createTasksFromWorkflow("run_123", multiStepWorkflow, team, cwd);
		assert.equal(tasks.length, 2);
		assert.equal(tasks[0].stepId, "explore");
		assert.equal(tasks[0].status, "queued");
		assert.equal(tasks[0].graph?.queue, "ready");
		assert.equal(tasks[1].stepId, "execute");
		assert.equal(tasks[1].dependsOn[0], "explore");
		assert.equal(tasks[1].graph?.queue, "blocked");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("createTasksFromWorkflow uses agent from team roles", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-tasks-agent-");
	try {
		const customTeam: TeamConfig = {
			name: "custom",
			description: "custom team",
			source: "builtin",
			filePath: "custom.md",
			roles: [
				{ name: "planner", agent: "planner-agent" },
				{ name: "executor", agent: "exec-agent" },
			],
		};
		const multiRoleWorkflow: WorkflowConfig = {
			name: "multi",
			description: "multi role",
			source: "builtin",
			filePath: "multi.md",
			steps: [
				{ id: "plan", role: "planner", task: "Plan" },
				{ id: "exec", role: "executor", task: "Execute" },
			],
		};
		const tasks = createTasksFromWorkflow("run_abc", multiRoleWorkflow, customTeam, cwd);
		assert.equal(tasks[0].agent, "planner-agent");
		assert.equal(tasks[1].agent, "exec-agent");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("updateRunStatus transitions queued to running", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-update-status-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "status transition",
		});
		assert.equal(created.manifest.status, "queued");
		const updated = updateRunStatus(created.manifest, "running", "Starting run");
		assert.equal(updated.status, "running");
		assert.equal(updated.summary, "Starting run");
		assert.ok(new Date(updated.updatedAt).getTime() >= new Date(created.manifest.updatedAt).getTime());
		__test__clearManifestCache();
		const loaded = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(loaded?.manifest.status, "running");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("updateRunStatus throws on invalid transitions", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-bad-transition-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "bad transition",
		});
		assert.throws(() => updateRunStatus(created.manifest, "completed"), /Invalid run status transition: queued -> completed/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("updateRunStatus preserves previous summary when no new summary provided", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-summary-preserve-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "summary preserve",
		});
		const withSummary = {
			...created.manifest,
			summary: "Existing summary",
		};
		saveRunManifest(withSummary);
		const updated = updateRunStatus(withSummary, "running");
		assert.equal(updated.summary, "Existing summary");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadRunManifestByIdAsync loads manifest asynchronously", async () => {
	const cwd = makeResolvedTempDir("pi-crew-state-async-load-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "async load",
		});
		__test__clearManifestCache();
		const loaded = await loadRunManifestByIdAsync(cwd, created.manifest.runId);
		assert.equal(loaded?.manifest.runId, created.manifest.runId);
		assert.equal(loaded?.manifest.goal, "async load");
		assert.equal(loaded?.tasks.length, 1);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("manifest cache is LRU bounded", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-cache-bounds-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousMax = DEFAULT_CACHE.manifestMaxEntries;
	try {
		DEFAULT_CACHE.manifestMaxEntries = 2;
		__test__clearManifestCache();
		const { manifest: first } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "first",
		});
		const { manifest: second } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "second",
		});
		loadRunManifestById(cwd, first.runId);
		loadRunManifestById(cwd, second.runId);
		assert.equal(__test__manifestCacheSize(), 2);
		const { manifest: third } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "third",
		});
		loadRunManifestById(cwd, third.runId);
		assert.equal(__test__manifestCacheSize(), 2);
		assert.equal(loadRunManifestById(cwd, first.runId)?.manifest.runId, first.runId);
		assert.equal(loadRunManifestById(cwd, third.runId)?.manifest.runId, third.runId);
		assert.ok(__test__manifestCacheSize() <= 2);
	} finally {
		DEFAULT_CACHE.manifestMaxEntries = previousMax;
		__test__clearManifestCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// --- OPT-08 additive helper tests ---

test("getManifestCacheStats returns a sensible object (size, limits, per-stateRoot entries)", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-cache-stats-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		__test__clearManifestCache();
		// Empty cache baseline
		const emptyStats = getManifestCacheStats();
		assert.equal(emptyStats.size, 0);
		assert.equal(emptyStats.maxEntries, DEFAULT_CACHE.manifestMaxEntries);
		assert.equal(emptyStats.ttlMs, 60 * 1000);
		assert.deepEqual(emptyStats.perStateRoot, {});

		// Populate cache with two runs and inspect stats again
		const { manifest: a } = createRunManifest({ cwd, team, workflow, goal: "stats-a" });
		const { manifest: b } = createRunManifest({ cwd, team, workflow, goal: "stats-b" });
		loadRunManifestById(cwd, a.runId);
		loadRunManifestById(cwd, b.runId);

		const stats = getManifestCacheStats();
		assert.equal(stats.size, 2);
		assert.equal(stats.maxEntries, DEFAULT_CACHE.manifestMaxEntries);
		assert.equal(stats.ttlMs, 60 * 1000);
		// Both stateRoots should appear with a generation + ageMs.
		for (const stateRoot of [a.stateRoot, b.stateRoot]) {
			assert.ok(stateRoot in stats.perStateRoot, `expected ${stateRoot} in perStateRoot`);
			const entry = stats.perStateRoot[stateRoot];
			assert.equal(typeof entry.generation, "number");
			assert.equal(typeof entry.ageMs, "number");
			assert.ok(entry.ageMs >= 0);
		}
	} finally {
		__test__clearManifestCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("unloadRun is idempotent and invalidates the cache entry for the given stateRoot", async () => {
	const cwd = makeResolvedTempDir("pi-crew-state-unload-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		__test__clearManifestCache();
		const created = createRunManifest({ cwd, team, workflow, goal: "unload" });
		// Populate cache
		const loaded = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(loaded);
		const cached = __test__getManifestCacheEntry(created.paths.stateRoot);
		assert.ok(cached, "expected cache entry after loadRunManifestById");

		// First call: removes the cache entry
		await unloadRun(created.paths.stateRoot);
		assert.equal(__test__getManifestCacheEntry(created.paths.stateRoot), undefined);

		// Second call on the same stateRoot: must NOT throw and must remain a no-op
		await unloadRun(created.paths.stateRoot);
		await unloadRun(created.paths.stateRoot);
		assert.equal(__test__getManifestCacheEntry(created.paths.stateRoot), undefined);

		// Call on an unknown stateRoot: also a no-op
		await unloadRun("/nonexistent/state/root/that/never/existed");
	} finally {
		__test__clearManifestCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("unloadRun forces the next read to reflect disk state, not stale cache", async () => {
	const cwd = makeResolvedTempDir("pi-crew-state-unload-stale-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		__test__clearManifestCache();
		const created = createRunManifest({ cwd, team, workflow, goal: "stale read" });
		const stateRoot = created.paths.stateRoot;
		const manifestPath = path.join(stateRoot, "manifest.json");

		// 1. Populate the cache with the real on-disk manifest.
		const firstLoad = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(firstLoad);
		assert.ok(__test__getManifestCacheEntry(stateRoot), "cache should be populated");

		// 2. Plant a stale cache entry with the SAME mtime/size as on disk
		//    (so the loadRunManifestById cache-hit path returns the stale content
		//    even though manifest.json on disk has a NEW value with the same
		//    size + mtime).
		const onDiskStat = fs.statSync(manifestPath);
		const onDiskTasksStat = fs.statSync(created.paths.tasksPath);
		const staleManifest = {
			...firstLoad.manifest,
			status: "running" as const,
			summary: "STALE-INJECTED",
		};
		__test__setManifestCache(stateRoot, {
			manifest: staleManifest,
			tasks: firstLoad.tasks,
			manifestMtimeMs: onDiskStat.mtimeMs,
			manifestSize: onDiskStat.size,
			tasksMtimeMs: onDiskTasksStat.mtimeMs,
			tasksSize: onDiskTasksStat.size,
			cachedAt: Date.now(),
			generation: 0,
		});

		// 3. Verify the cache hit path actually serves the stale entry.
		const staleLoad = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(staleLoad?.manifest.summary, "STALE-INJECTED", "cache should be serving stale value");

		// 4. Now write the NEW disk content (still same size as before so mtime/size match
		//    the stale cache entry's recorded values).
		const diskManifest = {
			...firstLoad.manifest,
			summary: "FRESH-DISK",
		};
		const serialized = `${JSON.stringify(diskManifest, null, 2)}\n`;
		// Pad or trim to match the on-disk size so mtime/size-cache check matches.
		// Easiest: ensure length matches (manually write the exact byte count to bypass
		// atomic-write's re-stating). Use atomicWriteJson then immediately re-stamp
		// the cache with the new mtime/size via __test__setManifestCache later.
		saveRunManifest(diskManifest); // atomic write, fresh mtime/size
		const freshStat = fs.statSync(manifestPath);
		assert.equal(freshStat.size, serialized.length);

		// Re-inject stale cache entry with the NEW disk mtime/size — this simulates
		// a parallel writer that updated disk while a stale reference was held in
		// the cache. The cache hit path will return the stale value, which is
		// exactly the bug unloadRun is designed to fix.
		__test__setManifestCache(stateRoot, {
			manifest: staleManifest,
			tasks: firstLoad.tasks,
			manifestMtimeMs: freshStat.mtimeMs,
			manifestSize: freshStat.size,
			tasksMtimeMs: onDiskTasksStat.mtimeMs,
			tasksSize: onDiskTasksStat.size,
			cachedAt: Date.now(),
			generation: 0,
		});

		// 5. Confirm the cache still serves stale BEFORE unloadRun.
		const stillStale = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(stillStale?.manifest.summary, "STALE-INJECTED", "cache should still serve stale before unloadRun");

		// 6. unloadRun should drop the cache entry so the next read hits disk.
		await unloadRun(stateRoot);
		assert.equal(__test__getManifestCacheEntry(stateRoot), undefined, "unloadRun must drop cache entry");

		// 7. Next load reflects disk truth, not the injected stale value.
		const freshLoad = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(freshLoad?.manifest.summary, "FRESH-DISK", "after unloadRun, read should reflect disk");
	} finally {
		__test__clearManifestCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("unloadRun flushes pending coalesced writes to disk", async () => {
	const cwd = makeResolvedTempDir("pi-crew-state-unload-flush-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		__test__clearManifestCache();
		const created = createRunManifest({ cwd, team, workflow, goal: "flush coalesced" });
		const { atomicWriteJsonCoalesced, flushPendingAtomicWrites } = await import("../../src/state/atomic-write.ts");

		// Enqueue a coalesced write to tasks.json — without unloadRun, this would
		// sit in the in-memory coalescer buffer for ~50ms before landing on disk.
		const updatedTasks = created.tasks.map((t) => ({ ...t, status: "running" as const }));
		atomicWriteJsonCoalesced(created.paths.tasksPath, updatedTasks);

		// Before flush, disk still has the original (queued) status.
		const beforeUnload = JSON.parse(fs.readFileSync(created.paths.tasksPath, "utf-8"));
		assert.equal(beforeUnload[0].status, "queued", "before unloadRun, disk should still be original");

		// unloadRun must trigger flushPendingAtomicWrites internally.
		await unloadRun(created.paths.stateRoot);

		// After unloadRun, disk reflects the coalesced write immediately.
		const afterUnload = JSON.parse(fs.readFileSync(created.paths.tasksPath, "utf-8"));
		assert.equal(afterUnload[0].status, "running", "after unloadRun, coalesced write must be on disk");

		// Sanity: calling again must not throw or leave residual state.
		await unloadRun(created.paths.stateRoot);
		flushPendingAtomicWrites(); // belt-and-suspenders
	} finally {
		__test__clearManifestCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
