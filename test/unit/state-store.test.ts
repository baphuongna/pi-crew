import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { __test__clearManifestCache, __test__manifestCacheSize, createRunManifest, loadRunManifestById, saveRunTasks, saveRunTasksAsync, saveRunManifestAsync } from "../../src/state/state-store.ts";
import { DEFAULT_CACHE } from "../../src/config/defaults.ts";
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
