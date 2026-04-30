import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { __test__clearManifestCache, __test__manifestCacheSize, createRunManifest, loadRunManifestById, saveRunTasks, saveRunTasksAsync, saveRunManifestAsync } from "../../src/state/state-store.ts";
import { DEFAULT_CACHE } from "../../src/config/defaults.ts";
import { createManifestCache } from "../../src/runtime/manifest-cache.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

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

test("createRunManifest writes manifest and tasks", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-test-"));
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
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-safe-runid-"));
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
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-artifact-symlink-"));
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
		assert.equal(loadRunManifestById(cwd, created.manifest.runId), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadRunManifestById revalidates cached artifact root containment", (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-cache-symlink-"));
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
		assert.equal(loadRunManifestById(cwd, created.manifest.runId), undefined);
	} finally {
		__test__clearManifestCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("runtime manifest cache rejects tampered manifest paths", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-runtime-manifest-cache-safe-"));
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
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadRunManifestById preserves lexical paths for symlinked workspaces", (t) => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-workspace-link-"));
	const realRoot = path.join(parent, "real-workspace");
	const linkRoot = path.join(parent, "linked-workspace");
	fs.mkdirSync(path.join(realRoot, ".crew"), { recursive: true });
	try {
		if (!tryDirectorySymlink(realRoot, linkRoot)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		const created = createRunManifest({ cwd: linkRoot, team, workflow, goal: "linked workspace" });
		assert.match(created.manifest.stateRoot, /linked-workspace/);
		const loaded = loadRunManifestById(linkRoot, created.manifest.runId);
		assert.equal(loaded?.manifest.goal, "linked workspace");
		assert.equal(loaded?.manifest.stateRoot, created.manifest.stateRoot);
	} finally {
		if (fs.existsSync(linkRoot)) removeDirectoryLink(linkRoot);
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("loadRunManifestById cache invalidates after task save", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-cache-"));
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
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-async-"));
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-gitroot-"));
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

test("manifest cache is LRU bounded", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state-cache-bounds-"));
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
