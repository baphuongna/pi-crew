import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { writeArtifact } from "../state/stores/artifact-store.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import {
	assertWorktreePointerTrusted,
	buildGitSafeEnv,
	hardenGitArgs,
	resolveTrustedGitDir,
	verifyWorktreeGitdirPointer,
} from "./git-hardening.ts";

export interface WorktreeCleanupResult {
	removed: string[];
	preserved: Array<{ path: string; reason: string }>;
	artifactPaths: string[];
	/** Branch names created from dirty worktrees that were committed. */
	committedBranches: string[];
}

// MED-1 / R-A4: shared sanitized env for every git spawn (see
// buildGitSafeEnv in git-hardening.ts — allowList-based secret stripping,
// GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_SYSTEM dropped from the allowlist,
// GIT_CONFIG_GLOBAL kept for commit identity with the documented residual
// that trusted-config filter definitions remain executable).
// Built per call (not module-load) so late env changes (tests, config reload)
// are honored.
function gitSafeEnv(): Record<string, string> {
	return buildGitSafeEnv();
}

function sanitizeBranchPart(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._/-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "task"
	);
}

function sanitizeFilename(value: string): string {
	// Strip control chars and newlines for safe artifact filenames
	return value.slice(0, 200).replace(/[\x00-\x1f\x7f-\x9f\r\n]+/g, " ");
}

