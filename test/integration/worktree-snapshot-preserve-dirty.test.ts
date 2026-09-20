import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import {
	clearCleanLeaderCache,
	clearGitRootCache,
	prepareTaskWorkspace,
	prepareTaskWorkspaceAsync,
	snapshotDirtyWorktree,
} from "../../src/worktree/worktree-manager.ts";

/**
 * RR-010 / F01 regression tests — "incomplete backup ⇒ original bytes survive".
 *
 * A dirty worktree being reused must NOT be cleaned (`git checkout -- .` +
 * `git clean -fd`) unless the recovery snapshot is COMPLETE or the caller
 * explicitly passes `force` (AGENTS.md rule 40).
 */

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function gitQuiet(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

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
	// .crew holds pi-crew worktrees + artifacts — must be ignored so the leader stays clean.
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
		goal: "F01 regression",
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
		title: "F01 regression task",
		dependsOn: [],
		cwd,
		runId: "run_test",
	};
}

/** Concatenate every worktree-recovery snapshot artifact written under artifactsRoot. */
function readRecoverySnapshots(artifactsRoot: string): string {
	const recoveryDir = path.join(artifactsRoot, "worktree-recovery");
	if (!fs.existsSync(recoveryDir)) return "";
	const files = fs.readdirSync(recoveryDir).filter((f) => f.endsWith(".md"));
	return files.map((f) => fs.readFileSync(path.join(recoveryDir, f), "utf-8")).join("\n--\n");
}

const BIG_FILE_BYTES = 307200; // 300 KiB — larger than the 256 KiB snapshot cap.

test("F01 Case A (async): untracked file > 256 KiB survives worktree reuse (AC1/AC10)", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const repo = makeRepoTemp("pi-crew-f01-a-");
	initGitRepo(repo);
	try {
		const manifest = minimalManifest(repo, "f01-async-run");
		const task = minimalTask("f01-async-task", repo);
		const first = await prepareTaskWorkspaceAsync(manifest, task);
		assert.equal(first.reused, false, "first call must create the worktree");
		assert.ok(first.worktreePath);

		// Dirty state: one untracked file LARGER than the 256 KiB snapshot cap.
		const big = Buffer.alloc(BIG_FILE_BYTES);
		for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
		const bigPath = path.join(first.worktreePath, "big-untracked.bin");
		fs.writeFileSync(bigPath, big);

		const second = await prepareTaskWorkspaceAsync(manifest, task);
		assert.equal(second.reused, true, "second call must reuse the worktree");

		// AC1: the snapshot is incomplete (truncated) ⇒ cleanup must NOT run.
		assert.ok(fs.existsSync(bigPath), "big-untracked.bin must STILL EXIST after reuse — cleanup must not run on incomplete snapshot");
		assert.ok(big.equals(fs.readFileSync(bigPath)), "original bytes must be byte-identical after reuse");

		// AC10: the artifact being written is NOT proof of a complete backup —
		// artifact exists AND the original file survives in the same assertion set.
		const snapshots = readRecoverySnapshots(manifest.artifactsRoot);
		assert.ok(snapshots.length > 0, "a recovery snapshot artifact must still be written");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
		clearCleanLeaderCache();
		clearGitRootCache();
	}
});

test("F01 Case B (async): chmod 000 file survives reuse AND is named in the artifact (AC3)", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	if (process.platform === "win32") {
		t.skip("chmod 000 cannot be simulated on Windows");
		return;
	}
	const repo = makeRepoTemp("pi-crew-f01-b-");
	initGitRepo(repo);
	try {
		const manifest = minimalManifest(repo, "f01-chmod-run");
		const task = minimalTask("f01-chmod-task", repo);
		const first = await prepareTaskWorkspaceAsync(manifest, task);
		assert.ok(first.worktreePath);

		const secretPath = path.join(first.worktreePath, "secret.txt");
		fs.writeFileSync(secretPath, "top secret payload — 111 bytes of unrecoverable text if lost\n", "utf-8");
		fs.chmodSync(secretPath, 0o000);
		// Precondition: chmod must actually deny reads (root CI containers ignore it).
		let unreadable = false;
		try {
			fs.readFileSync(secretPath);
		} catch {
			unreadable = true;
		}
		if (!unreadable) {
			t.skip("chmod 000 did not make the file unreadable (running as root?)");
			return;
		}

		const second = await prepareTaskWorkspaceAsync(manifest, task);
		assert.equal(second.reused, true, "second call must reuse the worktree");

		// AC3: an unreadable entry must not lead to deletion.
		assert.ok(fs.existsSync(secretPath), "secret.txt must STILL EXIST after reuse — unreadable entry must not be destroyed");
		const snapshots = readRecoverySnapshots(manifest.artifactsRoot);
		assert.ok(snapshots.includes("secret.txt"), `artifact must NAME the skipped entry with a reason (AC3); got:\n${snapshots}`);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
		clearCleanLeaderCache();
		clearGitRootCache();
	}
});

