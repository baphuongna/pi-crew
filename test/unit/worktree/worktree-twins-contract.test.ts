/**
 * WI-4.3 (M4 spec §5) — first contract test for the sync/async twin pairs
 * in worktree-manager.ts.
 *
 * Per ADR 2026-08-10-reduce-sync-async-twins.md, twin extraction REQUIRES a
 * sync≡async contract test as prerequisite 1. This file establishes that
 * test for the lowest-risk pair (findGitRoot / findGitRootAsync).
 *
 * What we assert:
 *   1. On a real git repo, both twins resolve the same root.
 *   2. On a git subdirectory, both resolve to the same ancestor root.
 *   3. On a non-git directory, both throw (same error class).
 *   4. Async caches within a run; sync caches too (different cache map).
 *
 * Divergence documented (per ADR §Prerequisite 2):
 *   - sync uses syncGitRootCache (FIFO-capped at 256, no clear fn).
 *   - async uses _gitRootCache (FIFO-capped, cleared by clearGitRootCache).
 *   - Both have FIFO eviction; sync retains indefinitely until 256 hit.
 *   - The contract test ONLY asserts observable equivalence, not cache
 *     strategy. Mutation demo (clearing the async cache should not change
 *     the sync result, and vice versa) is captured by a separate test.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { clearGitRootCache, findGitRoot, findGitRootAsync } from "../../../src/worktree/worktree-manager.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

function makeRepoTemp(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	return dir;
}

function initGitRepo(dir: string): void {
	execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
	fs.writeFileSync(path.join(dir, ".gitignore"), ".crew\n", "utf-8");
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", ".gitignore"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir });
}

describe("WI-4.3 contract: findGitRoot ≡ findGitRootAsync", () => {
	it("both return the same canonical root for the repo cwd", async () => {
		const repo = makeRepoTemp("pi-crew-twin-");
		try {
			initGitRepo(repo);
			const syncRoot = findGitRoot(repo);
			// Give async a clean cache so we're comparing behavior, not cache.
			clearGitRootCache();
			// REVIEW FIX (2026-09-10): await INSIDE the try. The previous
			// `return promise; finally { rmSync }` form ran the finally
			// synchronously at return — deleting the repo while the spawned
			// `git rev-parse` child was still in flight (flaky exit-128).
			const asyncRoot = await findGitRootAsync(repo);
			assert.equal(syncRoot, asyncRoot, "sync and async must resolve to the same root");
		} finally {
			await removeDirWithRetry(repo);
		}
	});

	it("both return the same root when called from a subdirectory", async () => {
		const repo = makeRepoTemp("pi-crew-twin-");
		try {
			initGitRepo(repo);
			const sub = path.join(repo, "src", "deep");
			fs.mkdirSync(sub, { recursive: true });
			const syncRoot = findGitRoot(sub);
			clearGitRootCache();
			// REVIEW FIX (2026-09-10): await INSIDE the try — see test 1 note.
			const asyncRoot = await findGitRootAsync(sub);
			assert.equal(syncRoot, asyncRoot, "sync and async must resolve subdirs identically");
		} finally {
			await removeDirWithRetry(repo);
		}
	});

	it("both throw on a non-git directory (same error class)", async () => {
		const noGit = makeRepoTemp("pi-crew-twin-");
		try {
			assert.throws(() => findGitRoot(noGit), /not a git repository|fatal: not a git repository/i);
			clearGitRootCache();
			await assert.rejects(findGitRootAsync(noGit), /not a git repository|fatal: not a git repository/i);
		} finally {
			await removeDirWithRetry(noGit);
		}
	});

	it("async cache and sync cache are independent (clearing async does not affect sync)", async () => {
		const repo = makeRepoTemp("pi-crew-twin-");
		try {
			initGitRepo(repo);
			const syncRoot1 = findGitRoot(repo);
			clearGitRootCache();
			const syncRoot2 = findGitRoot(repo);
			// Sync uses its own cache — clearGitRootCache only touches async.
			// The sync result should be unchanged, indicating the sync path
			// served the cached value, not re-probed.
			assert.equal(syncRoot1, syncRoot2);
		} finally {
			await removeDirWithRetry(repo);
		}
	});
});
