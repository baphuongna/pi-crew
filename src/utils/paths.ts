import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getCrewEnv } from "../config/env-vars.ts";
import { PROJECT_DIR_MARKERS, PROJECT_FILE_MARKERS } from "./project-markers.ts";

// NEW-P1/NEW-P2 (perf): packageRoot() and userPiRoot() are invariant for a
// process lifetime but each call did statSync/readFileSync/lstatSync (10-15+
// call sites, including at MODULE-LOAD time). Memoize both: compute on first
// call, return the cached value thereafter. Resolution logic is unchanged.
let cachedPackageRoot: string | undefined;

export function packageRoot(): string {
	if (cachedPackageRoot !== undefined) return cachedPackageRoot;
	// Phase 5 H2 follow-up: this function is called from both src/ paths
	// (e.g. src/utils/paths.ts) AND from dist/index.mjs after bundling.
	// The original 2-level walk only worked for src/ paths:
	//   src/utils/paths.ts → src/utils/ → src/ → packageRoot
	// For dist/index.mjs we need only 1 level:
	//   dist/index.mjs → dist/ → packageRoot
	// Heuristic: walk up from `import.meta.url`'s directory until we find
	// a directory that contains `package.json` with our package name. This
	// is robust to either entrypoint and to future relocation (e.g., a
	// monorepo layout under `packages/pi-crew/dist/index.mjs` would walk
	// 2 levels from dist).
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 6; i++) {
		const candidate = path.join(dir, "package.json");
		if (fs.existsSync(candidate)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8")) as { name?: string };
				if (pkg.name === "pi-crew") {
					cachedPackageRoot = dir;
					return dir;
				}
			} catch {
				// Unreadable or invalid JSON — keep walking.
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Fallback: 2-level walk (matches original src/ semantics). Bundles
	// that don't ship a package.json (very unusual) will get a wrong path
	// here, but that's a build-pipeline bug we want to surface, not hide.
	cachedPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	return cachedPackageRoot;
}

let cachedUserPiRoot: { home: string; value: string } | undefined;

export function userPiRoot(): string {
	// F4: a misconfigured PI_TEAMS_HOME can be the literal string "undefined"
	// (e.g. PI_TEAMS_HOME=$UNSET_VAR in a shell), which would build paths like
	// "undefined/.pi/agent" relative to cwd and silently create a junk "undefined/"
	// tree. Treat the literal "undefined" (and empty) as unset and fall back to
	// os.homedir().
	const rawHome = getCrewEnv("PI_CREW_HOME")?.trim();
	const home = rawHome && rawHome !== "undefined" ? rawHome : os.homedir();
	// NEW-P2: memoize but KEY ON HOME. Tests (withIsolatedHome / isolateHome)
	// change PI_TEAMS_HOME mid-process; an unkeyed cache would leak the first
	// test's root across the suite (broken isolation — surfaced by active-run-
	// registry / health-monitor run counts). In production home is stable, so
	// this still collapses ~15 lstatSync call sites to one stat per distinct home.
	if (cachedUserPiRoot?.home === home) return cachedUserPiRoot.value;
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
		cachedUserPiRoot = { home, value: resolved };
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

	cachedUserPiRoot = { home, value: resolved };
	return resolved;
}

// Marker lists live in ./project-markers.ts (RR-020 Fix 1) so that
// src/state/crew-init.ts:findProjectRoot() cannot drift from this resolver
// again — the drift produced two different project roots for one cwd.

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

/** On Windows, resolve a path to its canonical long-name form.
 *  Uses realpathSync.native to get the \\?\ long-name path, then strips
 *  the prefix for path.relative compatibility. */
function canonicalizePath(p: string): string {
	try {
		const r = fs.realpathSync.native(p);
		return r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		try {
			return fs.realpathSync(p);
		} catch {
			return p;
		}
	}
}

export function findRepoRoot(cwd: string): string | undefined {
	// Resolve symlinks before walking to prevent malicious symlinks from bypassing
	// home/temp boundary checks. If the path doesn't exist (e.g., caller passed
	// a non-existent CWD like /tmp/no-such-dir), fall back to the lexical path
	// and let computeRepoRoot handle the rest. ENOENT here is common for
	// newly-created test directories and shouldn't propagate as a crash.
	let startKey: string;
	try {
		// Canonicalize with .native (long-name form on Windows). The home/temp
		// boundaries in computeRepoRoot are canonicalized with realpathSync.native
		// too — a non-native start preserves 8.3 short names (RUNNER~1) on win32,
		// so the walk chain NEVER textually matches the long-name boundary and
		// escapes the sandbox, latching onto an ancestor marker (live CI: runs
		// created under a sandboxed home landed in the REAL home's .pi/teams).
		// On Linux/macOS native and non-native resolve identically.
		startKey = fs.realpathSync.native(cwd);
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
	// Canonicalize the boundaries to match the walk chain: findRepoRoot
	// resolves the start dir via realpathSync, so every step of the walk is a
	// canonical path. Comparing against the LEXICAL home/tmpdir lets symlinked
	// temp dirs (macOS: /var -> /private/var, TMPDIR=/var/folders/.../T) never
	// match, so the walk escapes the sandbox and can latch onto an unrelated
	// ancestor marker (seen live: GH macOS runners have one) — state then
	// resolves to a repo root far outside the temp tree (bug-029).
	const home = canonicalizePath(path.resolve(os.homedir()));
	const tempRoot = canonicalizePath(path.resolve(os.tmpdir()));
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
	// Use canonicalizePath to get long-name form on Windows, matching
	// what worktree operations and resolveRealContainedPath expect.
	if (fs.existsSync(crewDir)) return canonicalizePath(crewDir);
	// Legacy reuse: if .pi/ already exists for the project, namespace under .pi/teams/
	// to avoid creating a parallel .crew/ alongside an existing pi project layout.
	const piDir = path.join(repoRoot, ".pi");
	if (fs.existsSync(piDir)) return path.join(canonicalizePath(piDir), "teams");
	return crewDir;
}

export function userCrewRoot(): string {
	return path.join(userPiRoot(), "extensions", "pi-crew");
}

/**
 * Relative path of the run-state directory under a pi-crew root, per layout:
 *   - `.crew`        → `<root>/.crew/state/runs`        (classic layout)
 *   - `.pi/teams`    → `<root>/.pi/teams/state/runs`    (`.pi`-based layout)
 * Mirrors `projectCrewRoot`'s layout choice, so scanners can recognise the
 * SAME two layouts the rest of pi-crew writes.
 */
export const RUN_STATE_RUNS_SUBPATHS = [path.join(".crew", "state", "runs"), path.join(".pi", "teams", "state", "runs")];

/** Layout dirs derived from RUN_STATE_RUNS_SUBPATHS — the single list (a
 *  literal copy here is exactly the drift Fix 1 killed for project markers). */
const RUN_STATE_LAYOUT_DIRS = RUN_STATE_RUNS_SUBPATHS.map((rel) => path.dirname(path.dirname(rel)));

/** Layout dirs split into components for the per-component symlink walk
 *  (cold-verify F-1: lstat only sees the FINAL path component, so for the
 *  `.pi/teams` layout the intermediate `.pi` was never checked). */
const RUN_STATE_LAYOUT_SEGMENTS = RUN_STATE_LAYOUT_DIRS.map((layout) => layout.split(/[\\/]+/).filter(Boolean));

/** True when `p` exists and is NOT a symlink (dir-or-file). A planted symlink
 *  never passes: scanners must reject rather than trust it. */
function existsNoSymlink(p: string): boolean {
	try {
		return !fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/** True when EVERY component of `path.join(dir, ...segments)` exists and is
 *  not a symlink. lstat rejects only the FINAL component, so intermediate
 *  symlinks must be walked component-by-component — cold-verify F-1 reproduced
 *  out-of-tree read AND write through `ws/.pi -> /outside` because `.pi` was
 *  intermediate in all three lstat calls of the earlier fix. */
function existsSymlinkFreePath(dir: string, segments: string[]): boolean {
	let current = dir;
	for (const seg of segments) {
		current = path.join(current, seg);
		if (!existsNoSymlink(current)) return false;
	}
	return true;
}

/**
 * True when `dir` holds pi-crew run state under EITHER supported layout
 * (`.crew/` or `.pi/teams/`) — used by /tmp debris scanners so a temp
 * workspace with live `.pi/teams/state/runs` state is not deleted.
 *
 * A SYMLINKED layout dir never counts: scanners must be able to reject a
 * planted symlink instead of treating it as protection.
 */
export function hasRunStateLayout(dir: string): boolean {
	for (const segments of RUN_STATE_LAYOUT_SEGMENTS) {
		if (existsSymlinkFreePath(dir, segments)) return true;
	}
	return false;
}

/**
 * Resolve the run-state dir (`<layout>/state/runs`) that actually exists under
 * `dir`, checking BOTH supported layouts. Returns undefined when neither
 * layout has a runs dir (i.e. `dir` holds no pi-crew run state).
 *
 * Symlink policy matches `hasRunStateLayout` (cold-verify correction: the
 * first version used existsSync, which FOLLOWS symlinks — a planted
 * `.crew`/`.pi/teams`/`state/runs` symlink let stale-reconciler and
 * health-monitor read — and reconcile — run manifests OUTSIDE the scanned
 * tree). Both the layout dir and the runs dir itself must be symlink-free.
 */
export function findRunStateDir(dir: string): string | undefined {
	for (const segments of RUN_STATE_LAYOUT_SEGMENTS) {
		// Cold-verify F-1/F-A: EVERY component must be symlink-free — lstat only
		// sees the final path component, so intermediate symlinks (`.pi` of the
		// `.pi/teams` layout, the middle `state`, …) were traversed transparently
		// and let scanners READ and WRITE run manifests OUTSIDE the scanned tree
		// (reproduced: reconcileOrphanedTempWorkspaces flipped an outside manifest
		// running→cancelled through both a `.crew/state` and a `.pi` symlink).
		if (!existsSymlinkFreePath(dir, [...segments, "state", "runs"])) continue;
		return path.join(dir, ...segments, "state", "runs");
	}
	return undefined;
}
