import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { snapshotDirtyWorktree } from "../../src/worktree/worktree-manager.ts";
import { CURRENT_SCHEMA_VERSION } from "../../src/state/types.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

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

/**
 * ST-1: snapshotDirtyWorktree must capture individual files inside untracked
 * directories, base64-encode binary files (not corrupt them), and include
 * tracked binary changes via `git diff HEAD --binary`.
 */
test("ST-1: snapshotDirtyWorktree captures untracked dirs, binary files, and tracked-binary diffs", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}

	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st1-snap-"));
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st1-art-"));
	const worktreePath = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-wt`);

	try {
		// --- Set up a real git repo with an initial commit ---
		gitQuiet(repoRoot, ["init"]);
		gitQuiet(repoRoot, ["config", "user.email", "pi-crew@example.invalid"]);
		gitQuiet(repoRoot, ["config", "user.name", "pi Teams Test"]);
		// Commit a tracked text file
		fs.writeFileSync(path.join(repoRoot, "README.md"), "hello\n", "utf-8");
		// Commit a tracked binary file (original bytes)
		const originalBinary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
		fs.writeFileSync(path.join(repoRoot, "tracked.bin"), originalBinary);
		gitQuiet(repoRoot, ["add", "."]);
		gitQuiet(repoRoot, ["commit", "-m", "initial"]);

		// --- Create a worktree ---
		gitQuiet(repoRoot, ["worktree", "add", worktreePath, "HEAD"]);

		// --- In the worktree, create untracked + dirty state ---
		// 1) Untracked directory with 2 files
		fs.mkdirSync(path.join(worktreePath, "packages", "newmod"), { recursive: true });
		fs.writeFileSync(path.join(worktreePath, "packages", "newmod", "index.ts"), "export const x = 1;\n", "utf-8");
		fs.writeFileSync(path.join(worktreePath, "packages", "newmod", "README.md"), "# newmod\n", "utf-8");

		// 2) Untracked binary file (non-UTF-8 PNG-like header)
		const pngBytes = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
			0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f, 0xc0, 0xde, // arbitrary binary data
		]);
		fs.mkdirSync(path.join(worktreePath, "assets"), { recursive: true });
		fs.writeFileSync(path.join(worktreePath, "assets", "logo.png"), pngBytes);

		// 3) Tracked binary modification
		const modifiedBinary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa]);
		fs.writeFileSync(path.join(worktreePath, "tracked.bin"), modifiedBinary);

		// --- Capture dirty status with -uall (as the fixed callers do) ---
		const dirtyStatus = git(worktreePath, ["status", "--porcelain", "-uall"]);

		// Build minimal manifest + task for the snapshot call
		const manifest = {
			schemaVersion: CURRENT_SCHEMA_VERSION,
			runId: "test-st1-run",
			team: "test",
			goal: "ST-1 test",
			status: "running" as const,
			workspaceMode: "worktree" as const,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			cwd: repoRoot,
			stateRoot: repoRoot,
			artifactsRoot,
			tasksPath: path.join(repoRoot, "tasks.json"),
			eventsPath: path.join(repoRoot, "events.jsonl"),
			artifacts: [],
		} satisfies TeamRunManifest;

		const task = {
			id: "task-st1",
			runId: "test-st1-run",
			role: "agent",
			agent: "default",
			title: "ST-1 snapshot test",
			status: "running" as const,
			dependsOn: [],
			cwd: worktreePath,
		} satisfies TeamTaskState;

		const snapshotOk = snapshotDirtyWorktree(manifest, task, worktreePath, dirtyStatus);

		// snapshotOk guard must be true (no write failure)
		assert.equal(snapshotOk, true, "snapshotDirtyWorktree must report success");

		// --- Find and read the generated snapshot file ---
		const recoveryDir = path.join(artifactsRoot, "worktree-recovery");
		const files = fs.readdirSync(recoveryDir).filter((f) => f.endsWith(".md"));
		assert.equal(files.length, 1, "exactly one recovery snapshot must be written");
		const snapshot = fs.readFileSync(path.join(recoveryDir, files[0]), "utf-8");

		// Assertion 1: untracked dir files are captured (not skipped)
		assert.match(snapshot, /Untracked file: packages\/newmod\/index\.ts/, "dir file index.ts must appear in snapshot");
		assert.match(snapshot, /Untracked file: packages\/newmod\/README\.md/, "dir file README.md must appear in snapshot");
		assert.ok(snapshot.includes("export const x = 1;"), "dir file content must be captured");

		// Assertion 2: untracked binary is base64-encoded, not corrupted
		assert.match(
			snapshot,
			/Untracked file: assets\/logo\.png .*base64-encoded binary/,
			"binary file must be marked as base64-encoded",
		);
		assert.ok(snapshot.includes("```base64"), "binary section must use base64 code fence");
		// Extract the base64 content and verify it round-trips to the original bytes
		const b64Match = snapshot.match(/```base64\n([\s\S]*?)\n```/);
		assert.ok(b64Match, "base64 block must be present");
		const decoded = Buffer.from(b64Match[1].trim(), "base64");
		assert.ok(decoded.equals(pngBytes), "base64-decoded binary must match original bytes exactly");

		// Assertion 3: tracked binary diff includes --binary (GIT binary patch)
		assert.match(snapshot, /Tracked changes/, "tracked changes section must exist");
		assert.ok(
			snapshot.includes("GIT binary patch") || snapshot.includes("Binary files"),
			"tracked binary diff must contain binary patch marker (GIT binary patch)",
		);
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
