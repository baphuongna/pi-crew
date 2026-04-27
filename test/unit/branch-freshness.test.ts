import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { checkBranchFreshness, shouldBlockForBranchFreshness } from "../../src/worktree/branch-freshness.ts";

function run(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-branch-"));
	run(dir, ["init", "--quiet", "-b", "main"]);
	run(dir, ["config", "user.email", "test@example.com"]);
	run(dir, ["config", "user.name", "Test"]);
	fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
	run(dir, ["add", "."]);
	run(dir, ["commit", "-m", "initial", "--quiet"]);
	return dir;
}

test("branch freshness detects stale topic branches", () => {
	const dir = repo();
	try {
		run(dir, ["checkout", "-b", "topic"]);
		run(dir, ["checkout", "main"]);
		fs.writeFileSync(path.join(dir, "fix.txt"), "fix\n");
		run(dir, ["add", "."]);
		run(dir, ["commit", "-m", "fix: important", "--quiet"]);
		run(dir, ["checkout", "topic"]);
		const freshness = checkBranchFreshness(dir, "main");
		assert.equal(freshness.status, "stale");
		assert.equal(freshness.behind, 1);
		assert.deepEqual(freshness.missingFixes, ["fix: important"]);
		assert.equal(shouldBlockForBranchFreshness(freshness, "block"), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
