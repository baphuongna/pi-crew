import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { __test__clearManifestCache, __test__manifestCacheSize, createRunManifest, createRunPaths, createTasksFromWorkflow, loadRunManifestById, loadRunManifestByIdAsync, saveRunManifest, saveRunTasks, saveRunTasksAsync, saveRunManifestAsync, updateRunStatus } from "../../src/state/state-store.ts";
import { DEFAULT_CACHE } from "../../src/config/defaults.ts";
import { createManifestCache } from "../../src/runtime/manifest-cache.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";


/** Resolve temp dir through realpath to handle macOS /var → /private/var symlink. */
function makeResolvedTempDir(prefix: string): string {
	// On macOS, resolve /var → /private/var symlink.
	// On Windows, resolve short-name (RUNNER~1) → long-name (runneradmin)
	// and strip \\?\ prefix from realpathSync.native.
	let dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
	try {
		const resolved = fs.realpathSync.native(dir);
		dir = resolved.startsWith("\\\\?\\") ? resolved.slice(4) : resolved;
	} catch {
		try { dir = fs.realpathSync(dir); } catch { /* keep as-is */ }
	}
	return dir;
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
	try { cwd = fs.realpathSync(cwd); } catch { /* keep */ }
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "test" });
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
		const created = createRunManifest({ cwd, team, workflow, goal: "safe" });
		assert.throws(() => loadRunManifestById(cwd, "../outside"), /Invalid runId/);
		const manifestPath = path.join(created.paths.stateRoot, "manifest.json");
		const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		fs.writeFileSync(manifestPath, `${JSON.stringify({ ...raw, artifactsRoot: path.join(cwd, "outside") }, null, 2)}\n`, "utf-8");
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
		const created = createRunManifest({ cwd, team, workflow, goal: "symlink artifact root" });
		const outside = path.join(cwd, "outside-artifacts");
		fs.mkdirSync(outside, { recursive: true });
		fs.rmSync(created.paths.artifactsRoot, { recursive: true, force: true });
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
		const created = createRunManifest({ cwd, team, workflow, goal: "cache symlink artifact root" });
		assert.ok(loadRunManifestById(cwd, created.manifest.runId));
		const outside = path.join(cwd, "outside-artifacts-cache");
		fs.mkdirSync(outside, { recursive: true });
		fs.rmSync(created.paths.artifactsRoot, { recursive: true, force: true });
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
			const created = createRunManifest({ cwd, team, workflow, goal: "runtime cache safe" });
			const manifestPath = path.join(created.paths.stateRoot, "manifest.json");
			const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
			fs.writeFileSync(manifestPath, `${JSON.stringify({ ...raw, artifactsRoot: path.join(cwd, "outside") }, null, 2)}\n`, "utf-8");
			const cache = createManifestCache(cwd, { watch: false, debounceMs: 0 });
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
		const created = createRunManifest({ cwd: linkRoot, team, workflow, goal: "linked workspace" });
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
	const cwd = makeResolvedTempDir("pi-crew-state-cache-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "cache" });
		const loaded1 = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(loaded1?.tasks[0]?.status, "queued");
		const updatedTasks = loaded1?.tasks.map((item) => item.id === loaded1.tasks[0]?.id ? { ...item, status: "running" as const } : item);
		saveRunTasks(created.manifest, updatedTasks ?? []);
		const loaded2 = loadRunManifestById(cwd, created.manifest.runId);
		assert.equal(loaded2?.tasks[0]?.status, "running");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("async save helpers persist run manifest and tasks", async () => {
	const cwd = makeResolvedTempDir("pi-crew-state-async-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "async" });
		const loaded = loadRunManifestById(cwd, created.manifest.runId);
		const updatedTasks = loaded?.tasks.map((item) => item.id === loaded.tasks[0]?.id ? { ...item, status: "completed" as const } : item);
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
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-gitroot-")));
	const subDir = path.join(root, "services", "api");
	const workspace = path.join(root, ".crew");
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(subDir, { recursive: true });
	try {
		const created = createRunManifest({ cwd: subDir, team, workflow, goal: "subfolder run" });
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
		const created = createRunManifest({ cwd, team, workflow, goal: "save-manifest" });
		const updatedManifest = { ...created.manifest, summary: "sync save test" };
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
				{ id: "execute", role: "planner", task: "Execute", dependsOn: ["explore"] },
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
			roles: [{ name: "planner", agent: "planner-agent" }, { name: "executor", agent: "exec-agent" }],
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
		const created = createRunManifest({ cwd, team, workflow, goal: "status transition" });
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
		const created = createRunManifest({ cwd, team, workflow, goal: "bad transition" });
		assert.throws(
			() => updateRunStatus(created.manifest, "completed"),
			/Invalid run status transition: queued -> completed/,
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("updateRunStatus preserves previous summary when no new summary provided", () => {
	const cwd = makeResolvedTempDir("pi-crew-state-summary-preserve-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "summary preserve" });
		const withSummary = { ...created.manifest, summary: "Existing summary" };
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
		const created = createRunManifest({ cwd, team, workflow, goal: "async load" });
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
		const { manifest: first } = createRunManifest({ cwd, team, workflow, goal: "first" });
		const { manifest: second } = createRunManifest({ cwd, team, workflow, goal: "second" });
		loadRunManifestById(cwd, first.runId);
		loadRunManifestById(cwd, second.runId);
		assert.equal(__test__manifestCacheSize(), 2);
		const { manifest: third } = createRunManifest({ cwd, team, workflow, goal: "third" });
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
