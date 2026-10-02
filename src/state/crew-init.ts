/**
 * Auto-initialize .crew directory structure and .gitignore entries.
 * Called on first team run in a workspace to ensure all required
 * directories and files exist.
 *
 * IMPORTANT: This module is dynamically `import()`'d from concurrent child
 * Pi subprocesses (3+ parallel subagents). Under load, the `path` namespace
 * binding can intermittently arrive as `undefined` in jiti's ESM/CJS interop
 * layer. We therefore use the inline helpers `parseRoot`, `safeJoin`,
 * `safeDirname`, and `safeResolve` so that critical path operations do not
 * depend on the `path` namespace binding.
 *
 * The `node:path` import is retained as a *fallback* (only used when the
 * binding is healthy). Don't add new dependencies on other pi-crew modules.
 *
 * TWO sanctioned exceptions (RR-020):
 *   - `node:os` — a builtin like fs/path, used ONLY inside try/catch so a
 *     jiti namespace race degrades to "no home/tmp boundary" (the pre-RR-020
 *     walk) instead of crashing ensureCrewDirectory.
 *   - `../utils/project-markers.ts` — a zero-import module of plain string
 *     literals, so it cannot itself suffer the namespace race and it keeps
 *     this resolver from drifting away from `src/utils/paths.ts`.
 *
 * See: https://github.com/baphuongna/pi-crew/issues/28
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROJECT_DIR_MARKERS, PROJECT_FILE_MARKERS } from "../utils/project-markers.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { updateGitignore } from "./gitignore-manager.ts";

// Re-export updateGitignore for backwards compatibility with tests.
export { updateGitignore };

/**
 * README content for the .crew directory.
 *
 * Defined as a function (not a `const`) to avoid the Temporal Dead Zone race
 * documented in issue #28 + RFC 17. When this module is loaded via
 * `jiti.import()` (pi's extension loader) wrapped in an async function, a
 * `const` initializer can be hit in TDZ by functions hoisted above it (the
 * same pattern that bit `crewInitPromise` in team-tool/run.ts — see commit
 * fixing it). A function declaration is hoisted with its body available
 * immediately, so callers always get the fully-built string.
 */
function buildCrewReadme(): string {
	return `# .crew — pi-crew Runtime Directory

This directory contains pi-crew runtime state and artifacts.

## What's Here

| Directory | Purpose | Commit? |
|-----------|---------|---------|
| \`state/runs/\` | Run manifests, tasks, events | No |
| \`state/subagents/\` | Subagent state | No |
| \`artifacts/\` | Run outputs (test files, docs, etc.) | Optional |
| \`cache/\` | Cached run results (fingerprint-based) | No |
| \`graphs/\` | Archived run graphs | Optional |
| \`audit/\` | Security event logs | No |

## Cleanup

To prune old runs:
\`\`\`bash
team action='prune' keep=5
\`\`\`

To clear cache:
\`\`\`bash
team action='cache' action='clear'
\`\`\`
`;
}
/**
 * Find the project root by walking up from start directory.
 * Inline implementation to avoid module dependency on paths.ts.
 * Matches the logic in src/utils/paths.ts:computeRepoRoot().
 */
/**
 * Detect filesystem root for `start` without relying on `path.parse()`.
 *
 * **Why this exists**: This module is dynamically `import()`'d from concurrent
 * child Pi subprocesses (3+ parallel subagents). Under load, the `path` namespace
 * binding can intermittently arrive as `undefined` in jiti's ESM/CJS interop layer,
 * crashing `findProjectRoot` with `TypeError: Cannot read properties of undefined
 * (reading 'parse')` — see https://github.com/baphuongna/pi-crew/issues/28.
 *
 * Inlining `parse` for the termination root eliminates the dependency on the
 * `path` binding for that critical call path.
 */
