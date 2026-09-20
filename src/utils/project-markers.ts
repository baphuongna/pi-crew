/**
 * project-markers.ts — SINGLE source of truth for the project-root marker lists.
 *
 * Why this module exists (RR-020 Fix 1): the marker lists were duplicated and
 * had DRIFTED apart:
 *   - `src/utils/paths.ts` (computeRepoRoot) used 15 markers (.pi/.crew/
 *     .factory/.omc + 8 build-file markers)
 *   - `src/state/crew-init.ts` (findProjectRoot) used 7 markers (.git/.hg/.svn
 *     + package.json/pyproject.toml/Cargo.toml/go.mod)
 * For cwd=`parent/subproject` where `parent/.git` and `parent/subproject/.pi`
 * exist, paths.ts resolved the root to `subproject` (→ `subproject/.pi/teams`)
 * while crew-init.ts walked past `.pi` up to `parent/.git` (→ `parent/.crew`),
 * so ONE run could end up with TWO roots (`run-intent.ts` → ensureCrewDirectory).
 * Both resolvers now read the lists from here.
 *
 * CONTRACT — do not break:
 *   - NO imports at all (plain string[] literals only). `crew-init.ts` is
 *     dynamically `import()`'d from concurrent child Pi subprocesses and under
 *     load jiti's ESM/CJS interop can leave namespace bindings `undefined`
 *     (issue #28). Importing anything here (even `node:path`) would re-introduce
 *     that race for the very module that was hardened against it.
 *   - Values must stay IDENTICAL to the historical `paths.ts` lists — they are
 *     the widest set, so unifying on them never resolves a root LOWER than
 *     before (the direction that would break existing projects).
 */

/** Directory names that mark a project root. */
export const PROJECT_DIR_MARKERS = [".git", ".pi", ".crew", ".hg", ".svn", ".factory", ".omc"];

/** Build-system file names that mark a project root. */
export const PROJECT_FILE_MARKERS = [
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"composer.json",
	"build.gradle",
	"build.gradle.kts",
];
