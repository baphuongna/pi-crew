import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/config.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";

export interface PreparedTaskWorkspace {
	cwd: string;
	worktreePath?: string;
	branch?: string;
	reused?: boolean;
	nodeModulesLinked?: boolean;
	syntheticPaths?: string[];
}

export interface WorktreeDiffStat {
	filesChanged: number;
	insertions: number;
	deletions: number;
	diffStat: string;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sanitizeBranchPart(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

export function findGitRoot(cwd: string): string {
	return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export function assertCleanLeader(repoRoot: string): void {
	const status = git(repoRoot, ["status", "--porcelain"]);
	if (status.trim()) {
		throw new Error("Worktree mode requires a clean leader repository. Commit/stash changes or use workspaceMode: 'single'.");
	}
}

function linkNodeModulesIfPresent(repoRoot: string, worktreePath: string): boolean {
	const source = path.join(repoRoot, "node_modules");
	const target = path.join(worktreePath, "node_modules");
	if (!fs.existsSync(source) || fs.existsSync(target)) return false;
	try {
		fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch {
		return false;
	}
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const resolved = path.resolve(worktreePath, rawPath);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`synthetic path escapes worktree: ${rawPath}`);
	return path.normalize(relative);
}

function runSetupHook(manifest: TeamRunManifest, task: TeamTaskState, repoRoot: string, worktreePath: string, branch: string): string[] {
	const cfg = loadConfig(manifest.cwd).config.worktree;
	if (!cfg?.setupHook) return [];
	const hookPath = path.isAbsolute(cfg.setupHook) ? cfg.setupHook : path.resolve(repoRoot, cfg.setupHook);
	if (!fs.existsSync(hookPath) || fs.statSync(hookPath).isDirectory()) throw new Error(`worktree setup hook not found or not a file: ${hookPath}`);
	const nodeHook = hookPath.endsWith(".js") || hookPath.endsWith(".cjs") || hookPath.endsWith(".mjs");
	const result = spawnSync(nodeHook ? process.execPath : hookPath, nodeHook ? [hookPath] : [], {
		cwd: worktreePath,
		encoding: "utf-8",
		input: JSON.stringify({ version: 1, repoRoot, worktreePath, agentCwd: worktreePath, branch, runId: manifest.runId, taskId: task.id, agent: task.agent }),
		timeout: cfg.setupHookTimeoutMs ?? 30_000,
		shell: false,
	});
	if (result.error) throw new Error(`worktree setup hook failed: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`worktree setup hook failed with exit code ${result.status}: ${result.stderr || result.stdout || "no output"}`);
	const trimmed = result.stdout.trim();
	if (!trimmed) return [];
	const parsed = JSON.parse(trimmed) as { syntheticPaths?: unknown };
	if (!Array.isArray(parsed.syntheticPaths)) return [];
	return [...new Set(parsed.syntheticPaths.filter((entry): entry is string => typeof entry === "string").map((entry) => normalizeSyntheticPath(worktreePath, entry)))];
}

export function prepareTaskWorkspace(manifest: TeamRunManifest, task: TeamTaskState): PreparedTaskWorkspace {
	if (manifest.workspaceMode !== "worktree") return { cwd: task.cwd };
	const repoRoot = findGitRoot(manifest.cwd);
	const loadedConfig = loadConfig(manifest.cwd);
	if (loadedConfig.config.requireCleanWorktreeLeader !== false) assertCleanLeader(repoRoot);
	const worktreeRoot = path.join(projectCrewRoot(manifest.cwd), DEFAULT_PATHS.state.worktreesSubdir, manifest.runId);
	fs.mkdirSync(worktreeRoot, { recursive: true });
	const worktreePath = path.join(worktreeRoot, task.id);
	const branch = `pi-crew/${sanitizeBranchPart(manifest.runId)}/${sanitizeBranchPart(task.id)}`;
	if (fs.existsSync(worktreePath)) {
		const currentBranch = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
		if (currentBranch !== branch) {
			throw new Error(`Existing worktree branch mismatch at ${worktreePath}: expected '${branch}', got '${currentBranch}'.`);
		}
		return { cwd: worktreePath, worktreePath, branch, reused: true };
	}
	git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
	const syntheticPaths = runSetupHook(manifest, task, repoRoot, worktreePath, branch);
	const nodeModulesLinked = loadedConfig.config.worktree?.linkNodeModules === true ? linkNodeModulesIfPresent(repoRoot, worktreePath) : false;
	return { cwd: worktreePath, worktreePath, branch, reused: false, nodeModulesLinked, syntheticPaths };
}

export function captureWorktreeDiffStat(worktreePath: string): WorktreeDiffStat {
	try {
		const diffStat = git(worktreePath, ["diff", "--stat"]);
		const numstat = git(worktreePath, ["diff", "--numstat"]);
		let filesChanged = 0;
		let insertions = 0;
		let deletions = 0;
		for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
			const [add, del] = line.split(/\s+/);
			filesChanged += 1;
			insertions += Number(add) || 0;
			deletions += Number(del) || 0;
		}
		return { filesChanged, insertions, deletions, diffStat };
	} catch {
		return { filesChanged: 0, insertions: 0, deletions: 0, diffStat: "" };
	}
}

export function captureWorktreeDiff(worktreePath: string): string {
	try {
		return git(worktreePath, ["diff", "--stat"]) + "\n\n" + git(worktreePath, ["diff"]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Failed to capture worktree diff: ${message}`;
	}
}