function parseRoot(start: string): string {
	if (!start) return "/";
	if (start[0] === "/") return "/";
	// Windows: "C:\\" or "C:/" -> "C:\\"
	if (/^[A-Za-z]:[\\/]/.test(start)) return start.slice(0, 3);
	// UNC: "\\\\server\\share" — find the second path separator.
	if (start.startsWith("\\\\") || start.startsWith("//")) {
		const rest = start.slice(2);
		const firstSep = Math.max(rest.indexOf("\\"), rest.indexOf("/"));
		if (firstSep === -1) return start;
		const secondSep = Math.max(rest.indexOf("\\", firstSep + 1), rest.indexOf("/", firstSep + 1));
		if (secondSep === -1) return start;
		// secondSep is an index into `rest`; add 2 to map back to `start`.
		return start.slice(0, 2 + secondSep);
	}
	// Relative path — no fixed root, use start itself as terminator.
	return start;
}

/**
 * Defensive wrappers around `path` for use in dynamic-import contexts.
 *
 * **Why these exist**: This module is dynamically `import()`'d from concurrent
 * child Pi subprocesses (3+ parallel subagents). Under load, the `path` namespace
 * binding can intermittently arrive as `undefined` in jiti's ESM/CJS interop layer,
 * crashing `findProjectRoot` with `TypeError: Cannot read properties of undefined
 * (reading 'parse')` — see https://github.com/baphuongna/pi-crew/issues/28.
 *
 * Each helper checks that the corresponding `path` function exists before
 * calling it, falling back to an inline implementation. This keeps the file
 * self-contained even if the namespace binding is missing.
 */
function safeJoin(...parts: string[]): string {
	// Cross-platform join — picks the separator based on the parts.
	// Don't delegate to `path.join` because POSIX/Windows disagree on which
	// separator is the path separator, and the dynamic-import context (issue
	// #28) may have a partially-initialized `path` namespace.
	const filtered = parts.filter(Boolean);
	if (filtered.length === 0) return "";
	const sep = filtered.some((p) => p.includes("\\")) ? "\\" : "/";
	// Detect if the first part begins with a leading separator (or UNC "\\\\")
	// so we can preserve it. F-8: collapses runs of the separator everywhere
	// (including the body), but re-prepends the leading separator that the
	// collapse regex would otherwise eat.
	const firstPart = filtered[0];
	let leading = "";
	if (sep === "\\") {
		if (firstPart.startsWith("\\\\")) leading = "\\\\";
		else if (firstPart.startsWith("\\")) leading = "\\";
	} else if (firstPart.startsWith("/")) {
		leading = "/";
	}
	// Strip the leading separator(s) from the first part before joining, so
	// the collapse regex doesn't re-collapse them.
	const firstPartStripped = sep === "\\" ? firstPart.replace(/^\\{1,2}/, "") : firstPart.replace(/^\/+/, "");
	const rest = filtered.slice(1);
	const joined = [firstPartStripped, ...rest].filter(Boolean).join(sep);
	// Collapse internal runs of the separator.
	const collapsed = joined.replace(new RegExp(`${sep === "\\" ? "\\\\" : "/"}{2,}`, "g"), sep);
	return leading + collapsed;
}

function safeDirname(p: string): string {
	// Cross-platform dirname — handles BOTH `/` and `\` separators.
	// Note: we don't delegate to `path.dirname` here because on POSIX it treats
	// backslashes as part of a filename, and on Windows it treats forward
	// slashes the same way. The dynamic-import context (issue #28) may also
	// have a partially-initialized `path` namespace. Using a unified inline
	// implementation ensures consistent behavior across all platforms.
	const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	if (idx === -1) return p; // No separator at all
	if (idx === 0) return p[0] === "/" || p[0] === "\\" ? p[0] : p; // Root: "/" or "\"
	// Preserve drive letter roots like "C:\"
	if (idx === 2 && /[A-Za-z]:/.test(p.slice(0, 2))) return p.slice(0, 3);
	return p.slice(0, idx);
}

function safeResolve(p: string, pathDep?: typeof path): string {
	const dep = pathDep ?? path;
	if (dep && typeof dep.resolve === "function") return dep.resolve(p);
	return p;
}

