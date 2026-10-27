/**
 * R-A1 (MED-1 follow-up, 2026-10-26) — gitdir-pointer guard INSIDE the
 * capture functions.
 *
 * Attack model (empirically verified, see the probe below): a worker plants
 * `.gitattributes` wiring `filter=fx` in its worktree and repoints the
 * worktree `.git` pointer at an attacker-built gitdir whose config defines
 * `filter.fx.clean = <payload>`. Raw `git diff` / `git diff --stat` / `git
 * status --porcelain` run the clean filter when they hash modified content,
 * so the captureWorktreeDiff / captureWorktreeDiffStat families used to
 * EXECUTE the payload in the orchestrator context. hardenGitArgs cannot help
 * here (there is no --no-filters for diff), so the pointer guard now runs
 * INSIDE every capture function: mismatch → NO git at all + fail-safe empty
 * result.
 *
 * POSIX-only: payloads are /bin/sh scripts (platform-guard convention, see
 * cleanup-git-injection.test.ts).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	captureWorktreeDiff,
	captureWorktreeDiffAsync,
	captureWorktreeDiffStat,
	captureWorktreeDiffStatAsync,
} from "../../../src/worktree/worktree-manager.ts";
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

/** Marker-script factory: every payload touches M_<name> when git runs it. */
function makeMarkerFactory() {
	const dir = makeRepoTemp("pi-crew-ra1-markers-");
	const marker = (name: string): string => path.join(dir, `M_${name}`);
	const script = (name: string): string => {
		const p = path.join(dir, `${name}.sh`);
		fs.writeFileSync(p, `#!/bin/sh\nprintf 'x'\ntouch '${marker(name)}'\n`, "utf-8");
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

/** Build a worktree + hijack its `.git` pointer at a poisoned fake gitdir. */
function buildHijackedWorktreeFixture(repo: string, mk: ReturnType<typeof makeMarkerFactory>) {
	const wt = path.join(repo, "wt-ra1");
	execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd: repo });
	fs.appendFileSync(path.join(wt, "f.txt"), "worker edit\n", "utf-8"); // modified → clean filter engages
	const fakeGit = path.join(mk.dir, "fakegit");
	fs.cpSync(path.join(repo, ".git"), fakeGit, { recursive: true, force: true });
	// fs.cpSync preserved the relative commondir ("../..") — it resolves INSIDE
	// the copy, so the copy's poisoned config is the effective one.
	const poison = [
		"",
		"[core]",
		`\tfsmonitor = ${mk.script("HIJACK_FSMON")}`,
		'[filter "fx"]',
		`\tclean = ${mk.script("HIJACK_FILTER")}`,
		`\tsmudge = cat`,
		"",
	].join("\n");
	fs.appendFileSync(path.join(fakeGit, "config"), poison, "utf-8");
	const admin = fs.readdirSync(path.join(fakeGit, "worktrees"), { withFileTypes: true }).find((e) => e.isDirectory())?.name;
	assert.ok(admin, "fake git dir must contain the copied worktree admin entry");
	fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(fakeGit, "worktrees", admin)}\n`, "utf-8");
	fs.writeFileSync(path.join(wt, ".gitattributes"), "*.txt filter=fx\n", "utf-8");
	return wt;
}

test("R-A1: capture functions run NO git inside a filter-hijacked worktree (attack probe proves the fixture is live)", {
	skip: POSIX_ONLY,
}, async () => {
	const repo = makeRepoTemp("pi-crew-ra1-a-");
	const mk = makeMarkerFactory();
	try {
		initGitRepo(repo);
		const wt = buildHijackedWorktreeFixture(repo, mk);

		// ATTACK PROBE: raw `git diff` in the hijacked worktree executes the
		// poisoned filter (pre-fix behavior) — proves the fixture is a live
		// attack, not a no-op.
		execFileSync("git", ["diff"], { cwd: wt, stdio: ["ignore", "ignore", "ignore"] });
		assert.ok(
			mk.createdMarkers().includes("M_HIJACK_FILTER"),
			`hijack fixture must execute the clean filter when unguarded, got: ${mk.createdMarkers().join(", ") || "none"}`,
		);
		mk.resetMarkers();

		// Guarded captures: fail-safe results, ZERO payload execution.
		const diff = await captureWorktreeDiffAsync(wt);
		assert.equal(diff, "", "captureWorktreeDiffAsync must return an empty diff on guard failure");
		assertNoMarkers(mk, "captureWorktreeDiffAsync");

		const stat = await captureWorktreeDiffStatAsync(wt);
		assert.deepEqual(stat, { filesChanged: 0, insertions: 0, deletions: 0, diffStat: "" });
		assertNoMarkers(mk, "captureWorktreeDiffStatAsync");

		assert.equal(captureWorktreeDiff(wt), "", "sync captureWorktreeDiff must return an empty diff on guard failure");
		assertNoMarkers(mk, "captureWorktreeDiff sync");

		assert.deepEqual(captureWorktreeDiffStat(wt), { filesChanged: 0, insertions: 0, deletions: 0, diffStat: "" });
		assertNoMarkers(mk, "captureWorktreeDiffStat sync");
	} finally {
		await removeDirWithRetry(repo);
		await mk.cleanup();
	}
});

test("R-A1: benign worktree — captures still work through the guard (no functional break)", { skip: POSIX_ONLY }, async () => {
	const repo = makeRepoTemp("pi-crew-ra1-b-");
	try {
		initGitRepo(repo);
		const wt = path.join(repo, "wt-benign");
		execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd: repo });
		fs.appendFileSync(path.join(wt, "f.txt"), "benign edit\n", "utf-8");

		const diff = await captureWorktreeDiffAsync(wt);
		assert.match(diff, /f\.txt/, "benign diff must still be captured");
		const stat = await captureWorktreeDiffStatAsync(wt);
		assert.equal(stat.filesChanged, 1);
		assert.match(captureWorktreeDiff(wt), /f\.txt/);
		assert.equal(captureWorktreeDiffStat(wt).filesChanged, 1);
	} finally {
		await removeDirWithRetry(repo);
	}
});
