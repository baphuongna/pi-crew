/**
 * Bundle entry point — NO shell logic.
 *
 * Bundled by `scripts/build-bundle.mjs` into `dist/index.mjs`. Keep this
 * file minimal — the bundle should NOT try to recursively load itself
 * or do path resolution. The shell (load-with-fallback) lives in
 * `index.ts`; this file just re-exports the inner extension API so the
 * bundle is a single self-contained module the shell can `import()`.
 *
 * Why a separate file from `index.ts`:
 *   - `index.ts` runs at the package root and resolves `dist/index.mjs`
 *     relative to its own location.
 *   - If the bundle were built FROM `index.ts`, the bundled code would
 *     resolve `dist/index.mjs` relative to ITS OWN location (inside
 *     `dist/`), producing `dist/dist/index.mjs` and a recursion error.
 *   - Building from `index.bundle.ts` (which has no shell) sidesteps
 *     this chicken-and-egg entirely.
 */
import { registerPiTeams } from "./src/extension/register.ts";
import { waitForRun } from "./src/runtime/run-tracker.ts";

export { waitForRun, registerPiTeams };
export default function (pi: Parameters<typeof registerPiTeams>[0]): void {
	registerPiTeams(pi);
}