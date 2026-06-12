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
	// SECURITY: PI_* and PI_CREW_* wildcards removed — they could match secret vars like PI_PASSWORD.
// Git operations do not need PI_CREW_* execution-control vars.
return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...sanitizeEnvSecrets(process.env, { allowList: ["PATH", "HOME", "USER", "USERPROFILE", "SHELL", "TERM", "LANG", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "NVM_BIN", "NVM_DIR", "NODE_PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] }), LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }, windowsHide: true }).trim();
}

// Dots are removed from branch names since they are used in path construction,
// and dots could cause ambiguity with relative path handling on some platforms.
// Branch names themselves support dots in git, but we strip them for safe path use.
function sanitizeBranchPart(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_/-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
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
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`synthetic path escapes worktree: ${rawPath}`);
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

/**
 * SECURITY: Verify a hook script path remains within the allowed directory after
 * real-path resolution. This prevents symlink-based escape where repoRoot is a
 * symlink and the hook path would resolve outside the repository.
 * @param repoRoot - The repository root (resolved to real path)
 * @param hookPath - The resolved absolute hook path
 * @returns true if the hook is safely contained within repoRoot
 */
function isHookPathContainedInRepoRoot(repoRoot: string, hookPath: string): boolean {
	try {
		const realRepoRoot = fs.realpathSync(repoRoot);
		const realHookPath = fs.realpathSync(path.dirname(hookPath));
		return realHookPath.startsWith(realRepoRoot + path.sep) || realHookPath === realRepoRoot;
	} catch {
		return false;
	}
}

function runSetupHook(manifest: TeamRunManifest, task: TeamTaskState, repoRoot: string, worktreePath: string, branch: string): string[] {
	const cfg = loadConfig(manifest.cwd).config.worktree;
	if (!cfg?.setupHook) return [];
	const rawHookPath = cfg.setupHook;
	if (!isAllowedSetupHook(rawHookPath)) {
		logInternalError("worktree.setupHook.rejected", new Error("hook path not allowed: " + rawHookPath), `cwd=${manifest.cwd}`);
		return [];
	}
	// SECURITY WARNING: Home directory hooks (~/.pi/hooks/) are user-writable and not project-scoped.
	// A rogue npm postinstall script could place malicious hooks there. Log for visibility.
	//
	// SECURITY ASSUMPTION: This function trusts that the hook scripts themselves are not malicious.
	// Hook scripts are executed with the same privileges as the Pi process. The caller is responsible
	// for ensuring that only trusted hook scripts are configured. Path containment validation
	// (isAllowedSetupHook, isHookPathContainedInRepoRoot) prevents hook scripts from writing outside
	// the worktree, but cannot prevent a trusted hook from performing harmful operations within it.
	if (path.isAbsolute(rawHookPath)) {
		logInternalError("worktree.setupHook.homeHook", new Error("Home directory hook used — ensure ~/.pi/hooks/ is trusted"), `hookPath=${rawHookPath}`);
	}
	const hookPath = path.isAbsolute(rawHookPath) ? rawHookPath : path.resolve(repoRoot, rawHookPath);
	// SECURITY: Verify the resolved hook path is contained within the real repoRoot.
	// This prevents symlink-based escape where repoRoot is a symlink.
	if (!path.isAbsolute(rawHookPath) && !isHookPathContainedInRepoRoot(repoRoot, hookPath)) {
		logInternalError("worktree.setupHook.contained", new Error("hook path escapes repoRoot after realpath resolution: " + hookPath), `repoRoot=${repoRoot}`);
		return [];
	}
	try {
		const hookStat = fs.lstatSync(hookPath);
		if (!hookStat.isFile()) {
			logInternalError("worktree.setupHook.missing", new Error("hook not found or is directory: " + hookPath), `cwd=${manifest.cwd}`);
			return [];
		}
	} catch {
		logInternalError("worktree.setupHook.missing", new Error("hook not found: " + hookPath), `cwd=${manifest.cwd}`);
		return [];
	}
	const nodeHook = hookPath.endsWith(".js") || hookPath.endsWith(".cjs") || hookPath.endsWith(".mjs");
	// For .bat/.cmd files on Windows, execute via cmd.exe /c directly
	const isBatchFile = hookPath.endsWith(".bat") || hookPath.endsWith(".cmd");
	// SECURITY: Never use shell:true — prevents command injection from untrusted hooks.
	// Non-node, non-batch hooks on Windows will fail to execute rather than
	// running through a shell that could interpret malicious filenames.
	const useShell = false;
	if (process.platform === "win32" && !nodeHook && !isBatchFile) {
		logInternalError("worktree.setupHook.windowsNoShell", new Error("Non-node, non-batch hook skipped on Windows (shell:true disabled for security)"), `hook=${hookPath}`);
	}
	// SECURITY: Resolve the hook to its real path before execution to close the TOCTOU window.
	// This prevents a symlink swap between the containment check and actual execution.
	// KNOWN LIMITATION: There is a residual TOCTOU window between realpathSync validation
	// (line 166) and spawnSync execution (line 183). A sufficiently fast attacker could
	// theoretically swap the symlink between these two operations. The realpathSync + O_NOFOLLOW
	// approach minimizes but does not eliminate this window. To fully close it, consider
	// opening the hook file once via a file descriptor and executing via fd passing (not available
	// in Node.js spawnSync). This is documented as a known limitation rather than a bug.
	let realHookPath: string;
	try {
		realHookPath = fs.realpathSync(hookPath);
	} catch {
		logInternalError("worktree.setupHook.realpath", new Error("hook realpath resolution failed: " + hookPath), `cwd=${manifest.cwd}`);
		return [];
	}
	const result = isBatchFile
		? spawnSync("cmd.exe", ["/c", realHookPath], {
			cwd: worktreePath,
			encoding: "utf-8",
			input: JSON.stringify({ version: 1, repoRoot, worktreePath, agentCwd: worktreePath, branch, runId: manifest.runId, taskId: task.id, agent: task.agent }),
			timeout: cfg.setupHookTimeoutMs ?? 30_000,
			shell: false,  // cmd.exe /c handles batch files safely
			env: sanitizeEnvSecrets(process.env, {
				allowList: ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"],
			}),
			windowsHide: true,
		})
		: spawnSync(nodeHook ? process.execPath : realHookPath, nodeHook ? [realHookPath] : [], {
			cwd: worktreePath,
			encoding: "utf-8",
			input: JSON.stringify({ version: 1, repoRoot, worktreePath, agentCwd: worktreePath, branch, runId: manifest.runId, taskId: task.id, agent: task.agent }),
			timeout: cfg.setupHookTimeoutMs ?? 30_000,
			shell: false,
			env: sanitizeEnvSecrets(process.env, {
				allowList: ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"],
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

/**
 * Normalize and validate seed paths — ensure all paths stay within repoRoot.
 * Rejects path traversal (../) and absolute paths.
 */
export function normalizeSeedPaths(seedPaths: string[], repoRoot: string): string[] {
	const resolvedRepoRoot = path.resolve(repoRoot);
	const entries = Array.isArray(seedPaths) ? seedPaths : [];
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const entry of entries) {
		if (typeof entry !== "string" || entry.trim().length === 0) continue;

		const absolutePath = path.resolve(resolvedRepoRoot, entry);
		const relativePath = path.relative(resolvedRepoRoot, absolutePath);

		if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
			throw new Error(`seedPaths entries must stay inside repoRoot: ${entry}`);
		}

		// Reject symlinks to prevent escape via symlink-based path traversal.
		// This check is also performed in overlaySeedPaths for defense-in-depth.
		// ENOENT is acceptable — seed paths may reference files that don't exist yet
		// (they are validated at copy time by overlaySeedPaths).
		try {
			const stat = fs.lstatSync(absolutePath);
			if (stat.isSymbolicLink()) {
				throw new Error(`seedPaths entries cannot be symlinks: ${entry}`);
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("seedPaths entries")) throw error;
			// ENOENT is acceptable — seed paths may reference files that don't exist yet.
			// Skip symlink check but still include the path in results.
			if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
				throw new Error(`seedPaths entries must be accessible: ${entry}`);
			}
		}

		const normalizedPath = relativePath.split(path.sep).join("/");
		if (seen.has(normalizedPath)) continue;
		seen.add(normalizedPath);
		normalized.push(normalizedPath);
	}

	return normalized;
}

/**
 * Overlay seed paths from repoRoot into worktreePath.
 * Copies files and directories, creating parent dirs as needed.
 * Skips non-existent sources with logInternalError (non-fatal).
 */
export function overlaySeedPaths(repoRoot: string, worktreePath: string, seedPaths: string[]): void {
	const normalized = normalizeSeedPaths(seedPaths, repoRoot);

	for (const seedPath of normalized) {
		const sourcePath = path.join(repoRoot, seedPath);
		const destinationPath = path.join(worktreePath, seedPath);

		let sourceStat: fs.Stats;
		try {
			sourceStat = fs.lstatSync(sourcePath);
		} catch {
			logInternalError("worktree.seedPaths.missing", new Error(`Seed path does not exist: ${seedPath}`));
			continue;
		}
		// Reject symlinks in seed paths to prevent copying symlinks into worktree (which could point outside repoRoot).
		if (sourceStat.isSymbolicLink()) {
			logInternalError("worktree.seedPaths.symlink", new Error(`Seed path is a symlink — rejected: ${seedPath}`));
			continue;
		}
		if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
			logInternalError("worktree.seedPaths.invalid", new Error(`Seed path is neither file nor directory: ${seedPath}`));
			continue;
		}

		fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
		fs.rmSync(destinationPath, { force: true, recursive: true });
		fs.cpSync(sourcePath, destinationPath, {
			dereference: true,
			force: true,
			preserveTimestamps: true,
			recursive: true,
		});
	}
}

export function prepareTaskWorkspace(manifest: TeamRunManifest, task: TeamTaskState, stepSeedPaths?: string[]): PreparedTaskWorkspace {
	if (manifest.workspaceMode !== "worktree") return { cwd: task.cwd };
	const repoRoot = findGitRoot(manifest.cwd);
	const loadedConfig = loadConfig(manifest.cwd);
	if (loadedConfig.config.requireCleanWorktreeLeader !== false) assertCleanLeader(repoRoot);
	const sanitizedRunId = manifest.runId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "run";
	const worktreeRoot = path.join(projectCrewRoot(manifest.cwd), DEFAULT_PATHS.state.worktreesSubdir, sanitizedRunId);
	fs.mkdirSync(worktreeRoot, { recursive: true });
	// Resolve through realpath to handle Windows short-name vs long-name alias.
	// git worktree uses long-name paths on Windows, so we must match.
	let resolvedWorktreeRoot = worktreeRoot;
	try {
		resolvedWorktreeRoot = fs.realpathSync.native(worktreeRoot);
		// Strip Windows extended-length prefix (\\?\) for path.join compatibility
		if (resolvedWorktreeRoot.startsWith("\\\\?\\")) resolvedWorktreeRoot = resolvedWorktreeRoot.slice(4);
	} catch {
		try { resolvedWorktreeRoot = fs.realpathSync(worktreeRoot); } catch { /* keep as-is */ }
	}
	const sanitizedTaskId = sanitizeBranchPart(task.id);
	const worktreePath = path.join(resolvedWorktreeRoot, sanitizedTaskId);
	const branch = `pi-crew/${sanitizeBranchPart(manifest.runId)}/${sanitizeBranchPart(task.id)}`;
	// Use `git worktree list --porcelain` to atomically verify the worktree exists.
	// This avoids a TOCTOU race between fs.existsSync and git branch verification.
	let worktreeExists = false;
	try {
		const worktreeList = git(repoRoot, ["worktree", "list", "--porcelain"]);
		// `git worktree list --porcelain` outputs "worktree /path" per entry.
		// We must compare against the path part (after "worktree ").
		// On Windows, git may return forward-slash long-name paths while
		// worktreePath uses short-name backslash form. Normalize both.
		const normalizedWtPath = process.platform === "win32" ? worktreePath.replace(/\\/g, "/").toLowerCase() : worktreePath;
		worktreeExists = worktreeList.split("\n").some((line) => {
			const trimmed = line.trim();
			const matchPath = trimmed.startsWith("worktree ") ? trimmed.slice(9) : trimmed;
			if (process.platform === "win32") {
				return matchPath.replace(/\\/g, "/").toLowerCase() === normalizedWtPath;
			}
			return matchPath === worktreePath;
		});
	} catch { worktreeExists = false; }
	if (worktreeExists) {
		let currentBranch: string;
		try {
			currentBranch = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
		} catch (gitError) {
			throw new Error(`Existing worktree at ${worktreePath} is not a valid git repository; cannot verify branch: ${gitError instanceof Error ? gitError.message : String(gitError)}`);
		}
		if (currentBranch !== branch) {
			throw new Error(`Existing worktree branch mismatch at ${worktreePath}: expected '${branch}', got '${currentBranch}'.`);
		}
		// Check for uncommitted changes from previous run before reusing
		const dirtyStatus = git(worktreePath, ["status", "--porcelain"]);
		if (dirtyStatus.trim()) {
			// Discard uncommitted changes to ensure clean slate for new task
			logInternalError("worktree.reused.dirty", new Error(`Discarding uncommitted changes in reused worktree at ${worktreePath}`), `runId=${manifest.runId}, taskId=${task.id}, dirtyStatus=${dirtyStatus.trim()}`);
			git(worktreePath, ["checkout", "--", "."]);
			git(worktreePath, ["clean", "-fd"]);
		}
		// Overlay seed paths from config + step-level seedPaths (reused worktree)
		const globalSeedPaths = loadedConfig.config.worktree?.seedPaths ?? [];
		const mergedReused = normalizeSeedPaths([...globalSeedPaths, ...(stepSeedPaths ?? [])], repoRoot);
		if (mergedReused.length > 0) {
			overlaySeedPaths(repoRoot, worktreePath, mergedReused);
		}
		// Re-validate leader is still clean before reusing — leader state may have changed since first preparation
		assertCleanLeader(repoRoot);
		return { cwd: worktreePath, worktreePath, branch, reused: true };
	}
	pruneStaleWorktrees(repoRoot);
	const exists = branchExists(repoRoot, branch);
	let worktreeCreated = false;
	try {
		if (exists.local) {
			git(repoRoot, ["worktree", "add", worktreePath, branch]);
		} else {
			if (exists.remoteOnly) {
				logInternalError("worktree.branchRemoteOnly", new Error(`Branch '${branch}' exists only on remote; creating local from HEAD instead of tracking remote.`), `branch=${branch}`);
			}
			git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
		}
		worktreeCreated = true;
	} catch (error) {
		// Clean up orphaned worktree directory if git worktree add failed
		if (fs.existsSync(worktreePath)) {
			try {
				fs.rmSync(worktreePath, { recursive: true, force: true });
			} catch { /* best-effort cleanup */ }
		}
		const msg = error instanceof Error ? error.message : String(error);
		if (/already checked out|is already used by worktree/i.test(msg)) {
			throw new Error(`Branch '${branch}' is checked out at another worktree. Run \`team cleanup runId=${manifest.runId} force=true\` or manually remove the conflicting worktree.`);
		}
		throw error;
	}
	const syntheticPaths = runSetupHook(manifest, task, repoRoot, worktreePath, branch);
	const nodeModulesLinked = loadedConfig.config.worktree?.linkNodeModules === true ? linkNodeModulesIfPresent(repoRoot, worktreePath) : false;
	// Overlay seed paths from config + step-level seedPaths
	const globalSeedPaths = loadedConfig.config.worktree?.seedPaths ?? [];
	const merged = normalizeSeedPaths([...globalSeedPaths, ...(stepSeedPaths ?? [])], repoRoot);
	if (merged.length > 0) {
		overlaySeedPaths(repoRoot, worktreePath, merged);
	}
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
