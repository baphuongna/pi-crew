import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../state/types.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { sanitizeEnvSecrets } from "../utils/env-filter.ts";

export interface WorktreeCleanupResult {
	removed: string[];
	preserved: Array<{ path: string; reason: string }>;
	artifactPaths: string[];
	/** Branch names created from dirty worktrees that were committed. */
	committedBranches: string[];
}

const GIT_SAFE_ENV = { ...sanitizeEnvSecrets(process.env, { allowList: ["PATH", "HOME", "USER", "USERPROFILE", "SHELL", "TERM", "LANG", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "NVM_BIN", "NVM_DIR", "NODE_PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "PI_*", "PI_CREW_*"] }), LANG: "C", LC_ALL: "C" };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true }).trim();
}

function isDirty(worktreePath: string): boolean {
	try {
		return git(worktreePath, ["status", "--porcelain"]).trim().length > 0;
	} catch {
		return true;
	}
}

function captureDiff(worktreePath: string): string {
	try {
		return [git(worktreePath, ["status", "--porcelain"]), "", git(worktreePath, ["diff", "--stat"]), "", git(worktreePath, ["diff"])].join("\n");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Failed to capture cleanup diff for ${worktreePath}: ${message}`;
	}
}

export function cleanupRunWorktrees(manifest: TeamRunManifest, options: { force?: boolean; signal?: AbortSignal } = {}): WorktreeCleanupResult {
	const worktreeRoot = path.join(projectCrewRoot(manifest.cwd), DEFAULT_PATHS.state.worktreesSubdir, manifest.runId);
	const result: WorktreeCleanupResult = { removed: [], preserved: [], artifactPaths: [], committedBranches: [] };
	if (!fs.existsSync(worktreeRoot)) return result;

	// M3 fix: use withFileTypes to avoid race between readdirSync and statSync.
	const withFileTypes = fs.readdirSync(worktreeRoot, { withFileTypes: true });
	for (const entry of withFileTypes) {
		if (options.signal?.aborted) break;
		if (!entry.isDirectory()) continue;
		const worktreePath = path.join(worktreeRoot, entry.name);
		try {
			const stat = fs.statSync(worktreePath);
			if (!stat.isDirectory()) continue;
		} catch {
			// Entry deleted between readdir and stat — skip safely.
			continue;
		}
		const dirty = isDirty(worktreePath);
		const branchName = `pi-crew/${manifest.runId}/${entry.name}`;
		if (dirty) {
			// Commit changes to a branch instead of just preserving the worktree
			try {
				execFileSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true });
				let safeDesc = entry.name.slice(0, 200);
				// SECURITY: Strip any newlines that could be injected via a malicious worktree name
				// to prevent newline injection in git commit messages
				if (safeDesc.includes("\n")) {
					safeDesc = safeDesc.replace(/[\r\n]+/g, " ");
				}
				execFileSync("git", ["commit", "-m", `pi-crew: ${safeDesc}`], { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true });
				// Create branch in the main repo pointing to this worktree's HEAD
				try {
					execFileSync("git", ["branch", branchName], { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true });
				} catch {
					// Branch already exists — use timestamp suffix
					const tsBranch = `${branchName}-${Date.now()}`;
					execFileSync("git", ["branch", tsBranch], { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true });
				}
				result.committedBranches.push(branchName);
				// Remove the worktree (branch persists)
				const removeArgs = ["worktree", "remove", "--force", worktreePath];
				git(manifest.cwd, removeArgs);
				result.removed.push(worktreePath);
				const artifact = writeArtifact(manifest.artifactsRoot, {
					kind: "metadata",
					relativePath: `metadata/worktree-branch-${entry.name}.json`,
					content: JSON.stringify({ worktreePath, branch: branchName, committedAt: new Date().toISOString(), mergeCommand: `git merge ${branchName}` }, null, 2),
					producer: "worktree-cleanup",
				});
				result.artifactPaths.push(artifact.path);
			} catch (error) {
				// Fallback to preserving dirty worktree
				const artifact = writeArtifact(manifest.artifactsRoot, {
					kind: "diff",
					relativePath: `cleanup/${entry}.diff`,
					content: captureDiff(worktreePath),
					producer: "worktree-cleanup",
				});
				result.artifactPaths.push(artifact.path);
				result.preserved.push({ path: worktreePath, reason: `dirty worktree preserved (commit failed: ${error instanceof Error ? error.message : String(error)})` });
			}
			continue;
		}
		const args = ["worktree", "remove"];
		if (options.force) args.push("--force");
		args.push(worktreePath);
		try {
			git(manifest.cwd, args);
			result.removed.push(worktreePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.preserved.push({ path: worktreePath, reason: message });
		}
	}

	try {
		if (fs.existsSync(worktreeRoot) && fs.readdirSync(worktreeRoot).length === 0) fs.rmSync(worktreeRoot, { recursive: true, force: true });
	} catch {
		// Non-critical cleanup.
	}
	return result;
}
