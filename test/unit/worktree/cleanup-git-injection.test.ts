/**
 * MED-1 regression tests — git config/hook injection via worktree cleanup.
 *
 * Attack model (cold-verified): a worker with WRITE access to its worktree can
 * (a) poison config-reachable execution vectors that git honors when the
 * orchestrator runs git with cwd=worktree — core.fsmonitor, core.hooksPath
 * (pre/post-commit, prepare-commit-msg), diff.external / textconv, and
 * filter.<x>.clean driven by a worktree-planted .gitattributes — and
 * (b) hijack the gitdir by rewriting the worktree `.git` pointer file to an
 * attacker-built git dir whose `config` carries the poison.
 *
 * These tests run cleanupRunWorktrees through BOTH paths (non-force preserve
 * and force commit+remove) against poisoned fixtures and assert NO marker file
 * is ever created, plus functional checks (diff artifact / commit still work
 * with benign config).
 *
 * POSIX-only: the marker payloads are /bin/sh scripts. Skipped on win32 per the
 * platform-guard convention (see worktree-async.test.ts); linux + macos CI
 * provide coverage.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import { cleanupRunWorktrees } from "../../../src/worktree/cleanup.ts";
import { prepareTaskWorkspace } from "../../../src/worktree/worktree-manager.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

const POSIX_ONLY = process.platform === "win32" ? "marker-hook fixtures are POSIX /bin/sh scripts" : false;

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
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	fs.writeFileSync(path.join(dir, ".gitignore"), ".crew\n", "utf-8");
	fs.writeFileSync(path.join(dir, "f.txt"), "original\n", "utf-8");
	execFileSync("git", ["add", ".gitignore", "f.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
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

/** Marker-script factory: every created script touches M_<name> when git runs it. */
function makeMarkerFactory() {
	const dir = makeRepoTemp("pi-crew-med1-markers-");
	const marker = (name: string): string => path.join(dir, `M_${name}`);
	const script = (name: string): string => {
		const p = path.join(dir, `${name}.sh`);
		fs.writeFileSync(p, `#!/bin/sh\ntouch '${marker(name)}'\n`, "utf-8");
		fs.chmodSync(p, 0o755);
		return p;
	};
	const resetMarkers = () => {
		for (const e of fs.readdirSync(dir)) if (e.startsWith("M_")) fs.rmSync(path.join(dir, e), { force: true });
	};
	const createdMarkers = (): string[] => fs.readdirSync(dir).filter((e) => e.startsWith("M_"));
	const cleanup = async () => {
		await removeDirWithRetry(dir);
	};
	return { dir, marker, script, resetMarkers, createdMarkers, cleanup };
}

function assertNoMarkers(mk: ReturnType<typeof makeMarkerFactory>, stage: string) {
	const created = mk.createdMarkers();
	assert.deepEqual(created, [], `${stage}: git must not have executed poisoned payloads, got markers: ${created.join(", ")}`);
}

/** Poison the TRUSTED main-repo config (shared by its linked worktrees). */
function poisonRepoConfig(repo: string, mk: ReturnType<typeof makeMarkerFactory>) {
	execFileSync("git", ["config", "core.fsmonitor", mk.script("FSMON")], { cwd: repo });
	execFileSync("git", ["config", "diff.external", mk.script("EXTDIFF")], { cwd: repo });
	execFileSync("git", ["config", "diff.mydrv.textconv", mk.script("TEXTCONV")], { cwd: repo });
	// hooksPath with a full marker-writing hook battery (prepare-commit-msg and
	// post-commit run even under --no-verify — only core.hooksPath= stops them).
	const hooksDir = path.join(mk.dir, "evilhooks");
	fs.mkdirSync(hooksDir, { recursive: true });
	for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit"]) {
		const p = path.join(hooksDir, hook);
		fs.writeFileSync(p, `#!/bin/sh\ntouch '${mk.marker(hook.replace(/-/g, "_").toUpperCase())}'\n`, "utf-8");
		fs.chmodSync(p, 0o755);
	}
	execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: repo });
}

/**
 * Build a full gitdir-hijack fixture: copy the main .git into an attacker dir,
 * poison the COPY's config (including a filter.<x>.clean definition, which only
 * executes when the poisoned config is reachable), and repoint the worktree
 * `.git` pointer file at the copy's worktrees admin dir.
 */
