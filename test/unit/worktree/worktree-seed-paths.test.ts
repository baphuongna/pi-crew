import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { WorkflowStep } from "../../../src/workflows/workflow-config.ts";
import { normalizeSeedPaths, overlaySeedPaths } from "../../../src/worktree/worktree-manager.ts";

describe("normalizeSeedPaths", () => {
	// Use temp dir so normalizeSeedPaths can verify files exist (ENOENT → skip).
	let repoRoot: string;
	beforeEach(() => {
		repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "seed-norm-"));
	});
	afterEach(() => {
		fs.rmSync(repoRoot, { force: true, recursive: true });
	});

	it("rejects path traversal", () => {
		assert.throws(() => normalizeSeedPaths(["../../etc/passwd"], repoRoot), /must stay inside repoRoot/);
	});

	it("rejects absolute paths", () => {
		assert.throws(() => normalizeSeedPaths(["/etc/passwd"], repoRoot), /must stay inside repoRoot/);
	});

	it("normalizes separators to forward slashes", () => {
		fs.mkdirSync(path.join(repoRoot, "foo"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "foo/bar.txt"), "x");
		const result = normalizeSeedPaths(["foo/bar.txt"], repoRoot);
		assert.equal(result[0], "foo/bar.txt");
	});

	it("deduplicates entries", () => {
		fs.writeFileSync(path.join(repoRoot, "a.txt"), "x");
		fs.writeFileSync(path.join(repoRoot, "b.txt"), "x");
		const result = normalizeSeedPaths(["a.txt", "a.txt", "b.txt"], repoRoot);
		assert.deepEqual(result, ["a.txt", "b.txt"]);
	});

	it("skips empty and whitespace-only entries", () => {
		fs.writeFileSync(path.join(repoRoot, "a.txt"), "x");
		const result = normalizeSeedPaths(["", "  ", "a.txt"], repoRoot);
		assert.deepEqual(result, ["a.txt"]);
	});

	it("returns empty array for empty input", () => {
		assert.deepEqual(normalizeSeedPaths([], repoRoot), []);
	});

	it("returns empty array for non-array input", () => {
		assert.deepEqual(normalizeSeedPaths(null as any, repoRoot), []);
	});
});

describe("overlaySeedPaths", () => {
	let tmpDir: string;
	let repoRoot: string;
	let worktreePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-test-"));
		repoRoot = path.join(tmpDir, "repo");
		worktreePath = path.join(tmpDir, "worktree");
		fs.mkdirSync(repoRoot, { recursive: true });
		fs.mkdirSync(worktreePath, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true });
	});

	it("copies a file from repoRoot to worktreePath", () => {
		fs.writeFileSync(path.join(repoRoot, "plan.json"), '{"test": true}');
		overlaySeedPaths(repoRoot, worktreePath, ["plan.json"]);
		assert.ok(fs.existsSync(path.join(worktreePath, "plan.json")));
		assert.equal(fs.readFileSync(path.join(worktreePath, "plan.json"), "utf8"), '{"test": true}');
	});

	it("copies a directory recursively", () => {
		fs.mkdirSync(path.join(repoRoot, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "scripts", "run.sh"), "#!/bin/bash");
		overlaySeedPaths(repoRoot, worktreePath, ["scripts"]);
		assert.ok(fs.existsSync(path.join(worktreePath, "scripts", "run.sh")));
	});

	it("creates parent directories in worktree", () => {
		fs.mkdirSync(path.join(repoRoot, "deep", "nested"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(repoRoot, "deep", "nested", "file.txt"), "content");
		overlaySeedPaths(repoRoot, worktreePath, ["deep/nested/file.txt"]);
		assert.ok(fs.existsSync(path.join(worktreePath, "deep", "nested", "file.txt")));
	});

	it("is no-op with empty seedPaths", () => {
		overlaySeedPaths(repoRoot, worktreePath, []);
		// Should not throw or create anything
		const entries = fs.readdirSync(worktreePath);
		assert.equal(entries.length, 0);
	});

	it("overwrites existing files in worktree", () => {
		fs.writeFileSync(path.join(repoRoot, "config.json"), '{"v": 2}');
		fs.writeFileSync(path.join(worktreePath, "config.json"), '{"v": 1}');
		overlaySeedPaths(repoRoot, worktreePath, ["config.json"]);
		assert.equal(fs.readFileSync(path.join(worktreePath, "config.json"), "utf8"), '{"v": 2}');
	});
});