test("F01 Case C (sync): untracked file > 256 KiB survives worktree reuse (AC8)", (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const repo = makeRepoTemp("pi-crew-f01-c-");
	initGitRepo(repo);
	try {
		const manifest = minimalManifest(repo, "f01-sync-run");
		const task = minimalTask("f01-sync-task", repo);
		const first = prepareTaskWorkspace(manifest, task);
		assert.equal(first.reused, false, "first call must create the worktree");
		assert.ok(first.worktreePath);

		const big = Buffer.alloc(BIG_FILE_BYTES);
		for (let i = 0; i < big.length; i++) big[i] = (i * 17 + 3) & 0xff;
		const bigPath = path.join(first.worktreePath, "big-untracked.bin");
		fs.writeFileSync(bigPath, big);

		const second = prepareTaskWorkspace(manifest, task);
		assert.equal(second.reused, true, "second call must reuse the worktree");

		assert.ok(
			fs.existsSync(bigPath),
			"big-untracked.bin must STILL EXIST after sync reuse — cleanup must not run on incomplete snapshot",
		);
		assert.ok(big.equals(fs.readFileSync(bigPath)), "original bytes must be byte-identical after sync reuse");
		assert.ok(readRecoverySnapshots(manifest.artifactsRoot).length > 0, "recovery artifact must still be written (sync path)");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
		clearCleanLeaderCache();
		clearGitRootCache();
	}
});

test("F01 Case D (async): explicit force=true discards dirty worktree despite incomplete snapshot (AC7)", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const repo = makeRepoTemp("pi-crew-f01-d-");
	initGitRepo(repo);
	try {
		const manifest = minimalManifest(repo, "f01-force-run");
		const task = minimalTask("f01-force-task", repo);
		const first = await prepareTaskWorkspaceAsync(manifest, task);
		assert.ok(first.worktreePath);
		const bigPath = path.join(first.worktreePath, "big-untracked.bin");
		fs.writeFileSync(bigPath, Buffer.alloc(BIG_FILE_BYTES));

		// force is the explicit per-call escape hatch (AGENTS.md rule 40).
		const second = await prepareTaskWorkspaceAsync(manifest, task, undefined, { force: true });
		assert.equal(second.reused, true);
		assert.ok(!fs.existsSync(bigPath), "force=true must still discard the dirty worktree (file removed by clean)");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
		clearCleanLeaderCache();
		clearGitRootCache();
	}
});