function hijackWorktreeGitdir(repo: string, worktreePath: string, mk: ReturnType<typeof makeMarkerFactory>) {
	const fakeGit = path.join(mk.dir, "fakegit");
	fs.cpSync(path.join(repo, ".git"), fakeGit, { recursive: true, force: true });
	// fs.cpSync preserved the relative commondir ("../..") — it now resolves
	// INSIDE the copy, so the copy's poisoned config is the effective one.
	const poison = [
		"",
		"[core]",
		`\tfsmonitor = ${mk.script("HIJACK_FSMON")}`,
		`\thooksPath = ${path.join(mk.dir, "evilhooks")}`,
		"[diff]",
		`\texternal = ${mk.script("HIJACK_EXTDIFF")}`,
		'[filter "fx"]',
		`\tclean = ${mk.script("HIJACK_FILTER")}`,
		"",
	].join("\n");
	fs.appendFileSync(path.join(fakeGit, "config"), poison, "utf-8");
	// Repoint the worker-writable .git pointer at the fake admin dir.
	const admin = fs.readdirSync(path.join(fakeGit, "worktrees"), { withFileTypes: true }).find((e) => e.isDirectory())?.name;
	assert.ok(admin, "fake git dir must contain the copied worktree admin entry");
	fs.writeFileSync(path.join(worktreePath, ".git"), `gitdir: ${path.join(fakeGit, "worktrees", admin)}\n`, "utf-8");
	// Worktree-side .gitattributes wiring the poisoned filter/diff drivers.
	fs.writeFileSync(path.join(worktreePath, ".gitattributes"), "*.txt filter=fx diff=mydrv\n", "utf-8");
}

test("MED-1: non-force cleanup preserves a dirty worktree WITHOUT executing poisoned fsmonitor/hooks/diff config", {
	skip: POSIX_ONLY,
}, async () => {
	const repo = makeRepoTemp("pi-crew-med1-a-");
	const mk = makeMarkerFactory();
	try {
		initGitRepo(repo);
		const manifest = minimalManifest(repo, "run1");
		const task = minimalTask("task1", repo);
		const prepared = prepareTaskWorkspace(manifest, task);
		const wt = prepared.worktreePath!;
		fs.appendFileSync(path.join(wt, "f.txt"), "worker edit\n", "utf-8"); // dirty
		fs.writeFileSync(path.join(wt, ".gitattributes"), "*.txt diff=mydrv\n", "utf-8");
		poisonRepoConfig(repo, mk);
		mk.resetMarkers();

		const result = cleanupRunWorktrees(manifest, { force: false });

		assert.ok(
			result.preserved.some((p) => p.path === wt),
			"dirty worktree must be preserved",
		);
		assert.equal(result.removed.length, 0);
		assert.ok(fs.existsSync(wt), "worktree dir still exists");
		assertNoMarkers(mk, "non-force poisoned preserve");
		// Functional: the diff artifact still captured the change.
		assert.ok(result.artifactPaths.length > 0, "diff artifact must be written");
		const diffContent = fs.readFileSync(result.artifactPaths[0]!, "utf-8");
		assert.ok(diffContent.includes("f.txt"), `diff artifact must include the change, got: ${diffContent.slice(0, 200)}`);
	} finally {
		await removeDirWithRetry(repo);
		await mk.cleanup();
	}
});

test("MED-1: force cleanup commits+removes WITHOUT running poisoned commit hooks (pre/prepare/post) or fsmonitor", {
	skip: POSIX_ONLY,
}, async () => {
	const repo = makeRepoTemp("pi-crew-med1-b-");
	const mk = makeMarkerFactory();
	try {
		initGitRepo(repo);
		const manifest = minimalManifest(repo, "run1");
		const task = minimalTask("task1", repo);
		const prepared = prepareTaskWorkspace(manifest, task);
		const wt = prepared.worktreePath!;
		fs.appendFileSync(path.join(wt, "f.txt"), "worker edit\n", "utf-8");
		// Pre-stage so the status-before/after-add atomicity check is stable and
		// the commit/branch/remove chain is fully exercised.
		execFileSync("git", ["add", "f.txt"], { cwd: wt });
		poisonRepoConfig(repo, mk);
		mk.resetMarkers();

		const result = cleanupRunWorktrees(manifest, { force: true });

		assert.deepEqual(result.removed, [wt], "dirty worktree must be committed and removed under force");
		assert.deepEqual(result.committedBranches, ["pi-crew/run1/task1"], "recovery branch must be created");
		assert.ok(!fs.existsSync(wt), "worktree dir gone");
		assertNoMarkers(mk, "force poisoned commit path");
		// Functional: the recovery branch holds the commit.
		const tip = execFileSync("git", ["log", "-1", "--format=%s", "pi-crew/run1/task1"], { cwd: repo, encoding: "utf-8" }).trim();
		assert.match(tip, /^pi-crew: task1$/);
	} finally {
		await removeDirWithRetry(repo);
		await mk.cleanup();
	}
});

