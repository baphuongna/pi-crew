import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("worktree mode supports setup hook metadata and diff stat artifacts", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-worktree-hook-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-worktree-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	try {
		process.env.PI_TEAMS_HOME = home;
		git(cwd, ["init"]);
		git(cwd, ["config", "user.email", "pi-crew@example.invalid"]);
		git(cwd, ["config", "user.name", "pi Teams Test"]);
		fs.writeFileSync(path.join(cwd, "README.md"), "test\n", "utf-8");
		fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\nnode_modules\n", "utf-8");
		fs.mkdirSync(path.join(cwd, "node_modules"));
		git(cwd, ["add", "README.md", ".gitignore"]);
		git(cwd, ["commit", "-m", "initial"]);
		const hook = path.join(cwd, "hook.cjs");
		fs.writeFileSync(hook, "const fs=require('fs'); fs.writeFileSync('generated.txt','x'); console.log(JSON.stringify({syntheticPaths:['generated.txt']}));\n", "utf-8");
		const userConfigDir = path.join(home, ".pi", "agent", "extensions", "pi-crew");
		fs.mkdirSync(userConfigDir, { recursive: true });
		fs.writeFileSync(path.join(userConfigDir, "config.json"), JSON.stringify({ requireCleanWorktreeLeader: false, worktree: { setupHook: hook, linkNodeModules: true } }), "utf-8");
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "Worktree hook smoke", workspaceMode: "worktree" }, { cwd });
		assert.equal(run.isError, false);
		const loaded = loadRunManifestById(cwd, run.details.runId!);
		const diffStat = loaded?.manifest.artifacts.find((artifact) => artifact.path.endsWith(".diff-stat.json"));
		assert.ok(diffStat);
		const stat = JSON.parse(fs.readFileSync(diffStat!.path, "utf-8"));
		assert.deepEqual(stat.syntheticPaths, ["generated.txt"]);
		assert.equal(stat.nodeModulesLinked, true);
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("worktree mode creates task worktrees and exposes them", async (t) => {
	if (!hasGit()) {
		t.skip("git is not available");
		return;
	}
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-worktree-test-"));
	try {
		git(cwd, ["init"]);
		git(cwd, ["config", "user.email", "pi-crew@example.invalid"]);
		git(cwd, ["config", "user.name", "pi Teams Test"]);
		fs.writeFileSync(path.join(cwd, "README.md"), "test\n", "utf-8");
		fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n.crew/\n", "utf-8");
		git(cwd, ["add", "README.md", ".gitignore"]);
		git(cwd, ["commit", "-m", "initial"]);

		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "Worktree smoke", workspaceMode: "worktree" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId!);
		assert.equal(loaded?.manifest.status, "completed");
		assert.ok(loaded?.tasks.every((task) => task.worktree?.path && fs.existsSync(task.worktree.path)));

		const worktrees = await handleTeamTool({ action: "worktrees", runId }, { cwd });
		assert.equal(worktrees.isError, false);
		assert.match(firstText(worktrees), /branch=pi-crew\//);

		const cleanup = await handleTeamTool({ action: "cleanup", runId }, { cwd });
		assert.equal(cleanup.isError, false);
		assert.match(firstText(cleanup), /Removed:/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

