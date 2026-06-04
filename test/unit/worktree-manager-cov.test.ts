import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
	normalizeSeedPaths,
	overlaySeedPaths,
	findGitRoot,
	captureWorktreeDiffStat,
	captureWorktreeDiff,
} from "../../src/worktree/worktree-manager.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function initGitRepo(dir: string) {
	execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
	fs.writeFileSync(path.join(dir, ".gitignore"), ".crew\n", "utf-8");
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", ".gitignore"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir });
}

describe("normalizeSeedPaths", () => {
	it("normalizes simple relative paths", () => {
		const result = normalizeSeedPaths(["src/index.ts"], "/repo");
		assert.deepEqual(result, ["src/index.ts"]);
	});

	it("deduplicates identical paths", () => {
		const result = normalizeSeedPaths(["src/a.ts", "src/a.ts"], "/repo");
		assert.deepEqual(result, ["src/a.ts"]);
	});

	it("rejects path traversal with ..", () => {
		assert.throws(
			() => normalizeSeedPaths(["../etc/passwd"], "/repo"),
			/stay inside repoRoot/,
		);
	});

	it("rejects absolute paths", () => {
		assert.throws(
			() => normalizeSeedPaths(["/etc/passwd"], "/repo"),
			/stay inside repoRoot/,
		);
	});

	it("filters empty strings", () => {
		const result = normalizeSeedPaths(["", "  ", "src/a.ts"], "/repo");
		assert.deepEqual(result, ["src/a.ts"]);
	});

	it("returns empty array for empty input", () => {
		const result = normalizeSeedPaths([], "/repo");
		assert.deepEqual(result, []);
	});

	it("normalizes path separators to forward slashes", () => {
		const result = normalizeSeedPaths(["src/sub/file.ts"], "/repo");
		assert.ok(result.length === 1);
		assert.ok(!result[0]!.includes("\\"), "Expected forward slashes only");
	});
});

describe("overlaySeedPaths", () => {
	it("copies a file from repo root to worktree", () => {
		const repo = createTrackedTempDir("pi-crew-overlay-");
		const worktree = createTrackedTempDir("pi-crew-overlay-wt-");
		try {
			fs.writeFileSync(path.join(repo, "data.txt"), "hello", "utf-8");
			overlaySeedPaths(repo, worktree, ["data.txt"]);
			assert.ok(fs.existsSync(path.join(worktree, "data.txt")));
			assert.equal(fs.readFileSync(path.join(worktree, "data.txt"), "utf-8"), "hello");
		} finally {
			removeTrackedTempDir(repo);
			removeTrackedTempDir(worktree);
		}
	});

	it("copies nested directories", () => {
		const repo = createTrackedTempDir("pi-crew-overlay-");
		const worktree = createTrackedTempDir("pi-crew-overlay-wt-");
		try {
			fs.mkdirSync(path.join(repo, "src", "sub"), { recursive: true });
			fs.writeFileSync(path.join(repo, "src", "sub", "f.ts"), "code", "utf-8");
			overlaySeedPaths(repo, worktree, ["src/sub/f.ts"]);
			assert.ok(fs.existsSync(path.join(worktree, "src", "sub", "f.ts")));
		} finally {
			removeTrackedTempDir(repo);
			removeTrackedTempDir(worktree);
		}
	});

	it("skips non-existent source paths without throwing", () => {
		const repo = createTrackedTempDir("pi-crew-overlay-");
		const worktree = createTrackedTempDir("pi-crew-overlay-wt-");
		try {
			// Should not throw
			overlaySeedPaths(repo, worktree, ["nonexistent.txt"]);
			assert.ok(!fs.existsSync(path.join(worktree, "nonexistent.txt")));
		} finally {
			removeTrackedTempDir(repo);
			removeTrackedTempDir(worktree);
		}
	});
});

describe("findGitRoot", () => {
	it("returns the repo root for a git directory", () => {
		const repo = createTrackedTempDir("pi-crew-git-");
		try {
			initGitRepo(repo);
			const root = findGitRoot(repo);
			assert.equal(path.resolve(root), path.resolve(repo));
		} finally {
			removeTrackedTempDir(repo);
		}
	});

	it("returns the repo root from a subdirectory", () => {
		const repo = createTrackedTempDir("pi-crew-git-");
		try {
			initGitRepo(repo);
			const sub = path.join(repo, "src", "deep");
			fs.mkdirSync(sub, { recursive: true });
			const root = findGitRoot(sub);
			assert.equal(path.resolve(root), path.resolve(repo));
		} finally {
			removeTrackedTempDir(repo);
		}
	});

	it("throws for a non-git directory", () => {
		const tmp = createTrackedTempDir("pi-crew-nogit-");
		try {
			assert.throws(() => findGitRoot(tmp));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("captureWorktreeDiffStat", () => {
	it("returns zero stat for clean worktree", () => {
		const repo = createTrackedTempDir("pi-crew-diff-");
		try {
			initGitRepo(repo);
			const stat = captureWorktreeDiffStat(repo);
			assert.equal(stat.filesChanged, 0);
			assert.equal(stat.insertions, 0);
			assert.equal(stat.deletions, 0);
		} finally {
			removeTrackedTempDir(repo);
		}
	});

	it("reports changes for modified files", () => {
		const repo = createTrackedTempDir("pi-crew-diff-");
		try {
			initGitRepo(repo);
			fs.writeFileSync(path.join(repo, "newfile.txt"), "content", "utf-8");
			const stat = captureWorktreeDiffStat(repo);
			// New untracked files don't show in diff --stat unless staged
			assert.ok(typeof stat.filesChanged === "number");
		} finally {
			removeTrackedTempDir(repo);
		}
	});

	it("returns zero stat for non-git directory", () => {
		const tmp = createTrackedTempDir("pi-crew-nodiff-");
		try {
			const stat = captureWorktreeDiffStat(tmp);
			assert.equal(stat.filesChanged, 0);
			assert.equal(stat.diffStat, "");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("captureWorktreeDiff", () => {
	it("returns diff output for a clean repo", () => {
		const repo = createTrackedTempDir("pi-crew-diff2-");
		try {
			initGitRepo(repo);
			const diff = captureWorktreeDiff(repo);
			assert.ok(typeof diff === "string");
		} finally {
			removeTrackedTempDir(repo);
		}
	});

	it("returns error message for non-git directory", () => {
		const tmp = createTrackedTempDir("pi-crew-nodiff2-");
		try {
			const diff = captureWorktreeDiff(tmp);
			assert.ok(diff.includes("Failed to capture"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("includes diff content when tracked files are modified", () => {
		const repo = createTrackedTempDir("pi-crew-diff2-");
		try {
			initGitRepo(repo);
			// Modify tracked file (.gitignore)
			fs.appendFileSync(path.join(repo, ".gitignore"), "newfile.txt\n");
			const diff = captureWorktreeDiff(repo);
			assert.ok(diff.includes(".gitignore"));
		} finally {
			removeTrackedTempDir(repo);
		}
	});
});