function findProjectRoot(start: string, pathDep?: typeof path): string | undefined {
	// Marker lists come from src/utils/project-markers.ts (RR-020 Fix 1) so this
	// resolver can never drift from src/utils/paths.ts:computeRepoRoot again —
	// the drift resolved `parent/subproject` (.pi) to `parent/.crew` here while
	// paths.ts resolved the same cwd to `subproject/.pi/teams` (two roots).
	// The module has NO imports of its own, so it is safe under the jiti
	// namespace race documented at the top of this file.
	// RR-020 hardening (cold-verify round 2): the marker arrays are the ONE
	// critical-path dependency on a static import binding. Under the jiti
	// namespace race (issue #28) a binding can arrive undefined — degrade to the
	// narrow `.git`-only probe (findProjectRoot then returns undefined more
	// often, so computeCrewRoot anchors the crew root at the cwd — the same
	// fallback paths.ts uses) instead of throwing inside ensureCrewDirectory,
	// the very function hardened for #28. Mirrors the defensive style of
	// safeJoin/safeDirname/parseRoot and the lazy updateGitignore import.
	function markerLists(): { dirs: string[]; files: string[] } {
		try {
			if (Array.isArray(PROJECT_DIR_MARKERS) && Array.isArray(PROJECT_FILE_MARKERS)) {
				return { dirs: PROJECT_DIR_MARKERS as string[], files: PROJECT_FILE_MARKERS as string[] };
			}
		} catch {
			// namespace unavailable — fall through to the narrow probe
		}
		return { dirs: [".git"], files: [] };
	}
	const markers = markerLists();
	const hasMarker = (dir: string): boolean =>
		markers.dirs.some((marker) => fs.existsSync(safeJoin(dir, marker))) ||
		markers.files.some((marker) => fs.existsSync(safeJoin(dir, marker)));
	let current = safeResolve(start, pathDep);
	// RR-020 cold-verify follow-up: match findRepoRoot (paths.ts) which
	// realpaths the start BEFORE walking, so the boundary comparisons below
	// compare canonical-to-canonical (macOS /var -> /private/var). Best-effort:
	// ENOENT keeps the lexical path, exactly like findRepoRoot's fallback.
	try {
		current = fs.realpathSync(current);
	} catch {
		// keep the lexical resolution
	}
	// Use `parseRoot` (inlined above) to avoid `path.parse` for the critical
	// termination root — fixes the jiti namespace race in issue #28. Computed
	// from the RESOLVED `current` (post-realpath) so a root-prefix change
	// through a symlink cannot desync `current !== root` (paths.ts computes
	// path.parse on the realpath'd start for the same reason).
	const root = parseRoot(current);
	// RR-020 cold-verify follow-up (bug-029 parity): home/tmp boundary STOP.
	// computeRepoRoot (paths.ts) refuses to check markers at $HOME or the temp
	// root; this walk did not, so once the marker lists were unified onto the
	// wide set, `$HOME/.pi` (created by userPiRoot()) became a marker HERE — a
	// MARKERLESS cwd under $HOME resolved crew-init to $HOME (⇒
	// $HOME/.pi/teams) while projectCrewRoot resolved to <cwd>/.crew: the
	// two-roots bug Fix 1 was meant to kill, in a new shape. `os` access is
	// defensive: under the jiti namespace race (issue #28) the binding can be
	// undefined — degrade to "no boundary" (the pre-RR-020 walk), never crash.
	let home: string | undefined;
	let tempRoot: string | undefined;
	try {
		home = canonicalBoundary(os.homedir());
		tempRoot = canonicalBoundary(os.tmpdir());
	} catch {
		home = undefined;
		tempRoot = undefined;
	}
	const atBoundary = (dir: string): boolean => (home !== undefined && dir === home) || (tempRoot !== undefined && dir === tempRoot);
	// Walk up to find project root
	while (current !== root) {
		// Stop walking before checking markers at home or temp root.
		if (atBoundary(current)) return undefined;
		if (hasMarker(current)) return current;
		const parent = safeDirname(current);
		if (parent === current) break;
		current = parent;
	}
	// Check root as fallback
	if (atBoundary(root)) return undefined;
	if (hasMarker(root)) return root;
	return undefined;
}

/** Canonicalize a boundary dir for comparison with the (realpath'd) walk.
 *  Best-effort: an unresolvable path stays lexical. */
