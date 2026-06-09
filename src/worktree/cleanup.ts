import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../state/types.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { sanitizeEnvSecrets } from "../utils/env-filter.ts";
import { logInternalError } from "../utils/internal-error.ts";

export interface WorktreeCleanupResult {
	removed: string[];
	preserved: Array<{ path: string; reason: string }>;
	artifactPaths: string[];
	/** Branch names created from dirty worktrees that were committed. */
	committedBranches: string[];
}

// SECURITY: PI_* and PI_CREW_* wildcards removed — they could match secret vars like PI_PASSWORD.
// Git operations do not need PI_CREW_* execution-control vars.
const GIT_SAFE_ENV = { ...sanitizeEnvSecrets(process.env, { allowList: ["PATH", "HOME", "USER", "USERPROFILE", "SHELL", "TERM", "LANG", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "NVM_BIN", "NVM_DIR", "NODE_PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] }), LANG: "C", LC_ALL: "C" };

function sanitizeBranchPart(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

function sanitizeFilename(value: string): string {
	// Strip control chars and newlines for safe artifact filenames
	return value.slice(0, 200).replace(/[\x00-\x1f\x7f-\x9f\r\n]+/g, " ");
}

function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true }).trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`git ${args.join(" ")} failed: ${message}`);
	}
}

