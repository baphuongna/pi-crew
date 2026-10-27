/**
 * MED-1 unit tests — git-hardening helpers.
 *
 * Covers the pure argv builder (hardenGitArgs) plus the trusted gitdir
 * resolution and the gitdir-hijack pointer verification against REAL git
 * worktree fixtures (cross-platform: plain fs + git, no shell scripts).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	assertWorktreePointerTrusted,
	GIT_HARDEN_CONFIG_ARGS,
	hardenGitArgs,
	resolveTrustedGitDir,
	verifyWorktreeGitdirPointer,
	worktreeTrustCheck,
} from "../../../src/worktree/git-hardening.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

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

/**
 * Rewrite a worktree `.git` pointer file win32-safely.
 *
 * Git for Windows marks the pointer file HIDDEN (`core.hideDotFiles` defaults
 * to `dotGitOnly`, which covers a file named exactly `.git`), and libuv opens
 * O_CREAT|O_TRUNC files with CreateFile CREATE_ALWAYS — Windows refuses that
 * open with EPERM when the existing file carries an attribute the new open
 * does not request (long-standing nodejs/node#3331 family). `chmodSync` is
 * useless here: on win32 it only clears the READ-ONLY bit, never the hidden
 * bit. The safe universal shape is delete + recreate (a fresh file carries no
 * attributes). Same path, same content, identical semantics on POSIX.
 */
