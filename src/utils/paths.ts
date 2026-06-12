import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function userPiRoot(): string {
	const home = process.env.PI_TEAMS_HOME?.trim() || os.homedir();
	const resolved = path.join(home, ".pi", "agent");

	// Reject symlinks to prevent confusion attacks where PI_TEAMS_HOME points to
	// an attacker-controlled target via a user-owned symlink.
	// We use lstatSync (does NOT follow) to detect symlinks before they are resolved.
	// ENOENT is acceptable — the directory may not exist yet (caller will create it).
	let isSymlink = false;
	try {
		const lstats = fs.lstatSync(resolved);
		isSymlink = lstats.isSymbolicLink();
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && err.code !== "ENOENT") throw err;
		// Path doesn't exist yet — caller will create it. Skip further validation.
		return resolved;
	}
	if (isSymlink) {
		throw new Error(
			`userPiRoot: PI_TEAMS_HOME path "${resolved}" is a symlink. ` +
			"Symlinks are not supported for PI_TEAMS_HOME to prevent confusion attacks. " +
			"Set PI_TEAMS_HOME to a direct path owned by the current user.",
		);
	}

	// Validate that the resolved path is owned by the current user
	// to ensure security assumptions about file permissions (0o600/0o700) hold.
	// Skip check if the directory does not exist yet.
	try {
		const stats = fs.statSync(resolved);
		if (stats.uid !== os.userInfo().uid) {
			throw new Error(
				`userPiRoot: PI_TEAMS_HOME path "${resolved}" is not owned by the current user (uid=${os.userInfo().uid}, found uid=${stats.uid}). ` +
				"This violates security assumptions about file permissions. Set PI_TEAMS_HOME to a path owned by the current user, or unset it to use the default.",
			);
		}
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
			throw err;
		}
		// ENOENT from statSync means the directory was deleted between lstat and stat
		// (race condition). This is acceptable — caller will handle.
	}

	return resolved;
}

const PROJECT_DIR_MARKERS = [".git", ".pi", ".crew", ".hg", ".svn", ".factory", ".omc"];
const PROJECT_FILE_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "composer.json", "build.gradle", "build.gradle.kts"];

// 2.10 — cache findRepoRoot results so repeated lookups during render ticks
// (loadConfig, state-store helpers, powerbar, snapshot-cache, ...) skip the
// 14 existsSync calls per ancestor level. TTL is short enough that a freshly
// `git init`-ed marker is picked up within ~30s without forcing manual
// invalidation in interactive sessions.
const PROJECT_ROOT_CACHE_TTL_MS = 30_000;
const PROJECT_ROOT_CACHE_MAX_ENTRIES = 32;
interface ProjectRootCacheEntry {
	repoRoot: string | undefined;
	cachedAt: number;
}
const projectRootCache = new Map<string, ProjectRootCacheEntry>();

function evictOldestProjectRoot(): void {
	const oldest = projectRootCache.keys().next().value;
	if (oldest !== undefined) projectRootCache.delete(oldest);
}

/** Drop all cached findRepoRoot results. Call from cleanupRuntime / tests. */
export function clearProjectRootCache(): void {
	projectRootCache.clear();
}

function hasProjectMarker(dir: string): boolean {
	for (const marker of PROJECT_DIR_MARKERS) {
		if (fs.existsSync(path.join(dir, marker))) return true;
	}
	for (const file of PROJECT_FILE_MARKERS) {
		if (fs.existsSync(path.join(dir, file))) return true;
	}
	return false;
}

export function findRepoRoot(cwd: string): string | undefined {
	// Resolve symlinks before walking to prevent malicious symlinks from bypassing
	// home/temp boundary checks. If the path doesn't exist (e.g., caller passed
	// a non-existent CWD like /tmp/no-such-dir), fall back to the lexical path
	// and let computeRepoRoot handle the rest. ENOENT here is common for
	// newly-created test directories and shouldn't propagate as a crash.
	let startKey: string;
	try {
		startKey = fs.realpathSync(cwd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			startKey = path.resolve(cwd);
		} else {
			throw error;
		}
	}
	const cached = projectRootCache.get(startKey);
	if (cached && Date.now() - cached.cachedAt < PROJECT_ROOT_CACHE_TTL_MS) {
		// Re-insert to refresh LRU position.
		projectRootCache.delete(startKey);
		projectRootCache.set(startKey, cached);
		return cached.repoRoot;
	}
	const result = computeRepoRoot(startKey);
	projectRootCache.set(startKey, { repoRoot: result, cachedAt: Date.now() });
	while (projectRootCache.size > PROJECT_ROOT_CACHE_MAX_ENTRIES) evictOldestProjectRoot();
	return result;
}

function computeRepoRoot(start: string): string | undefined {
	let current = start;
	const root = path.parse(current).root;
	const home = path.resolve(os.homedir());
	const tempRoot = path.resolve(os.tmpdir());
	while (current !== root) {
		// Stop walking before checking markers at home or temp root
		if (current === home || current === tempRoot) return undefined;
		if (hasProjectMarker(current)) return current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (current === home || current === tempRoot) return undefined;
	if (hasProjectMarker(root)) return root;
	return undefined;
}

export function projectPiRoot(cwd: string): string {
	const repoRoot = findRepoRoot(cwd) ?? cwd;
	const piDir = path.join(repoRoot, ".pi");
	// Use realpathSync to resolve any symlinks before returning to prevent
	// config from being read from unexpected locations.
	if (fs.existsSync(piDir)) return fs.realpathSync(piDir);
	return piDir;
}

export function projectCrewRoot(cwd: string): string {
	const repoRoot = findRepoRoot(cwd) ?? cwd;
	const crewDir = path.join(repoRoot, ".crew");
	// Keep an existing .crew/ stable even when .pi/ exists for project config.
	// Use realpathSync to resolve any symlinks before returning to prevent
	// state/artifacts from being written outside expected boundaries.
	if (fs.existsSync(crewDir)) return fs.realpathSync(crewDir);
	// Legacy reuse: if .pi/ already exists for the project, namespace under .pi/teams/
	// to avoid creating a parallel .crew/ alongside an existing pi project layout.
	const piDir = path.join(repoRoot, ".pi");
	if (fs.existsSync(piDir)) return path.join(fs.realpathSync(piDir), "teams");
	return crewDir;
}

export function userCrewRoot(): string {
	return path.join(userPiRoot(), "extensions", "pi-crew");
}
