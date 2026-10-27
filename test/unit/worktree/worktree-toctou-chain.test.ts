/**
 * R-A3 (MED-1 follow-up, 2026-10-26) — per-command gitdir re-verify kills
 * the TOCTOU window.
 *
 * The entry-level verifyWorktreeGitdirPointer in cleanupRunWorktrees runs
 * ONCE per worktree, but the force chain then executes many git commands
 * inside it — a still-live worker can flip the `.git` pointer AFTER the entry
 * check passed. The git() helpers in cleanup.ts / worktree-manager.ts now
 * re-verify the pointer before EVERY command whose cwd sits inside a linked
 * worktree and abort the chain on mismatch.
 *
 * Deterministic mid-chain flip vehicle (no mock seam needed): the KNOWN
 * RESIDUAL of MED-1 — a `filter.<x>.clean` DEFINITION in a genuinely trusted
 * config (here: GIT_CONFIG_GLOBAL pointed at a test config, which the
 * sanitized env forwards by design) executes during `git status`/`git add`
 * when the worktree's `.gitattributes` assigns the filter. The flip script
 * rewrites the pointer at the attacker-built poisoned gitdir MID-CHAIN; the
 * next guarded command must abort the chain with ZERO execution of the
 * poisoned gitdir's config (no M_HIJACK_* markers).
 *
 * POSIX-only: payloads are /bin/sh scripts.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { cleanupRunWorktrees } from "../../../src/worktree/cleanup.ts";
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

test("R-A3: pointer flipped MID-CHAIN aborts the force-cleanup sequence with no further worktree git", {
	skip: POSIX_ONLY,
}, async (t) => {
	const repo = makeRepoTemp("pi-crew-ra3-a-");
	const mkDir = makeRepoTemp("pi-crew-ra3-markers-");
	try {
		initGitRepo(repo);
		const runId = "ra3run";
		// cleanupRunWorktrees scans <projectCrewRoot>/worktrees/<runId> (see
		// DEFAULT_PATHS.state.worktreesSubdir — joined directly under .crew/).
		const worktreeRoot = path.join(repo, ".crew", "worktrees", runId);
		fs.mkdirSync(worktreeRoot, { recursive: true });
		const wt = path.join(worktreeRoot, "task1");
		execFileSync("git", ["worktree", "add", "-q", wt, "-b", `pi-crew/${runId}/task1`, "HEAD"], { cwd: repo });
		fs.appendFileSync(path.join(wt, "f.txt"), "worker edit\n", "utf-8"); // dirty → chain enters the force path
		fs.writeFileSync(path.join(wt, ".gitattributes"), "*.txt filter=fx\n", "utf-8");

		// Attacker-built poisoned gitdir (the flip target). Its config must
		// NEVER execute — M_HIJACK_* proves a violation.
		const fakeGit = path.join(mkDir, "fakegit");
		fs.cpSync(path.join(repo, ".git"), fakeGit, { recursive: true, force: true });
		const admin = fs.readdirSync(path.join(fakeGit, "worktrees"), { withFileTypes: true }).find((e) => e.isDirectory())?.name;
		assert.ok(admin, "fake git dir must contain the copied worktree admin entry");
		const poison = ["", "[core]", `\tfsmonitor = touch ${mkDir}/M_HIJACK_FSMON`, `\thooksPath = ${mkDir}/evilhooks`, ""].join("\n");
		fs.appendFileSync(path.join(fakeGit, "config"), poison, "utf-8");

		// Mid-chain flip vehicle: a filter.fx.clean definition in a TRUSTED
		// config (GIT_CONFIG_GLOBAL — forwarded by the sanitized env by
		// design, documented MED-1 residual). The clean filter runs when git
		// hashes the modified f.txt during status/add — i.e. BETWEEN guarded
		// commands of the cleanup chain.
		const flipSh = path.join(mkDir, "flip.sh");
		fs.writeFileSync(
			flipSh,
			`#!/bin/sh\ncat > /dev/null\nprintf 'flipped\\n'\ntouch ${mkDir}/M_FLIP\nprintf 'gitdir: ${path.join(fakeGit, "worktrees", admin)}\\n' > ${wt}/.git\n`,
			"utf-8",
		);
		fs.chmodSync(flipSh, 0o755);
		const globalConfig = path.join(mkDir, "gitconfig-global");
		fs.writeFileSync(globalConfig, `[filter "fx"]\n\tclean = ${flipSh}\n\tsmudge = cat\n`, "utf-8");
		const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = globalConfig;
		t.after(() => {
			if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
		});

		const result = cleanupRunWorktrees(minimalManifest(repo, runId), { force: true });

		// The flip MUST have fired mid-chain (proves the TOCTOU scenario was
		// exercised for real, not skipped).
		assert.ok(fs.existsSync(path.join(mkDir, "M_FLIP")), "mid-chain flip must have executed (clean filter ran)");
		// …and the poisoned gitdir must NEVER have executed: the chain aborted
		// at the first guarded command AFTER the flip.
		const hijackMarkers = fs.readdirSync(mkDir).filter((e) => e.startsWith("M_HIJACK"));
		assert.deepEqual(hijackMarkers, [], `no poisoned payload may run after the flip, got: ${hijackMarkers.join(", ")}`);
		// Chain aborted: nothing committed, nothing removed, worktree preserved.
		assert.deepEqual(result.committedBranches, [], "chain must abort before commit");
		assert.equal(result.removed.length, 0, "chain must abort before worktree removal");
		assert.ok(
			result.preserved.some((p) => p.path === wt && /worktree corrupted|gitdir pointer|commit failed/i.test(p.reason)),
			`worktree must be preserved with a corrupted/aborted reason, got: ${JSON.stringify(result.preserved)}`,
		);
		assert.ok(fs.existsSync(wt), "worktree dir still exists for manual inspection");
	} finally {
		await removeDirWithRetry(repo);
		await removeDirWithRetry(mkDir);
	}
});
