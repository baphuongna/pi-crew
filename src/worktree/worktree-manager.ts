import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/config.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { sanitizeEnvSecrets } from "../utils/env-filter.ts";
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
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LANG: "C", LC_ALL: "C" }, windowsHide: true }).trim();
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
	let sourceStat: fs.Stats;
	try { sourceStat = fs.statSync(source); } catch { return false; }
	if (!sourceStat.isDirectory()) return false;
	if (fs.existsSync(target)) return false;
		// M5 fix: log symlink failure reason, especially on Windows non-admin.
	try {
		fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch (error) {
		const isWindows = process.platform === "win32";
		logInternalError("worktree.symlink-fail", error, isWindows ? "Windows non-admin: SeCreateSymbolicLinkPrivilege needed for node_modules symlink" : String(error));
		return false;
	}
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const resolved = path.resolve(worktreePath, rawPath);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`synthetic path escapes worktree: ${rawPath}`);
	return path.normalize(relative);
}

/**
 * Validates that a worktree setupHook script path is within an allowed directory.
 * Allowed paths:
 * - Relative paths starting with ".hooks/" (case-sensitive)
 * - Absolute paths under $HOME/.pi/hooks/
 * Rejects all other paths to prevent arbitrary script execution.
 * @param hookPath - The hook script path to validate
 * @returns true if the path is allowed, false otherwise
 */
	function isAllowedSetupHook(hookPath: string): boolean {
		if (!hookPath || hookPath.trim().length === 0) return false;
		if (!path.isAbsolute(hookPath)) {
			// Use path.posix.normalize for consistent forward-slash handling on all platforms.
			const normalized = path.posix.normalize(hookPath);
			return normalized === ".hooks" || normalized.startsWith(".hooks/");
		}
		// Normalize to forward slashes for consistent cross-platform comparison.
		const normalizedHookPath = hookPath.replace(/\\/g, "/");
		const homeHooksNormalized = (process.env.HOME ?? "").replace(/\\/g, "/") + "/.pi/hooks";
		return normalizedHookPath === homeHooksNormalized || normalizedHookPath.startsWith(homeHooksNormalized + "/");
	}

function runSetupHook(manifest: TeamRunManifest, task: TeamTaskState, repoRoot: string, worktreePath: string, branch: string): string[] {
	const cfg = loadConfig(manifest.cwd).config.worktree;
	if (!cfg?.setupHook) return [];
	const rawHookPath = cfg.setupHook;
	if (!isAllowedSetupHook(rawHookPath)) {
		logInternalError("worktree.setupHook.rejected", new Error("hook path not allowed: " + rawHookPath), `cwd=${manifest.cwd}`);
		return [];
	}
	const hookPath = path.isAbsolute(rawHookPath) ? rawHookPath : path.resolve(repoRoot, rawHookPath);
	if (!fs.existsSync(hookPath) || fs.statSync(hookPath).isDirectory()) {
		logInternalError("worktree.setupHook.missing", new Error("hook not found or is directory: " + hookPath), `cwd=${manifest.cwd}`);
		return [];
	}
	const nodeHook = hookPath.endsWith(".js") || hookPath.endsWith(".cjs") || hookPath.endsWith(".mjs");
	// On Windows, set shell:true to ensure PATH resolution and .cjs/.bat file associations work.
	const useShell = process.platform === "win32";
	const result = spawnSync(nodeHook ? process.execPath : hookPath, nodeHook ? [hookPath] : [], {
		cwd: worktreePath,
		encoding: "utf-8",
		input: JSON.stringify({ version: 1, repoRoot, worktreePath, agentCwd: worktreePath, branch, runId: manifest.runId, taskId: task.id, agent: task.agent }),
		timeout: cfg.setupHookTimeoutMs ?? 30_000,
		shell: useShell,
		env: sanitizeEnvSecrets(process.env, {
			allowList: ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "PI_*"],
		}),
		windowsHide: true,
	});
	if (result.error) throw new Error(`worktree setup hook failed: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`worktree setup hook failed with exit code ${result.status}: ${result.stderr || result.stdout || "no output"}`);
	const trimmed = result.stdout.trim();
	if (!trimmed) return [];
	try {
		// Extract JSON — hooks may output debug logging before JSON.
	// M4 fix: try full trimmed (multi-line JSON object) before falling back to last line.
	const lines = trimmed.split(/\r?\n/);
	let parsed: { syntheticPaths?: unknown } | null = null;
	try {
		parsed = JSON.parse(trimmed) as { syntheticPaths?: unknown };
	} catch { /* fall through — try last line */ }
	if (!parsed && lines.length > 0) {
		const lastLine = lines[lines.length - 1];
		try { parsed = JSON.parse(lastLine) as { syntheticPaths?: unknown }; } catch { /* give up */ }
	}
	if (!parsed || !Array.isArray(parsed.syntheticPaths)) return [];
	return [...new Set(parsed.syntheticPaths.filter((entry): entry is string => typeof entry === "string").map((entry) => normalizeSyntheticPath(worktreePath, entry)))];
	} catch (error) {
		logInternalError("worktree.setupHook.parse", error, `lastLine=${(trimmed.split(/\r?\n/).pop() ?? "").slice(0, 200)}`);
		return [];
	}
}

function branchExists(repoRoot: string, branch: string): { local: boolean; remoteOnly: boolean } {
	let local = false;
	try { git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]); local = true; } catch {}
	if (local) return { local: true, remoteOnly: false };
	// Check remote-tracking branch
	try {
		const out = execFileSync("git", ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${branch}`],
			{ cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
		return { local: false, remoteOnly: out.length > 0 };
	} catch { return { local: false, remoteOnly: false }; }
}

function pruneStaleWorktrees(repoRoot: string): void {
	try { execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore" }); }
	catch { /* best-effort */ }
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
		let currentBranch: string;
		try {
			currentBranch = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
		} catch (gitError) {
			throw new Error(`Existing worktree at ${worktreePath} is not a valid git repository; cannot verify branch: ${gitError instanceof Error ? gitError.message : String(gitError)}`);
		}
		if (currentBranch !== branch) {
			throw new Error(`Existing worktree branch mismatch at ${worktreePath}: expected '${branch}', got '${currentBranch}'.`);
		}
		return { cwd: worktreePath, worktreePath, branch, reused: true };
	}
	pruneStaleWorktrees(repoRoot);
	const exists = branchExists(repoRoot, branch);
	try {
		if (exists.local) {
			git(repoRoot, ["worktree", "add", worktreePath, branch]);
		} else {
			if (exists.remoteOnly) {
				logInternalError("worktree.branchRemoteOnly", new Error(`Branch '${branch}' exists only on remote; creating local from HEAD instead of tracking remote.`), `branch=${branch}`);
			}
			git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (/already checked out|is already used by worktree/i.test(msg)) {
			throw new Error(`Branch '${branch}' is checked out at another worktree. Run \`team cleanup runId=${manifest.runId} force=true\` or manually remove the conflicting worktree.`);
		}
		throw error;
	}
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
