import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { cleanupAgentWorktree, prepareAgentWorktree } from "../../src/worktree/worktree-manager.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeManifest(cwd: string, runId: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId,
		team: "direct-executor",
		workflow: "direct-agent",
		goal: "ST-15 isolation test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd,
		stateRoot: path.join(cwd, ".crew", "state"),
		artifactsRoot: path.join(cwd, ".crew", "artifacts"),
		tasksPath: path.join(cwd, ".crew", "state", "tasks.json"),
		eventsPath: path.join(cwd, ".crew", "state", "events.jsonl"),
		artifacts: [],
	} as TeamRunManifest;
}

/**
 * ST-15: prepareAgentWorktree must NOT silently drop isolation on the 2nd call.
 * The OLD deterministic branch name (`pi-crew/<runId>/<agentId>`) collided on a
 * 2nd call → caught → returned undefined → silent leader fallback.
 * Fix: non-deterministic suffix so every call yields a distinct worktree.
 */
test("ST-15: prepareAgentWorktree twice for same agent creates DISTINCT worktrees", (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st15-twice-"));
	try {
		// Clean git repo.
		git(cwd, ["init"]);
		git(cwd, ["config", "user.email", "pi-crew@example.invalid"]);
		git(cwd, ["config", "user.name", "pi Teams Test"]);
		fs.writeFileSync(path.join(cwd, "README.md"), "test\n", "utf-8");
		fs.writeFileSync(path.join(cwd, ".gitignore"), ".crew/\n", "utf-8");
		git(cwd, ["add", "README.md", ".gitignore"]);
		git(cwd, ["commit", "-m", "initial"]);

		const manifest = makeManifest(cwd, "st15-twice-run");
		const agentId = "dwf-agent-researcher";

		const first = prepareAgentWorktree(manifest, agentId);
		const second = prepareAgentWorktree(manifest, agentId);

		// Neither should be undefined — isolation must not be silently dropped.
		assert.ok(first, "1st prepareAgentWorktree should create a worktree (got undefined)");
		assert.ok(second, "2nd prepareAgentWorktree should create a worktree (got undefined — ST-15 regression)");

		// Both must be DISTINCT worktrees (not the same path, not the leader repo).
		assert.notEqual(
			first.worktreePath,
			second.worktreePath,
			"2nd worktree path must differ from 1st (non-deterministic name — ST-15 fix)",
		);
		assert.notEqual(first.worktreePath, cwd, "worktree must not be the leader repo");
		assert.notEqual(second.worktreePath, cwd, "worktree must not be the leader repo");

		// Branches must be distinct too.
		assert.notEqual(first.branch, second.branch, "2nd branch must differ from 1st");

		// The worktree dirs must actually exist on disk.
		assert.ok(fs.existsSync(first.worktreePath!), "1st worktree dir should exist");
		assert.ok(fs.existsSync(second.worktreePath!), "2nd worktree dir should exist");

		// Cleanup.
		cleanupAgentWorktree(manifest, first.worktreePath!, first.branch);
		cleanupAgentWorktree(manifest, second.worktreePath!, second.branch);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * ST-15: when worktree CREATION fails (preconditions OK but git/mkdir error),
 * the function must THROW — not return undefined — so callers never silently
 * fall back to the leader repo (isolation lost without any error).
 */
test("ST-15: worktree creation failure THROWS instead of silently returning undefined", (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st15-error-"));
	try {
		git(cwd, ["init"]);
		git(cwd, ["config", "user.email", "pi-crew@example.invalid"]);
		git(cwd, ["config", "user.name", "pi Teams Test"]);
		fs.writeFileSync(path.join(cwd, "README.md"), "test\n", "utf-8");
		fs.writeFileSync(path.join(cwd, ".gitignore"), ".crew/\n", "utf-8");
		git(cwd, ["add", "README.md", ".gitignore"]);
		git(cwd, ["commit", "-m", "initial"]);

		// Force a CREATION-phase failure: make the worktrees subdir a regular FILE
		// so fs.mkdirSync fails (ENOTDIR). The preconditions (git repo exists, clean
		// leader) still pass, so the failure occurs during creation — which must
		// THROW (ST-15) rather than silently returning undefined.
		const crewDir = path.join(cwd, ".crew");
		fs.mkdirSync(crewDir, { recursive: true });
		fs.writeFileSync(path.join(crewDir, "worktrees"), "blocker", "utf-8");

		const manifest = makeManifest(cwd, "st15-error-run");

		assert.throws(
			() => prepareAgentWorktree(manifest, "dwf-agent-fail"),
			/ENOTDIR|EEXIST|not a directory|already exists|mkdir/i,
			"creation failure must THROW, not silently return undefined (ST-15 fix)",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * ST-15 (companion): genuine "worktree unavailable" cases (no git repo) still
 * return undefined for graceful fallback — that contract is preserved.
 */
test("ST-15: no git repo still returns undefined (graceful fallback preserved)", (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st15-nogit-"));
	try {
		// No git init — findGitRoot fails → return undefined.
		const manifest = makeManifest(cwd, "st15-nogit-run");
		const result = prepareAgentWorktree(manifest, "dwf-agent-nogit");
		assert.equal(result, undefined, "no-git-repo should return undefined (graceful fallback preserved)");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
