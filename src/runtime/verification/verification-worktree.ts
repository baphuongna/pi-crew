/**
 * Phase 1.5 #2 — Git-worktree verification sandbox.
 *
 * RFC: research-findings/goal-workflow/16-PHASE1.5-WORKTREE-SANDBOX-RFC.md
 *
 * Closes the two remaining Med-High tampering residuals from RFC 13 §6:
 *   (1) Round-trip manifest tamper (MAJ#2): worker edits package.json, runs
 *       test, reverts before T_verify_done → snapshot matches → undetected.
 *   (2) Invoked-script tampering: worker rewrites a script the verification
 *       command invokes; only MANIFEST_FILES are hashed → invisible.
 *
 * Mitigation: run verification commands in a pristine `git worktree` at the
 * T_snap commit SHA. Worker edits in the main workspace are invisible to
 * the verification subprocess. Content-addressed execution: the test passes
 * (or fails) against the original code, regardless of worker edits.
 *
 * Opt-in via PI_CREW_VERIFICATION_WORKTREE=1 (mirrors Phase 1.5 #1 pattern).
 * Auto-fallback to existing behavior when: not a git repo, dirty index,
 * git unavailable, or opt-out explicitly set. NEVER blocks the goal loop.
 *
 * Pure leaf module: depends only on node: built-ins + git CLI. No imports
 * from goal-loop-runner or verification-gates (keeps unit-testable).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface VerificationWorktree {
	/** Absolute path to the pristine worktree directory. */
	worktreePath: string;
	/** Commit SHA the worktree is checked out at (matches T_snap). */
	commitSha: string;
	/** Cleanup handle — call to remove the worktree + temp dir. Idempotent. */
	cleanup: () => void;
}

/** Whether the worktree sandbox is enabled (env var opt-in). */
export function isWorktreeSandboxEnabled(): boolean {
	const v = process.env.PI_CREW_VERIFICATION_WORKTREE ?? process.env.PI_TEAMS_VERIFICATION_WORKTREE;
	return v === "1" || v === "true";
}

/**
 * Detect whether the worktree sandbox is AVAILABLE at `cwd`:
 *  - opt-in env var set
 *  - git executable on PATH
 *  - cwd is inside a git repo
 *  - git index is clean (no uncommitted changes that would be lost)
 *
 * Returns false (with reason) when any precondition fails. Callers MUST
 * gracefully fall back to non-sandboxed execution — never block the goal.
 */
export function checkWorktreeSandboxAvailable(cwd: string): { available: true; commitSha: string } | { available: false; reason: string } {
	if (!isWorktreeSandboxEnabled()) {
		return {
			available: false,
			reason: "PI_CREW_VERIFICATION_WORKTREE not set (opt-in)",
		};
	}
	try {
		// Is cwd inside a git repo? `git rev-parse --show-toplevel` errors out
		// (non-zero exit) when not in a repo. execFileSync throws on non-zero.
		const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
		}).trim();
		if (!toplevel)
			return {
				available: false,
				reason: "git rev-parse returned empty toplevel",
			};
		// Current commit SHA (this is what T_snap will pin to).
		const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
		}).trim();
		if (!commitSha)
			return {
				available: false,
				reason: "git rev-parse HEAD returned empty SHA",
			};
		// Dirty index? `git status --porcelain` outputs non-empty if there are
		// uncommitted changes. We refuse to sandbox a dirty workspace because
		// the worktree would NOT contain the in-progress edits (T_snap would
		// pin to a stale commit). Better to fall back + warn than silently
		// verify against the wrong code.
		const status = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
		}).trim();
		if (status.length > 0)
			return {
				available: false,
				reason: `dirty git index (${status.split("\n").length} changed files); refusing to sandbox — worktree would pin to stale commit`,
			};
		return { available: true, commitSha };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return {
			available: false,
			reason: `git precondition check failed: ${msg.slice(0, 200)}`,
		};
	}
}

/**
 * Prepare a pristine git worktree at `commitSha`. The worktree is a fresh
 * checkout of the project at that commit — it does NOT contain worker edits
 * from the main workspace.
 *
 * `git worktree add --detach <tmp>/wt-<sha8> <sha>` creates a detached-HEAD
 * worktree (no branch pollution). Returns the worktree path + cleanup handle.
 *
 * Cleanup is idempotent (safe to call multiple times) and best-effort (swallows
 * errors so a stuck worktree doesn't propagate into the goal loop).
 */
export function prepareVerificationWorktree(cwd: string, commitSha: string): VerificationWorktree {
	// Temp parent dir under os.tmpdir() so worktrees are auto-cleaned on reboot.
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wt-"));
	const shortSha = commitSha.slice(0, 8);
	const worktreePath = path.join(tmpRoot, `wt-${shortSha}`);
	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		// Remove the worktree (force = proceed even if it has untracked files).
		try {
			execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
		} catch {
			// Fall back to `git worktree prune` if remove fails (already gone).
			try {
				execFileSync("git", ["worktree", "prune"], {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 5000,
				});
			} catch {
				/* best-effort */
			}
		}
		// Remove the temp parent dir.
		try {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	};
	try {
		execFileSync("git", ["worktree", "add", "--detach", worktreePath, commitSha], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
		return { worktreePath, commitSha, cleanup };
	} catch (error) {
		cleanup();
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`git worktree add failed (cwd=${cwd}, sha=${shortSha}): ${msg.slice(0, 300)}`);
	}
}

/**
 * RAII wrapper: prepare worktree, run `fn(worktree)`, ALWAYS cleanup in finally.
 *
 * `fn` may throw — the worktree is removed regardless. The original error
 * propagates (cleanup errors are swallowed and best-effort).
 *
 * If preparation fails, the function rethrows WITHOUT calling fn — caller
 * must handle the prep failure (typically by falling back to non-sandboxed).
 */
export async function withVerificationWorktree<T>(
	cwd: string,
	commitSha: string,
	fn: (worktree: VerificationWorktree) => Promise<T> | T,
): Promise<T> {
	const worktree = prepareVerificationWorktree(cwd, commitSha);
	try {
		return await fn(worktree);
	} finally {
		worktree.cleanup();
	}
}