function git(cwd: string, args: string[]): string {
	// R-A3: re-verify the gitdir pointer before EVERY command whose cwd sits
	// inside a linked worktree (TOCTOU: the entry-level guard in
	// cleanupRunWorktrees can be invalidated by a still-live worker flipping
	// the `.git` pointer mid-chain). Throws OUTSIDE the execFile try so the
	// error propagates unwrapped into the existing "corrupted" handling paths.
	assertWorktreePointerTrusted(cwd);
	try {
		// MED-1: harden EVERY git invocation (config-injection overrides +
		// diff/commit neutralizers). See src/worktree/git-hardening.ts.
		return execFileSync("git", hardenGitArgs(args), {
			cwd,
			env: gitSafeEnv(),
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		}).trim();
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
		return [
			git(worktreePath, ["status", "--porcelain"]),
			"",
			git(worktreePath, ["diff", "--stat"]),
			"",
			git(worktreePath, ["diff"]),
		].join("\n");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Failed to capture cleanup diff for ${worktreePath}: ${message}`;
	}
}

export function cleanupRunWorktrees(
	manifest: TeamRunManifest,
	options: { force?: boolean; signal?: AbortSignal } = {},
): WorktreeCleanupResult {
	const sanitizedRunId = manifest.runId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "run";
	const worktreeRoot = path.join(projectCrewRoot(manifest.cwd), DEFAULT_PATHS.state.worktreesSubdir, sanitizedRunId);
	const result: WorktreeCleanupResult = {
		removed: [],
		preserved: [],
		artifactPaths: [],
		committedBranches: [],
	};
	if (!fs.existsSync(worktreeRoot)) return result;
	// MED-1: resolve the TRUSTED git common dir once (from the orchestrator-owned
	// main repo — never from inside a worktree) for the per-entry gitdir guard.
	const trustedGitDir = resolveTrustedGitDir(manifest.cwd);

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
		// MED-1 gitdir-hijack guard: a worker can rewrite the worktree `.git`
		// pointer file to an attacker-controlled directory whose poisoned `config`
		// would execute hooks/filters/fsmonitor in the orchestrator context. Before
		// ANY git runs with cwd inside the worktree, the pointer must resolve to the
		// git-registered admin dir (see src/worktree/git-hardening.ts). On mismatch
		// NO git runs from inside; removal is only attempted (force) from the
		// trusted main-repo cwd, and the worktree is otherwise preserved.
		const gitdirCheck = trustedGitDir
			? verifyWorktreeGitdirPointer(worktreePath, trustedGitDir)
			: { ok: false, reason: `main repository git dir not found under ${manifest.cwd}` };
		if (!gitdirCheck.ok) {
			logInternalError(
				"cleanup.worktree.gitdirMismatch",
				new Error(`Refusing to run git inside ${worktreePath}: ${gitdirCheck.reason}`),
				`runId=${manifest.runId}`,
			);
			if (options.force) {
				let removed = false;
				try {
					git(manifest.cwd, ["worktree", "remove", "--force", worktreePath]);
					removed = true;
				} catch {
					try {
						fs.rmSync(worktreePath, { recursive: true, force: true });
						removed = true;
					} catch {
						/* keep as preserved */
					}
				}
				if (removed) {
					result.removed.push(worktreePath);
					continue;
				}
			}
			result.preserved.push({
				path: worktreePath,
				reason: `worktree corrupted — gitdir pointer check failed (${gitdirCheck.reason}); no git executed inside; inspect manually or remove with force=true`,
			});
			continue;
		}
		const dirty = isDirty(worktreePath);
		const branchName = `pi-crew/${manifest.runId}/${sanitizeBranchPart(entry.name)}`;
		const safeBranchName = sanitizeBranchPart(entry.name);
		if (dirty) {
			// C9: preserve dirty worktrees unless explicitly forced. Previously the
			// dirty branch ALWAYS ran 'git add -A' + commit + remove, staging every
			// untracked file (incl. potential secrets/build artifacts) into a
			// recovery branch without consent. force=true keeps the old behavior.
			if (!options.force) {
				const safePreserveName = sanitizeFilename(entry.name);
				const artifact = writeArtifact(manifest.artifactsRoot, {
					kind: "diff",
					relativePath: `cleanup/${safePreserveName}.diff`,
					content: captureDiff(worktreePath),
					producer: "worktree-cleanup",
				});
				result.artifactPaths.push(artifact.path);
				result.preserved.push({
					path: worktreePath,
					reason: "dirty worktree preserved \u2014 pass force=true to auto-commit and remove",
				});
				continue;
			}
			// Issue 1 fix: check signal before git operations
			if (options.signal?.aborted) break;
			// Commit changes to a branch instead of just preserving the worktree
			try {
				// Issue 2 fix: verify status before and after add to ensure atomicity
				const statusBefore = git(worktreePath, ["status", "--porcelain"]);
				// MED-1: routed through the hardened git() helper (fsmonitor/hooksPath
				// disabled) — a worker-planted config must not execute on `git add`.
				git(worktreePath, ["add", "-A"]);
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
				// MED-1: --no-verify + hooksPath= neutralize every commit hook
				// (pre-commit/commit-msg/prepare-commit-msg/post-commit).
				git(worktreePath, ["commit", "-m", `pi-crew: ${safeDesc}`]);
				// Issue 1 fix: check signal before branch creation
				if (options.signal?.aborted) break;
				// Create branch in the main repo pointing to this worktree's HEAD
				let branchError: Error | null = null;
				try {
					git(worktreePath, ["branch", branchName]);
				} catch (err) {
					branchError = err instanceof Error ? err : new Error(String(err));
					// Branch already exists — use timestamp suffix
					const tsBranch = `${branchName}-${Date.now()}`;
					try {
						git(worktreePath, ["branch", tsBranch]);
					} catch (err2) {
						// Both branch attempts failed — accumulate error for outer catch
						const err2_msg = err2 instanceof Error ? err2.message : String(err2);
						throw new Error(
							`branch creation failed (${branchName} already exists): ${branchError.message}; fallback branch also failed: ${err2_msg}`,
						);
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
						fs.rmSync(worktreePath, {
							recursive: true,
							force: true,
						});
						result.removed.push(worktreePath);
					} catch {
						result.preserved.push({
							path: worktreePath,
							reason: `commit succeeded but worktree remove failed: ${removeError instanceof Error ? removeError.message : String(removeError)}; fs.rmSync fallback also failed`,
						});
					}
					const artifact = writeArtifact(manifest.artifactsRoot, {
						kind: "metadata",
						relativePath: `metadata/worktree-branch-${safeBranchName}.json`,
						content: JSON.stringify(
							{
								worktreePath,
								branch: branchName,
								committedAt: new Date().toISOString(),
								mergeCommand: `git merge ${branchName}`,
								gitStatusAtCommit: gitStatusBeforeRemove,
							},
							null,
							2,
						),
						producer: "worktree-cleanup",
					});
					result.artifactPaths.push(artifact.path);
					continue;
				}
				const artifact = writeArtifact(manifest.artifactsRoot, {
					kind: "metadata",
					relativePath: `metadata/worktree-branch-${safeBranchName}.json`,
					content: JSON.stringify(
						{
							worktreePath,
							branch: branchName,
							committedAt: new Date().toISOString(),
							mergeCommand: `git merge ${branchName}`,
							gitStatusAtCommit: gitStatusBeforeRemove,
						},
						null,
						2,
					),
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
				result.preserved.push({
					path: worktreePath,
					reason: `dirty worktree preserved (commit failed: ${error instanceof Error ? error.message : String(error)})`,
				});
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