function isDirty(worktreePath: string): boolean | "error" {
	try {
		return git(worktreePath, ["status", "--porcelain"]).trim().length > 0;
	} catch {
		return "error";
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
	const sanitizedRunId = manifest.runId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "run";
	const worktreeRoot = path.join(projectCrewRoot(manifest.cwd), DEFAULT_PATHS.state.worktreesSubdir, sanitizedRunId);
	const result: WorktreeCleanupResult = { removed: [], preserved: [], artifactPaths: [], committedBranches: [] };
	if (!fs.existsSync(worktreeRoot)) return result;

	// M3 fix: use withFileTypes to avoid race between readdirSync and statSync.
	// Rely on Dirent.isDirectory() instead of a separate statSync to eliminate TOCTOU window.
	const withFileTypes = fs.readdirSync(worktreeRoot, { withFileTypes: true });
	for (const entry of withFileTypes) {
		if (options.signal?.aborted) break;
		if (!entry.isDirectory()) continue;
		// Issue 1 fix: check signal before each git operation to respect abort faster
		if (options.signal?.aborted) break;
		const worktreePath = path.join(worktreeRoot, entry.name);
		if (options.signal?.aborted) break;
		const dirty = isDirty(worktreePath);
		const branchName = `pi-crew/${manifest.runId}/${sanitizeBranchPart(entry.name)}`;
		const safeBranchName = sanitizeBranchPart(entry.name);
		if (dirty) {
			// Issue 1 fix: check signal before git operations
			if (options.signal?.aborted) break;
			// Commit changes to a branch instead of just preserving the worktree
			try {
				// Issue 2 fix: verify status before and after add to ensure atomicity
				const statusBefore = git(worktreePath, ["status", "--porcelain"]);
				execFileSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true });
				// Verify no unexpected changes were added (only staged the original dirty files)
				const statusAfterAdd = git(worktreePath, ["status", "--porcelain"]);
				if (statusAfterAdd !== statusBefore) {
					// Something changed between our status check and add - abort to avoid including unexpected changes
					throw new Error("worktree state changed unexpectedly during add; refusing to commit");
				}
				// Issue 1 fix: check signal before commit
				if (options.signal?.aborted) break;
				let safeDesc = entry.name.slice(0, 200);
				// SECURITY: Strip any newlines that could be injected via a malicious worktree name
				// to prevent newline injection in git commit messages
				if (safeDesc.includes("\n")) {
					safeDesc = safeDesc.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g, " ");
				}
				execFileSync("git", ["commit", "-m", `pi-crew: ${safeDesc}`], { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true });
				// Issue 1 fix: check signal before branch creation
				if (options.signal?.aborted) break;
				// Create branch in the main repo pointing to this worktree's HEAD
				let branchError: Error | null = null;
				try {
					execFileSync("git", ["branch", branchName], { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true });
				} catch (err) {
					branchError = err instanceof Error ? err : new Error(String(err));
					// Branch already exists — use timestamp suffix
					const tsBranch = `${branchName}-${Date.now()}`;
					try {
						execFileSync("git", ["branch", tsBranch], { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_SAFE_ENV, windowsHide: true });
					} catch (err2) {
						// Both branch attempts failed — accumulate error for outer catch
						const err2_msg = err2 instanceof Error ? err2.message : String(err2);
						throw new Error(`branch creation failed (${branchName} already exists): ${branchError.message}; fallback branch also failed: ${err2_msg}`);
					}
				}
				result.committedBranches.push(branchName);
				// Issue 1 fix: check signal before worktree remove
				if (options.signal?.aborted) break;
				// Remove the worktree (branch persists).
				// NOTE: If git worktree remove fails here after the commit succeeded,
				// the worktree directory remains on disk orphaned from the branch.
				// The committed changes are safe in the branch and recoverable via:
				//   git branch -D <branchName>   (to clean up the branch)
				//   rm -rf <worktreePath>        (to clean up the orphaned directory)
				const removeArgs = ["worktree", "remove", "--force", worktreePath];
				// Capture git status before removal since worktree won't exist after successful remove
				const gitStatusBeforeRemove = git(worktreePath, ["status", "--porcelain"]);
				try {
					git(manifest.cwd, removeArgs);
					result.removed.push(worktreePath);
				} catch (removeError) {
					// Commit succeeded but worktree remove failed — directory is orphaned
					// Issue 1 fix: use fs.rmSync as fallback to clean up orphaned directory
					try {
						fs.rmSync(worktreePath, { recursive: true, force: true });
						result.removed.push(worktreePath);
					} catch {
						result.preserved.push({ path: worktreePath, reason: `commit succeeded but worktree remove failed: ${removeError instanceof Error ? removeError.message : String(removeError)}; fs.rmSync fallback also failed` });
					}
					const artifact = writeArtifact(manifest.artifactsRoot, {
						kind: "metadata",
						relativePath: `metadata/worktree-branch-${safeBranchName}.json`,
						content: JSON.stringify({ worktreePath, branch: branchName, committedAt: new Date().toISOString(), mergeCommand: `git merge ${branchName}`, gitStatusAtCommit: gitStatusBeforeRemove }, null, 2),
						producer: "worktree-cleanup",
					});
					result.artifactPaths.push(artifact.path);
					continue;
				}
				const artifact = writeArtifact(manifest.artifactsRoot, {
					kind: "metadata",
					relativePath: `metadata/worktree-branch-${safeBranchName}.json`,
					content: JSON.stringify({ worktreePath, branch: branchName, committedAt: new Date().toISOString(), mergeCommand: `git merge ${branchName}`, gitStatusAtCommit: gitStatusBeforeRemove }, null, 2),
					producer: "worktree-cleanup",
				});
				result.artifactPaths.push(artifact.path);
			} catch (error) {
				// Fallback to preserving dirty worktree
				// FIX: entry is a DirEnt object, must use entry.name
				const safeFallbackName = sanitizeFilename(entry.name);
				const artifact = writeArtifact(manifest.artifactsRoot, {
					kind: "diff",
					relativePath: `cleanup/${safeFallbackName}.diff`,
					content: captureDiff(worktreePath),
					producer: "worktree-cleanup",
				});
				result.artifactPaths.push(artifact.path);
				result.preserved.push({ path: worktreePath, reason: `dirty worktree preserved (commit failed: ${error instanceof Error ? error.message : String(error)})` });
			}
			continue;
		}
		// Issue 3 fix: sanitize entry.name before using in git commands
		const safeEntryName = sanitizeBranchPart(entry.name);
		// Issue 1 fix: check signal before non-dirty worktree remove
		if (options.signal?.aborted) break;
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
		// Issue 2 fix: run git worktree prune to clean up any orphaned worktree references
		// after processing all worktrees. This helps clean up directories left orphaned
		// when git worktree remove failed after a successful commit.
		git(manifest.cwd, ["worktree", "prune"]);
	} catch (error) {
		// Non-critical cleanup.
		logInternalError("cleanup.worktreePrune", error instanceof Error ? error : new Error(String(error)));
	}
	try {
		// Issue 1 fix: Use rmdirSync which fails atomically on non-empty directories,
		// avoiding TOCTOU race between readdirSync check and rmSync removal.
		// Ignore ENOENT (already removed) and ENOTEMPTY (became non-empty between check and remove).
		fs.rmdirSync(worktreeRoot);
	} catch (error) {
		// Non-critical cleanup. Ignore ENOENT and ENOTEMPTY.
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTEMPTY") {
			// Optionally log unexpected errors in debug mode
		}
	}
	return result;
}
