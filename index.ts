/**
 * pi-crew entrypoint — v0.9.17+ bundle-as-default.
 *
 * Resolution order:
 *   1. dist/index.mjs (bundle) when present AND not explicitly disabled.
 *      Default since v0.9.17 close-out — benchmarks show bundle is
 *      ~19% faster total cold-start (post-fsync) than strip-types.
 *      See `scripts/bench-cold-start.mjs` for reproducible numbers.
 *   2. Inline strip-types loading — fallback when bundle is missing
 *      (e.g. dev clone without `npm run build:bundle`) OR when
 *      `PI_CREW_USE_BUNDLE=0` is set explicitly.
 *
 * The fallback path is permissive — slow beats broken. Strip-types
 * works even if npm install postinstall (which auto-builds the
 * bundle) was skipped or failed.
 *
 * Env var semantics:
 *   - unset / empty     → use bundle if present, else strip-types
 *   - "1" / "true" / "yes" / "on"  → force bundle (same as unset when
 *     bundle is present; logs a warning if bundle is missing)
 *   - "0" / "false" / "no" / "off" → force strip-types, ignore bundle
 *
 * Bundle is built by `scripts/build-bundle.mjs` from `index.bundle.ts`
 * (a separate minimal entry — see that file's header for why we don't
 * bundle from this index.ts directly).
 *
 * Design notes:
 *   - Dynamic `await import` for the bundle path keeps the strip-types
 *     path cheap when bundle is unavailable.
 *   - We never read this env var inside the bundle itself; the check
 *     is entrypoint-only.
 *   - Build automation: `npm install` runs `postinstall` which calls
 *     `npm run build:bundle || warn` so users get a working bundle
 *     out of the box.
 *
 * History:
 *   - v0.9.16 and earlier: pure strip-types.
 *   - v0.9.17 alpha (`06f16d7`): bundle default + strip-types fallback
 *     (initial flip). Benchmarked at 5% faster pre-fsync.
 *   - v0.9.17 beta (`ae01851`): reverted to opt-in after cost-benefit
 *     review at 5% speedup.
 *   - v0.9.17 final (this commit): flipped back to default after
 *     atomic-write fsync fix (`13f4490`) bumped bundle speedup to
 *     19% (post-fsync bench). Combined with the now-mature safety
 *     net (conflict-markers gate, bundle-staleness gate, graceful
 *     fallback, packageRoot heuristic, separate bundle entry to
 *     avoid recursion), the bundle flip risk is acceptable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTeams as registerPiTeamsFromSrc } from "./src/extension/register.ts";
import { waitForRun as waitForRunFromSrc } from "./src/runtime/run-tracker.ts";
import { accessSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Minimal bundle shape — we only use a few named exports. Keep this loose
// because dist/index.mjs has no .d.ts (it's a build artifact, not source).
type BundleModule = {
	default?: (pi: ExtensionAPI) => void;
	waitForRun?: typeof waitForRunFromSrc;
	registerPiTeams?: (pi: ExtensionAPI) => void;
};

const OPT_OUT = new Set(["0", "false", "no", "off"]);
const OPT_IN = new Set(["1", "true", "yes", "on"]);

const envRaw = (process.env.PI_CREW_USE_BUNDLE ?? "").toLowerCase();
const envForceOff = OPT_OUT.has(envRaw);
const envForceOn = OPT_IN.has(envRaw);

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, "dist", "index.mjs");

let bundleModule: BundleModule | undefined;
if (!envForceOff) {
	try {
		accessSync(bundlePath);
		bundleModule = await import(bundlePath);
	} catch {
		if (envForceOn) {
			// User explicitly opted in but bundle is missing. Loud warning
			// so they can fix the build step. (When envForceOn is false,
			// missing bundle is the expected state for dev clones and
			// we silently fall through — no log spam.)
			console.warn(
				`[pi-crew] PI_CREW_USE_BUNDLE=1 but ${bundlePath} missing or unreadable; ` +
					`falling back to strip-types. Run \`npm run build:bundle\` to build.`,
			);
		}
		bundleModule = undefined;
	}
}

export const waitForRun = bundleModule?.waitForRun ?? waitForRunFromSrc;
export const registerPiTeams: (pi: ExtensionAPI) => void =
	bundleModule?.registerPiTeams ?? registerPiTeamsFromSrc;

export default bundleModule?.default ?? ((pi: ExtensionAPI) => registerPiTeamsFromSrc(pi));