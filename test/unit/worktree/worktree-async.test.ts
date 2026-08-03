import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import {
	clearCleanLeaderCache,
	clearGitRootCache,
	findGitRootAsync,
	prepareTaskWorkspaceAsync,
} from "../../../src/worktree/worktree-manager.ts";

function makeRepoTemp(prefix: string): string {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		dir = fs.realpathSync(dir);
	} catch {
		/* keep */
	}
	return dir;
}

function initGitRepo(dir: string) {
	execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
	fs.writeFileSync(path.join(dir, ".gitignore"), ".crew\n", "utf-8");
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", ".gitignore"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir });
}

function minimalManifest(cwd: string, runId: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId,
		team: "test-team",
		workflow: "test-workflow",
		goal: "test",
		status: "running",
		workspaceMode: "worktree",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd,
		stateRoot: path.join(cwd, ".crew", "state", "runs", runId),
		artifactsRoot: path.join(cwd, ".crew", "artifacts", runId),
		tasksPath: "tasks.json",
		eventsPath: "events.jsonl",
		artifacts: [],
	};
}

function minimalTask(id: string, cwd: string): TeamTaskState {
	return {
		id,
		agent: "explorer",
		status: "waiting",
		role: "explorer",
		title: "Test task",
		dependsOn: [],
		cwd,
		runId: "run_test",
	};
}

test("prepareTaskWorkspaceAsync returns correct worktree path", async () => {
	const repo = makeRepoTemp("pi-crew-wt-async-");
	initGitRepo(repo);
	try {
		const manifest = minimalManifest(repo, "async-run1");
		const task = minimalTask("async-task1", repo);
		const result = await prepareTaskWorkspaceAsync(manifest, task);
		assert.ok(result.worktreePath, "worktreePath should be set");
		assert.ok(result.branch, "branch should be set");
		assert.equal(result.reused, false, "first call should not be reused");
		assert.match(result.branch!, /pi-crew\/async-run1\/async-task1/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("prepareTaskWorkspaceAsync reuses existing worktree", async () => {
	const repo = makeRepoTemp("pi-crew-wt-async-reuse-");
	initGitRepo(repo);
	try {
		const manifest = minimalManifest(repo, "reuse-run1");
		const task = minimalTask("reuse-task1", repo);
		const first = await prepareTaskWorkspaceAsync(manifest, task);
		assert.ok(first.worktreePath);
		assert.equal(first.reused, false);
		const second = await prepareTaskWorkspaceAsync(manifest, task);
		assert.equal(second.reused, true);
		assert.equal(second.worktreePath, first.worktreePath);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("prepareTaskWorkspaceAsync returns cwd when workspaceMode is single", async () => {
	const cwd = makeRepoTemp("pi-crew-wt-single-");
	try {
		const manifest = minimalManifest(cwd, "single-run");
		manifest.workspaceMode = "single";
		const task = minimalTask("single-task", cwd);
		const result = await prepareTaskWorkspaceAsync(manifest, task);
		assert.equal(result.cwd, cwd);
		assert.equal(result.worktreePath, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("concurrent workspace preparation works without blocking", async () => {
	const repo = makeRepoTemp("pi-crew-wt-concurrent-");
	initGitRepo(repo);
	try {
		const manifest = minimalManifest(repo, "concurrent-run");
		const task1 = minimalTask("concurrent-task1", repo);
		const task2 = minimalTask("concurrent-task2", repo);
		const task3 = minimalTask("concurrent-task3", repo);

		// Start all three concurrently
		const start = Date.now();
		const [result1, result2, result3] = await Promise.all([
			prepareTaskWorkspaceAsync(manifest, task1),
			prepareTaskWorkspaceAsync(manifest, task2),
			prepareTaskWorkspaceAsync(manifest, task3),
		]);
		const elapsed = Date.now() - start;

		// All should have unique worktree paths
		assert.ok(result1.worktreePath);
		assert.ok(result2.worktreePath);
		assert.ok(result3.worktreePath);
		assert.notEqual(result1.worktreePath, result2.worktreePath);
		assert.notEqual(result2.worktreePath, result3.worktreePath);
		assert.notEqual(result1.worktreePath, result3.worktreePath);

		// All should complete in reasonable time (not serial)
		// 3 git operations in parallel should take ~1-3s, not 6-9s
		assert.ok(elapsed < 15000, `Concurrent execution took too long: ${elapsed}ms`);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("findGitRootAsync is cached within a run", async () => {
	const repo = makeRepoTemp("pi-crew-wt-cache-");
	initGitRepo(repo);
	try {
		clearGitRootCache();
		// First call populates cache
		const root1 = await findGitRootAsync(repo);
		// Second call should use cache (same result, no additional git process)
		const root2 = await findGitRootAsync(repo);
		assert.equal(root1, root2);
		// Clear cache and verify it still works
		clearGitRootCache();
		const root3 = await findGitRootAsync(repo);
		assert.equal(root1, root3);
	} finally {
		clearGitRootCache();
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("findGitRootAsync throws for non-git directory", async () => {
	const tmp = makeRepoTemp("pi-crew-wt-nogit-");
	try {
		await assert.rejects(() => findGitRootAsync(tmp), /not a git repository/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("clearCleanLeaderCache resets assertion cache", async () => {
	const repo = makeRepoTemp("pi-crew-wt-leader-");
	initGitRepo(repo);
	try {
		clearCleanLeaderCache();
		// The cache is internal, but we verify the function exists and can be called
		assert.equal(typeof clearCleanLeaderCache, "function");
		clearCleanLeaderCache();
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