function canonicalBoundary(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Compute the crew root directory for a given working directory.
 * Matches src/utils/paths.ts:projectCrewRoot() logic.
 */
function computeCrewRoot(cwd: string): string {
	const repoRoot = findProjectRoot(cwd) ?? cwd;
	const crewDir = safeJoin(repoRoot, ".crew");
	// Keep existing .crew/ stable even when .pi/ exists for project config.
	if (fs.existsSync(crewDir)) return crewDir;
	// Legacy reuse: if .pi/ already exists, namespace under .pi/teams/
	const piDir = safeJoin(repoRoot, ".pi");
	return fs.existsSync(piDir) ? safeJoin(piDir, "teams") : crewDir;
}

/**
 * G23c (2026-10-02): sweep an empty legacy `.pi/teams` residue once the
 * project has migrated to the `.crew/` layout.
 *
 * When `.crew/` exists, `computeCrewRoot` resolves to `.crew/` and the
 * legacy `.pi/teams/` tree from an older pi-crew version is never revisited
 * — dead residue stays on disk forever (plan §G23c: "0 code dọn"). This
 * sweep is deliberately CONSERVATIVE because it deletes from the user's
 * workspace:
 *
 *   1. Fires ONLY when the active crew root is the `.crew` layout AND
 *      `<repoRoot>/.pi/teams` exists (a live legacy root is never touched).
 *   2. Removes the legacy tree ONLY when it is a bare pi-crew skeleton:
 *      known pi-crew directory names at every depth, and only placeholder
 *      files (`.gitkeep` anywhere; `README.md`/`.gitignore` at the root).
 *      Every entry is content-checked before anything is deleted.
 *   3. Any real data — a run manifest under `state/`, artifact content, a
 *      user-authored agent/workflow file, an unknown entry — keeps the
 *      residue in place with ONE info log line: auto-migrating run state
 *      would change the run-lookup path, which is too risky for an
 *      automatic sweep (leader/user decision).
 *   4. Never touches anything under `.pi/` other than the `teams/` path
 *      itself — the `.pi` parent and all siblings (`.pi/agent`, ...) stay.
 *
 * Self-contained by design: inline helpers only, no new module imports.
 * Any failure inside the sweep is logged and swallowed — init must never
 * break because the residue could not be inspected.
 */

/** Directory names pi-crew itself creates/uses under a crew root (any depth).
 *  Sources: ensureCrewDirectory (state/subagents/runs/artifacts/cache/graphs/
 *  audit), project-init.ts (agents/teams/workflows/imports), and the legacy
 *  .gitignore entries in gitignore-manager.ts (worktrees/imports). */
const LEGACY_TEAMS_SKELETON_DIRS = new Set([
	"state",
	"subagents",
	"runs",
	"artifacts",
	"cache",
	"graphs",
	"audit",
	"worktrees",
	"agents",
	"teams",
	"workflows",
	"imports",
]);

/** Placeholder files pi-crew itself writes at the crew-root level. */
const LEGACY_TEAMS_SKELETON_ROOT_FILES = new Set(["README.md", ".gitignore"]);

/**
 * True when `root` holds no data: every directory has a pi-crew skeleton
 * name and every file is a pi-crew placeholder. Anything else — run
 * manifests, artifacts, user agent/workflow content, unknown entries —
 * returns false (the caller then keeps the residue).
 */
function isBareLegacyTeamsSkeleton(root: string): boolean {
	const walk = (dir: string, depth: number): boolean => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			// Unreadable => assume data; never delete what we cannot inspect.
			return false;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!LEGACY_TEAMS_SKELETON_DIRS.has(entry.name)) return false;
				if (!walk(safeJoin(dir, entry.name), depth + 1)) return false;
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				// `.gitkeep` placeholders are written at any depth; README.md and
				// .gitignore only at the crew-root level. Any other file (run
				// manifest, artifact, user content) counts as data.
				if (entry.name === ".gitkeep") continue;
				if (depth === 0 && LEGACY_TEAMS_SKELETON_ROOT_FILES.has(entry.name)) continue;
				return false;
			} else {
				// Sockets/FIFOs/devices — unknown => keep.
				return false;
			}
		}
		return true;
	};
	return walk(root, 0);
}