function writeGitPointer(worktreeRoot: string, content: string): void {
	const dotGit = path.join(worktreeRoot, ".git");
	try {
		fs.unlinkSync(dotGit);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	fs.writeFileSync(dotGit, content, "utf-8");
}

// --- hardenGitArgs (pure) ---

test("hardenGitArgs prefixes every command with the config-injection overrides", () => {
	const out = hardenGitArgs(["status", "--porcelain"]);
	assert.deepEqual(out.slice(0, GIT_HARDEN_CONFIG_ARGS.length), [...GIT_HARDEN_CONFIG_ARGS]);
	assert.equal(out[out.length - 1], "--porcelain");
	assert.ok(out.includes("status"));
});

test("hardenGitArgs appends --no-textconv --no-ext-diff to diff subcommands", () => {
	for (const args of [["diff"], ["diff", "--stat"], ["diff", "HEAD", "--binary"], ["diff", "--numstat"]]) {
		const out = hardenGitArgs([...args]);
		assert.ok(out.includes("--no-textconv"), `--no-textconv missing for: ${args.join(" ")}`);
		assert.ok(out.includes("--no-ext-diff"), `--no-ext-diff missing for: ${args.join(" ")}`);
		assert.ok(!out.includes("--no-verify"), `--no-verify must not leak into diff: ${args.join(" ")}`);
	}
});

test("hardenGitArgs appends --no-verify to commit", () => {
	const out = hardenGitArgs(["commit", "-m", "pi-crew: x"]);
	assert.ok(out.includes("--no-verify"));
	assert.ok(!out.includes("--no-textconv"), "--no-textconv must not leak into commit");
	assert.ok(!out.includes("--no-ext-diff"), "--no-ext-diff must not leak into commit");
});

test("hardenGitArgs detects the subcommand after leading -c pairs", () => {
	// Real shape used by worktree-manager.ts: ["-c", "core.quotePath=false", "status", ...]
	const out = hardenGitArgs(["-c", "core.quotePath=false", "status", "--porcelain", "-uall"]);
	assert.ok(out.includes("status"));
	assert.ok(!out.includes("--no-textconv"), "status is not a diff — no textconv flag");
	const diffOut = hardenGitArgs(["-c", "core.quotePath=false", "diff"]);
	assert.ok(diffOut.includes("--no-textconv"));
});

test("hardenGitArgs leaves non-diff/non-commit commands otherwise intact", () => {
	const out = hardenGitArgs(["worktree", "remove", "--force", "/tmp/x"]);
	assert.deepEqual(out, [...GIT_HARDEN_CONFIG_ARGS, "worktree", "remove", "--force", "/tmp/x"]);
});

// --- R-A8: global options that take a SEPARATE value must not be mistaken
// for the subcommand (their value previously masked diff/commit detection). ---

test("R-A8: hardenGitArgs detects diff after -C <dir> and --git-dir <dir>", () => {
	for (const args of [
		["-C", "/tmp/some-dir", "diff", "--stat"],
		["--git-dir", "/g", "diff"],
		["--work-tree", "/w", "--namespace", "ns", "diff", "--numstat"],
	]) {
		const out = hardenGitArgs([...args]);
		assert.ok(out.includes("--no-textconv"), `--no-textconv missing for: ${args.join(" ")}`);
		assert.ok(out.includes("--no-ext-diff"), `--no-ext-diff missing for: ${args.join(" ")}`);
	}
});

test("R-A8: hardenGitArgs detects commit after -C <dir> and --git-dir <dir>", () => {
	for (const args of [
		["-C", "/repo", "commit", "-m", "x"],
		["--git-dir", "/g", "commit", "-m", "x"],
	]) {
		const out = hardenGitArgs([...args]);
		assert.ok(out.includes("--no-verify"), `--no-verify missing for: ${args.join(" ")}`);
		assert.ok(!out.includes("--no-textconv"), `textconv must not leak into commit: ${args.join(" ")}`);
	}
});

test("R-A8: value-less global options keep status detection; inline = forms still skipped", () => {
	// A directory-value global option followed by status must NOT gain commit/diff flags.
	const out = hardenGitArgs(["-C", "/repo", "status", "--porcelain"]);
	assert.ok(!out.includes("--no-verify"), "status is not a commit");
	assert.ok(!out.includes("--no-textconv"), "status is not a diff");
	// Inline = forms were already handled and stay handled.
	const inline = hardenGitArgs(["--work-tree=/w", "diff"]);
	assert.ok(inline.includes("--no-textconv"), "inline-value global option must not mask the subcommand");
});

// --- R-A3: assertWorktreePointerTrusted / worktreeTrustCheck ---

test("R-A3: assertWorktreePointerTrusted is a no-op for repo roots and non-git dirs, throws on hijack", async () => {
	const repo = makeRepoTemp("pi-crew-gh-ra3-");
	try {
		initGitRepo(repo);
		// Repo root + nested dir → trusted main-repo context.
		assert.doesNotThrow(() => assertWorktreePointerTrusted(repo));
		const nested = path.join(repo, "a");
		fs.mkdirSync(nested, { recursive: true });
		assert.doesNotThrow(() => assertWorktreePointerTrusted(nested));
		assert.deepEqual(worktreeTrustCheck(repo).kind, "repo");
		// Genuine worktree → no throw.
		const wt = path.join(repo, "wt-ra3");
		execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd: repo });
		assert.doesNotThrow(() => assertWorktreePointerTrusted(wt));
		// Subdir inside the worktree → anchored at the worktree root, still ok.
		fs.mkdirSync(path.join(wt, "sub"), { recursive: true });
		assert.doesNotThrow(() => assertWorktreePointerTrusted(path.join(wt, "sub")));
		// Hijack → throws worktree-corrupted.
		writeGitPointer(wt, "gitdir: /tmp/evil\n");
		assert.throws(() => assertWorktreePointerTrusted(wt), /worktree corrupted/);
		assert.throws(() => assertWorktreePointerTrusted(path.join(wt, "sub")), /worktree corrupted/);
		// Restore, then a plain non-git dir → no-git, no throw.
		const plain = makeRepoTemp("pi-crew-gh-ra3-nogit-");
		try {
			assert.deepEqual(worktreeTrustCheck(plain).kind, "no-git");
			assert.doesNotThrow(() => assertWorktreePointerTrusted(plain));
		} finally {
			await removeDirWithRetry(plain);
		}
	} finally {
		await removeDirWithRetry(repo);
	}
});

// --- resolveTrustedGitDir + verifyWorktreeGitdirPointer (real fixtures) ---

test("resolveTrustedGitDir resolves the .git dir, walks up, and returns undefined outside a repo", async () => {
	const repo = makeRepoTemp("pi-crew-gh-");
	try {
		initGitRepo(repo);
		const gitDir = resolveTrustedGitDir(repo);
		assert.ok(gitDir, "git dir must resolve");
		assert.ok(fs.existsSync(path.join(gitDir!, "config")), "resolved dir must be a git dir (has config)");
		// Walk-up from a nested dir
		const nested = path.join(repo, "a", "b");
		fs.mkdirSync(nested, { recursive: true });
		assert.equal(resolveTrustedGitDir(nested), gitDir);
		// Non-git temp dir
		const plain = makeRepoTemp("pi-crew-gh-nogit-");
		try {
			assert.equal(resolveTrustedGitDir(plain), undefined);
		} finally {
			await removeDirWithRetry(plain);
		}
	} finally {
		await removeDirWithRetry(repo);
	}
});