// W6 fix (seedpaths-dest-symlink-ancestor): the destination must be resolved
// through an O_NOFOLLOW ancestor walk rooted at the worktree BEFORE the
// rmSync/cpSync — a symlinked component under the worktree (repo-committed
// symlink materialized by `git worktree add`, or worker-planted and surviving
// a reused worktree) previously redirected the destructive operations to an
// attacker-chosen host path OUTSIDE the worktree.
describe("overlaySeedPaths destination-side symlink guard (W6)", () => {
	let tmpDir: string;
	let repoRoot: string;
	let worktreePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-dest-w6-"));
		repoRoot = path.join(tmpDir, "repo");
		worktreePath = path.join(tmpDir, "worktree");
		fs.mkdirSync(repoRoot, { recursive: true });
		fs.mkdirSync(worktreePath, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true });
	});

	it("refuses a seed whose destination ANCESTOR is a symlink — host-side victim survives, symlink untouched", () => {
		// The PoC shape: worktree/d -> <outside>/victim; seedPath 'd/victim.txt'
		// previously rmSync'd the HOST file through the symlinked ancestor.
		const outsideDir = path.join(tmpDir, "victim");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "victim.txt"), "HOST-VICTIM");
		fs.symlinkSync(outsideDir, path.join(worktreePath, "d"), "dir");
		// Seed source must exist in the repo (normalizeSeedPaths validates it).
		fs.mkdirSync(path.join(repoRoot, "d"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "d", "victim.txt"), "SEED");

		overlaySeedPaths(repoRoot, worktreePath, ["d/victim.txt"]);

		assert.equal(
			fs.readFileSync(path.join(outsideDir, "victim.txt"), "utf8"),
			"HOST-VICTIM",
			"host-side victim must NOT be deleted through the symlinked destination ancestor",
		);
		assert.ok(
			fs.lstatSync(path.join(worktreePath, "d")).isSymbolicLink(),
			"the planted destination symlink itself must be left untouched",
		);
		assert.ok(!fs.existsSync(path.join(worktreePath, "seed-marker.txt")), "no seed content written anywhere else");
	});

	it("refuses a seed whose destination LEAF is a symlink — host-side victim survives", () => {
		const outsideFile = path.join(tmpDir, "host-file.txt");
		fs.writeFileSync(outsideFile, "HOST-VICTIM");
		fs.symlinkSync(outsideFile, path.join(worktreePath, "link.txt"), "file");
		fs.writeFileSync(path.join(repoRoot, "link.txt"), "SEED");

		overlaySeedPaths(repoRoot, worktreePath, ["link.txt"]);

		assert.equal(
			fs.readFileSync(outsideFile, "utf8"),
			"HOST-VICTIM",
			"host-side file must NOT be overwritten through the destination symlink",
		);
		assert.ok(
			fs.lstatSync(path.join(worktreePath, "link.txt")).isSymbolicLink(),
			"the destination symlink itself must be left untouched",
		);
	});

	it("control: normal (non-symlink) destinations still copy, overwrite and create parents", () => {
		fs.writeFileSync(path.join(repoRoot, "plan.json"), "{}");
		fs.mkdirSync(path.join(repoRoot, "deep"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "deep", "nested.txt"), "nested-content");
		fs.writeFileSync(path.join(worktreePath, "plan.json"), "old");

		overlaySeedPaths(repoRoot, worktreePath, ["plan.json", "deep/nested.txt"]);

		assert.equal(fs.readFileSync(path.join(worktreePath, "plan.json"), "utf8"), "{}");
		assert.equal(fs.readFileSync(path.join(worktreePath, "deep", "nested.txt"), "utf8"), "nested-content");
	});
});

describe("per-step seedPaths merging", () => {
	let repoRoot: string;
	beforeEach(() => {
		repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "seed-merge-"));
	});
	afterEach(() => {
		fs.rmSync(repoRoot, { force: true, recursive: true });
	});

	function makeStep(seedPaths?: string[]): WorkflowStep {
		return { id: "s1", role: "executor", task: "do it", seedPaths };
	}

	it("merges global + step seedPaths without duplicates", () => {
		for (const f of ["shared.txt", "config.json", "step-file.txt"]) {
			fs.writeFileSync(path.join(repoRoot, f), "x");
		}
		const global = ["shared.txt", "config.json"];
		const step = [makeStep(["step-file.txt", "config.json"])];
		const merged = normalizeSeedPaths([...global, ...(step[0].seedPaths ?? [])], repoRoot);
		assert.deepEqual(merged, ["shared.txt", "config.json", "step-file.txt"]);
	});

	it("works with step-level only (no global)", () => {
		fs.writeFileSync(path.join(repoRoot, "step-only.txt"), "x");
		const step = [makeStep(["step-only.txt"])];
		const merged = normalizeSeedPaths([...(step[0].seedPaths ?? [])], repoRoot);
		assert.deepEqual(merged, ["step-only.txt"]);
	});

	it("works with global only (no step seedPaths)", () => {
		fs.writeFileSync(path.join(repoRoot, "shared.txt"), "x");
		const global = ["shared.txt"];
		const step = [makeStep()];
		const merged = normalizeSeedPaths([...global, ...(step[0].seedPaths ?? [])], repoRoot);
		assert.deepEqual(merged, ["shared.txt"]);
	});

	it("both empty yields empty", () => {
		const merged = normalizeSeedPaths([], repoRoot);
		assert.deepEqual(merged, []);
	});
});