/** See the G23c block comment above. Returns silently when there is nothing
 *  safe to sweep. */
function sweepLegacyTeamsResidue(cwd: string, activeCrewRoot: string): void {
	try {
		const repoRoot = findProjectRoot(cwd) ?? cwd;
		const legacyTeamsDir = safeJoin(repoRoot, ".pi", "teams");
		// Sweep only when the ACTIVE layout is `.crew` (computeCrewRoot did NOT
		// resolve to the legacy root) and a legacy tree actually exists.
		if (activeCrewRoot === legacyTeamsDir || !fs.existsSync(legacyTeamsDir)) return;
		if (isBareLegacyTeamsSkeleton(legacyTeamsDir)) {
			// Exact-path removal of `.pi/teams` only — the `.pi` parent and
			// every sibling under it stay untouched.
			fs.rmSync(legacyTeamsDir, { recursive: true, force: true });
			return;
		}
		console.info(
			`[pi-crew] legacy ${legacyTeamsDir} still contains data — kept in place (auto-migration would change the run-lookup path); remove manually once you no longer need it`,
		);
	} catch (error) {
		console.info(`[pi-crew] legacy .pi/teams residue sweep skipped: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Ensure the .crew directory structure exists with all required subdirectories,
 * placeholder files, README, and .gitignore entries.
 *
 * This function is self-contained with NO dependencies on other pi-crew modules.
 * It uses inline implementations of findProjectRoot and computeCrewRoot to avoid
 * module binding issues in child-process contexts.
 */
export async function ensureCrewDirectory(cwd: string): Promise<void> {
	const crewRoot = computeCrewRoot(cwd);

	// G23c: once `.crew/` is the active layout, sweep an empty legacy
	// `.pi/teams` skeleton left behind by an older pi-crew version.
	sweepLegacyTeamsResidue(cwd, crewRoot);

	// 1. Create directory structure
	const dirs = [
		crewRoot,
		safeJoin(crewRoot, "state", "runs"),
		safeJoin(crewRoot, "state", "subagents"),
		safeJoin(crewRoot, "artifacts"),
		safeJoin(crewRoot, "cache"),
		safeJoin(crewRoot, "graphs"),
		safeJoin(crewRoot, "audit"),
	];

	for (const dir of dirs) {
		// Use mkdirSync directly with recursive:true to avoid TOCTOU race.
		// This is atomic and doesn't require existsSync check.
		fs.mkdirSync(dir, { recursive: true });
	}

	// 2. Create .gitkeep placeholders in directories that should be tracked
	const placeholders = [
		safeJoin(crewRoot, "artifacts", ".gitkeep"),
		safeJoin(crewRoot, "cache", ".gitkeep"),
		safeJoin(crewRoot, "graphs", ".gitkeep"),
		safeJoin(crewRoot, "audit", ".gitkeep"),
	];

	for (const placeholder of placeholders) {
		if (!fs.existsSync(placeholder)) {
			atomicWriteFile(placeholder, "");
		}
	}

	// 3. Write README.md (always overwrite to keep it current)
	atomicWriteFile(safeJoin(crewRoot, "README.md"), buildCrewReadme());

	// 4. Update .gitignore at project root
	const repoRoot = findProjectRoot(cwd);
	if (repoRoot) {
		const gitignorePath = safeJoin(repoRoot, ".gitignore");
		// LAZY: dodge the jiti ESM/CJS interop TDZ race on the static `import { updateGitignore }` above (issue #28, RFC 17). At this point the module body has fully evaluated, so the dynamic import resolves to a live binding.
		const { updateGitignore: updateGitignoreFn } = await import("./gitignore-manager.ts");
		await updateGitignoreFn(gitignorePath);
	}
}

// Exported only for regression tests of issue #28.
// NOT part of the public API — the `__test__` prefix follows the project
// convention used in atomic-write.ts, state-store.ts, team-runner.ts, etc.
// See F-4 in the post-fix review for the convention rationale.
export const __test__internals = {
	parseRoot,
	safeJoin,
	safeDirname,
	safeResolve,
	findProjectRoot,
};