test("F01 AC2: snapshotDirtyWorktree returns a structured result — truncated entry is named with its original size", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const repoRoot = makeRepoTemp("pi-crew-f01-ac2-");
	const artifactsRoot = makeRepoTemp("pi-crew-f01-ac2art-");
	const worktreePath = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-wt`);
	try {
		gitQuiet(repoRoot, ["init"]);
		gitQuiet(repoRoot, ["config", "user.email", "pi-crew@example.invalid"]);
		gitQuiet(repoRoot, ["config", "user.name", "pi Teams Test"]);
		fs.writeFileSync(path.join(repoRoot, "README.md"), "hello\n", "utf-8");
		gitQuiet(repoRoot, ["add", "."]);
		gitQuiet(repoRoot, ["commit", "-m", "initial"]);
		gitQuiet(repoRoot, ["worktree", "add", worktreePath, "HEAD"]);

		fs.writeFileSync(path.join(worktreePath, "big-untracked.bin"), Buffer.alloc(BIG_FILE_BYTES));
		const dirtyStatus = git(worktreePath, ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"]);

		const manifest = minimalManifest(repoRoot, "f01-ac2-run");
		manifest.artifactsRoot = artifactsRoot;
		const task = minimalTask("f01-ac2-task", worktreePath);

		const result = snapshotDirtyWorktree(manifest, task, worktreePath, dirtyStatus);
		assert.equal(result.complete, false, "truncation must make the snapshot incomplete");
		assert.equal(result.truncated.length, 1, "the over-cap file must be listed exactly once");
		assert.equal(result.truncated[0].path, "big-untracked.bin");
		assert.equal(result.truncated[0].originalSize, BIG_FILE_BYTES, "originalSize must be the on-disk size, not the truncated size");
		assert.deepEqual(result.skipped, [], "no entry was skipped in this fixture");
		assert.equal(result.trackedDiffError, undefined, "tracked diff capture must succeed in a real repo");
		assert.equal(result.writeError, undefined, "artifact write must succeed");

		// The 256 KiB preview cap is KEPT by design — the artifact still holds a
		// truncated preview with an explicit note (not silent).
		const snapshots = readRecoverySnapshots(artifactsRoot);
		assert.ok(snapshots.includes("big-untracked.bin"), "artifact must still contain the truncated preview");
		assert.ok(snapshots.includes(`truncated: ${BIG_FILE_BYTES} → 262144 bytes`), "truncation note must state original → capped size");
	} finally {
		try {
			gitQuiet(repoRoot, ["worktree", "remove", "--force", worktreePath]);
		} catch {
			/* best-effort */
		}
		fs.rmSync(repoRoot, { recursive: true, force: true });
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
		fs.rmSync(worktreePath, { recursive: true, force: true });
	}
});

test("F01 AC2/AC3: snapshotDirtyWorktree marks a chmod 000 entry as skipped and names it in the artifact", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	if (process.platform === "win32") {
		t.skip("chmod 000 cannot be simulated on Windows");
		return;
	}
	const repoRoot = makeRepoTemp("pi-crew-f01-skip-");
	const artifactsRoot = makeRepoTemp("pi-crew-f01-skipart-");
	const worktreePath = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-wt`);
	try {
		gitQuiet(repoRoot, ["init"]);
		gitQuiet(repoRoot, ["config", "user.email", "pi-crew@example.invalid"]);
		gitQuiet(repoRoot, ["config", "user.name", "pi Teams Test"]);
		fs.writeFileSync(path.join(repoRoot, "README.md"), "hello\n", "utf-8");
		gitQuiet(repoRoot, ["add", "."]);
		gitQuiet(repoRoot, ["commit", "-m", "initial"]);
		gitQuiet(repoRoot, ["worktree", "add", worktreePath, "HEAD"]);

		const secretPath = path.join(worktreePath, "secret.txt");
		fs.writeFileSync(secretPath, "unreadable secret\n", "utf-8");
		fs.chmodSync(secretPath, 0o000);
		let unreadable = false;
		try {
			fs.readFileSync(secretPath);
		} catch {
			unreadable = true;
		}
		if (!unreadable) {
			t.skip("chmod 000 did not make the file unreadable (running as root?)");
			return;
		}

		const dirtyStatus = git(worktreePath, ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"]);
		const manifest = minimalManifest(repoRoot, "f01-skip-run");
		manifest.artifactsRoot = artifactsRoot;
		const task = minimalTask("f01-skip-task", worktreePath);

		const result = snapshotDirtyWorktree(manifest, task, worktreePath, dirtyStatus);
		assert.equal(result.complete, false, "a skipped entry must make the snapshot incomplete");
		assert.ok(
			result.skipped.some((s) => s.path === "secret.txt"),
			`skipped must contain secret.txt; got: ${JSON.stringify(result.skipped)}`,
		);
		assert.ok(result.skipped[0].reason.length > 0, "skip reason must be recorded");

		const snapshots = readRecoverySnapshots(artifactsRoot);
		assert.ok(snapshots.includes("secret.txt"), `artifact must NAME the skipped entry (AC3); got:\n${snapshots}`);
	} finally {
		try {
			fs.chmodSync(path.join(worktreePath, "secret.txt"), 0o644);
		} catch {
			/* best-effort */
		}
		try {
			gitQuiet(repoRoot, ["worktree", "remove", "--force", worktreePath]);
		} catch {
			/* best-effort */
		}
		fs.rmSync(repoRoot, { recursive: true, force: true });
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
		fs.rmSync(worktreePath, { recursive: true, force: true });
	}
});