test("MED-1: benign config — diff artifact and force commit/remove still work (no functional break)", { skip: POSIX_ONLY }, async () => {
	const repo = makeRepoTemp("pi-crew-med1-c-");
	try {
		initGitRepo(repo);
		const manifest = minimalManifest(repo, "run1");
		const task = minimalTask("task1", repo);
		const prepared = prepareTaskWorkspace(manifest, task);
		const wt = prepared.worktreePath!;
		fs.appendFileSync(path.join(wt, "f.txt"), "benign edit\n", "utf-8");
		execFileSync("git", ["add", "f.txt"], { cwd: wt });

		const preserved = cleanupRunWorktrees(manifest, { force: false });
		assert.ok(preserved.preserved.length === 1, "dirty worktree preserved without force");
		const diffContent = fs.readFileSync(preserved.artifactPaths[0]!, "utf-8");
		assert.ok(diffContent.includes("f.txt"), "benign diff artifact contains the change");

		const forced = cleanupRunWorktrees(manifest, { force: true });
		assert.deepEqual(forced.removed, [wt], "force path removes the worktree");
		assert.deepEqual(forced.committedBranches, ["pi-crew/run1/task1"], "force path commits to a branch");
		const tip = execFileSync("git", ["log", "-1", "--format=%s", "pi-crew/run1/task1"], { cwd: repo, encoding: "utf-8" }).trim();
		assert.match(tip, /^pi-crew: task1$/);
	} finally {
		await removeDirWithRetry(repo);
	}
});

test("MED-1: gitdir hijack — non-force cleanup preserves without executing ANY git inside (attack probe proves the poison is live)", {
	skip: POSIX_ONLY,
}, async () => {
	const repo = makeRepoTemp("pi-crew-med1-d-");
	const mk = makeMarkerFactory();
	try {
		initGitRepo(repo);
		const manifest = minimalManifest(repo, "run2");
		const task = minimalTask("task2", repo);
		const prepared = prepareTaskWorkspace(manifest, task);
		const wt = prepared.worktreePath!;
		fs.appendFileSync(path.join(wt, "f.txt"), "worker edit\n", "utf-8"); // dirty
		hijackWorktreeGitdir(repo, wt, mk);

		// ATTACK PROBE: unprotected `git status` inside the hijacked worktree
		// executes the poisoned config (pre-fix behavior). This proves the
		// fixture is a live attack, not a no-op.
		execFileSync("git", ["status", "--porcelain"], { cwd: wt });
		assert.ok(
			mk.createdMarkers().some((m) => m.startsWith("M_HIJACK")),
			`hijack fixture must execute poisoned payloads when unguarded, got: ${mk.createdMarkers().join(", ") || "none"}`,
		);
		mk.resetMarkers();

		const result = cleanupRunWorktrees(manifest, { force: false });

		assert.ok(
			result.preserved.some((p) => p.path === wt && /corrupted|gitdir pointer/i.test(p.reason)),
			"hijacked worktree must be preserved as corrupted",
		);
		assert.equal(result.removed.length, 0, "nothing removed without force");
		assert.ok(fs.existsSync(wt), "hijacked worktree dir still exists for manual inspection");
		assertNoMarkers(mk, "non-force hijack");
	} finally {
		await removeDirWithRetry(repo);
		await mk.cleanup();
	}
});

test("MED-1: gitdir hijack — force cleanup removes ONLY via main-repo git, never executes the poisoned gitdir", {
	skip: POSIX_ONLY,
}, async () => {
	const repo = makeRepoTemp("pi-crew-med1-e-");
	const mk = makeMarkerFactory();
	try {
		initGitRepo(repo);
		const manifest = minimalManifest(repo, "run3");
		const task = minimalTask("task3", repo);
		const prepared = prepareTaskWorkspace(manifest, task);
		const wt = prepared.worktreePath!;
		fs.appendFileSync(path.join(wt, "f.txt"), "worker edit\n", "utf-8");
		hijackWorktreeGitdir(repo, wt, mk);
		mk.resetMarkers();

		const result = cleanupRunWorktrees(manifest, { force: true });

		assert.ok(result.removed.includes(wt), "hijacked worktree must be removed under force (trusted remove/fs fallback)");
		assert.ok(!fs.existsSync(wt), "worktree dir gone");
		assertNoMarkers(mk, "force hijack");
	} finally {
		await removeDirWithRetry(repo);
		await mk.cleanup();
	}
});

test("MED-1: prepareTaskWorkspace refuses to REUSE a hijacked worktree (throws before any git runs inside)", {
	skip: POSIX_ONLY,
}, async () => {
	const repo = makeRepoTemp("pi-crew-med1-f-");
	const mk = makeMarkerFactory();
	try {
		initGitRepo(repo);
		const manifest = minimalManifest(repo, "run4");
		const task = minimalTask("task4", repo);
		const prepared = prepareTaskWorkspace(manifest, task);
		const wt = prepared.worktreePath!;
		hijackWorktreeGitdir(repo, wt, mk);
		mk.resetMarkers();

		assert.throws(() => prepareTaskWorkspace(manifest, task), /gitdir pointer check failed|Refusing to reuse worktree/);
		assertNoMarkers(mk, "reuse guard");
	} finally {
		await removeDirWithRetry(repo);
		await mk.cleanup();
	}
});