test("verifyWorktreeGitdirPointer accepts a genuine registered worktree", async () => {
	const repo = makeRepoTemp("pi-crew-gh-ok-");
	try {
		initGitRepo(repo);
		const gitDir = resolveTrustedGitDir(repo)!;
		const wt = path.join(repo, "wt-a");
		execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd: repo });
		const check = verifyWorktreeGitdirPointer(wt, gitDir);
		assert.equal(check.ok, true, `genuine worktree must pass: ${check.reason}`);
	} finally {
		await removeDirWithRetry(repo);
	}
});

test("verifyWorktreeGitdirPointer rejects a hijacked pointer, .git directory, and unregistered dirs", async () => {
	const repo = makeRepoTemp("pi-crew-gh-bad-");
	try {
		initGitRepo(repo);
		const gitDir = resolveTrustedGitDir(repo)!;
		const wt = path.join(repo, "wt-b");
		execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd: repo });

		// 1. hijack: repoint .git at an attacker-built directory
		const evil = path.join(repo, "evil-gitdir");
		fs.mkdirSync(evil, { recursive: true });
		fs.writeFileSync(path.join(evil, "HEAD"), "ref: refs/heads/main\n", "utf-8");
		const originalPointer = fs.readFileSync(path.join(wt, ".git"), "utf-8");
		writeGitPointer(wt, `gitdir: ${evil}\n`);
		let check = verifyWorktreeGitdirPointer(wt, gitDir);
		assert.equal(check.ok, false, "hijacked pointer must fail");
		assert.match(check.reason, /does not match the registered gitdir|hijack/);

		// 2. restore pointer, then replace .git FILE with a DIRECTORY → fail
		writeGitPointer(wt, originalPointer);
		fs.renameSync(path.join(wt, ".git"), path.join(wt, ".git-pointer-backup"));
		fs.mkdirSync(path.join(wt, ".git"), { recursive: true });
		check = verifyWorktreeGitdirPointer(wt, gitDir);
		assert.equal(check.ok, false, ".git directory must fail");
		fs.rmSync(path.join(wt, ".git"), { recursive: true, force: true });
		fs.renameSync(path.join(wt, ".git-pointer-backup"), path.join(wt, ".git"));

		// 3. a plain unregistered directory under the repo → fail
		const stranger = path.join(repo, "not-a-worktree");
		fs.mkdirSync(stranger, { recursive: true });
		check = verifyWorktreeGitdirPointer(stranger, gitDir);
		assert.equal(check.ok, false, "unregistered dir must fail");
		assert.match(check.reason, /not a registered worktree/);
	} finally {
		await removeDirWithRetry(repo);
	}
});

test("verifyWorktreeGitdirPointer follows git's uniquified admin names (same basename, different parents)", async () => {
	// git names the admin dir task9 then task91 for two worktrees with the same
	// basename — the guard must resolve via the registry, never via basename.
	const repo = makeRepoTemp("pi-crew-gh-admin-");
	try {
		initGitRepo(repo);
		const gitDir = resolveTrustedGitDir(repo)!;
		fs.mkdirSync(path.join(repo, "runs", "r1"), { recursive: true });
		fs.mkdirSync(path.join(repo, "runs", "r2"), { recursive: true });
		const wt1 = path.join(repo, "runs", "r1", "task9");
		const wt2 = path.join(repo, "runs", "r2", "task9");
		execFileSync("git", ["worktree", "add", "-q", wt1, "HEAD"], { cwd: repo });
		execFileSync("git", ["worktree", "add", "-q", wt2, "HEAD"], { cwd: repo });
		assert.equal(verifyWorktreeGitdirPointer(wt1, gitDir).ok, true, "first worktree must pass");
		assert.equal(verifyWorktreeGitdirPointer(wt2, gitDir).ok, true, "second (uniquified admin) worktree must pass");
	} finally {
		await removeDirWithRetry(repo);
	}
});

test("verifyWorktreeGitdirPointer rejects a symlinked .git pointer", {
	skip: process.platform === "win32" ? "symlink creation needs privileges on Windows CI" : false,
}, async () => {
	const repo = makeRepoTemp("pi-crew-gh-sym-");
	try {
		initGitRepo(repo);
		const gitDir = resolveTrustedGitDir(repo)!;
		const wt = path.join(repo, "wt-sym");
		execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd: repo });
		fs.renameSync(path.join(wt, ".git"), path.join(wt, ".git-real"));
		fs.symlinkSync(".git-real", path.join(wt, ".git"), "file");
		const check = verifyWorktreeGitdirPointer(wt, gitDir);
		assert.equal(check.ok, false, "symlinked .git pointer must fail");
		assert.match(check.reason, /symlink/);
	} finally {
		await removeDirWithRetry(repo);
	}
});
