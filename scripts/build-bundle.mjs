#!/usr/bin/env node
/**
 * 5.5 — Bundle pi-crew into a single ESM file using esbuild.
 *
 * Output:
 *   dist/index.mjs        — bundled extension entrypoint
 *   dist/index.mjs.map    — source map
 *
 * Pi peer dependencies are kept external. Bundling shrinks parse+module-
 * resolution cost on cold start: with strip-types Node still has to parse
 * each .ts file individually, so a single .mjs cuts the per-file overhead.
 *
 * This script is invoked by `npm run build:bundle`. The `package.json#exports`
 * field is configured so:
 *   - `dist/index.mjs` is the preferred entrypoint when present (set by Pi
 *     extension loader via "pi.extensions").
 *   - `index.ts` remains the fallback when dist/ is missing (e.g. running
 *     directly out of a clone without prior build).
 */
import { build } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// PI_CREW_BUNDLE_OUT lets the committed-dist hash gate
// (scripts/check-bundle-staleness.mjs --committed-hash, WI-1.2) build a
// throwaway copy of the bundle into a scratch dir WITHOUT touching dist/ —
// required so that gate can hash the committed dist as-is (spec R2 P1-SEC-3
// clause 3: no rebuild before compare). The scratch dir MUST sit at the same
// depth as dist/ (directly under the repo root): esbuild computes sourcemap
// "sources" relative to the outfile, and matching dist/'s depth keeps the
// .map byte-identical to a dist/ build.
const outDirOverride = process.env.PI_CREW_BUNDLE_OUT;
const distDir = outDirOverride ? path.resolve(root, outDirOverride) : path.join(root, "dist");
fs.mkdirSync(distDir, { recursive: true });

const start = Date.now();
const result = await build({
	// Bundle entry must be the bare extension (index.bundle.ts) NOT the
	// entry shell (index.ts). If we bundled index.ts, the bundled code
	// would re-resolve dist/index.mjs relative to ITS OWN location
	// (file:///.../dist/index.mjs), producing dist/dist/index.mjs and a
	// recursion error. index.bundle.ts has no shell logic so this is
	// a clean single-file bundle. See index.bundle.ts header for details.
	entryPoints: [path.join(root, "index.bundle.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	outfile: path.join(distDir, "index.mjs"),
	// DP-02 (2026-09-22): minify the shipped bundle. Measured on this repo:
	// 3,443,033 B → 1,654,887 B (−52%) with the bundle-load / skill-resolution /
	// deps-consistency suites all green. Worker boot pays bundle-parse cost
	// (~55% of a 2.5 s boot per the 2026-09-18 b7 bench), so this is a direct
	// startup win as well as a git/budget win. `sourcemap: false` — the map is
	// opt-in via PI_CREW_BUNDLE_SOURCEMAP (see below) and no longer committed.
	minify: true,
	sourcemap: false,
	logLevel: "info",
	// Keep peer deps external so consumers' Pi versions resolve naturally.
	external: [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-tui",
		// Direct deps are kept external so we don't bundle their full graph —
		// EXCEPT @sinclair/typebox, which is INTENTIONALLY VENDORED (bundled in)
		// as of v0.9.58. Rationale: pi installs all extensions into one shared
		// npm store with hoisted deps, and `pi update` does NOT re-resolve
		// transitive deps when the extension version already matches latest.
		// pi-crew's compact StringEnum schema needs TypeRegistry (typebox
		// >= 0.34.50); a stale hoisted typebox (< 0.34.50) made `import
		// { TypeRegistry }` resolve to undefined and crashed extension load.
		// Bundling typebox makes pi-crew always run against the version it was
		// built with, fully immune to the store's typebox state — so ANY update
		// mechanism (`pi update --all|--extensions`, npm, manual) yields a
		// working, compact-path pi-crew. SAFE to bundle: the host pi/pi-ai use
		// the *unscoped* `typebox` package (not @sinclair/typebox) for their own
		// validation, so pi-crew's vendored copy never overlaps with pi-ai's
		// typebox instance — the two were already separate before this change.
		"cli-highlight",
		"diff",
		"jiti",
		"acorn",
		// esbuild must stay external: its CJS source references __filename/__dirname
		// (CJS globals) for self-location. Bundling it into the ESM .mjs makes those
		// undefined at runtime → "__filename is not defined" when the dynamic-workflow
		// runner (or strip-types loader) invokes esbuild transformSync. Keeping it
		// external lets it resolve from node_modules as proper CJS. (esbuild also
		// ships a native binary, which shouldn't be bundled anyway.)
		"esbuild",
	],
	// All node:* and Node-builtin modules are external by default for
	// platform=node, but list explicitly for clarity.
	//
	// CJS-shim banner: pi-crew's dependency graph includes CommonJS modules
	// (notably `yaml`) whose source calls `require("process")` etc. esbuild
	// emits these as runtime `__require(...)` calls; in a pure-ESM context
	// `require` is undefined, so we inject a `createRequire`-backed shim
	// at the top of the bundle. This is the standard pattern for shipping
	// CJS-mixed bundles as `.mjs`. See phase-2 H2 investigation (2026-06-30).
	banner: {
		js:
			"// pi-crew bundled by scripts/build-bundle.mjs (5.5)\n" +
			"// CJS-shim for legacy deps (yaml, etc.) that call require() in ESM context.\n" +
			"import { createRequire as __piCrewCreateRequire } from 'node:module';\n" +
			"const require = __piCrewCreateRequire(import.meta.url);\n" +
			"const module = { exports: {} };\n" +
			"const exports = module.exports;\n",
	},
	metafile: true,
});

// DP-02 (2026-09-22): the sourcemap is NOT written to dist/ anymore. It was
// ~8.3 MB committed to git while nobody consumed it from the repo (debug
// metadata). Set PI_CREW_BUNDLE_SOURCEMAP=1 to emit it (release builds attach
// it); the staleness gate treats an absent file on both sides as a match, so
// dropping it does not break dist verification.
if (process.env.PI_CREW_BUNDLE_SOURCEMAP === "1") {
	const { build: buildMap } = await import("esbuild");
	await buildMap({
		entryPoints: [path.join(root, "index.bundle.ts")],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		outfile: path.join(distDir, "index.mjs.map"),
		sourcemap: true,
		sourcesContent: false,
		minify: false,
		metafile: false,
		logLevel: "silent",
	});
}

// DP-02: build-meta.json is written ONLY when explicitly requested. It was
// ~785 KB of esbuild metafile committed to git with no in-repo consumer.
if (process.env.PI_CREW_BUNDLE_META === "1") {
	fs.writeFileSync(path.join(distDir, "build-meta.json"), JSON.stringify(result.metafile, null, 2) + "\n", "utf-8");
}
const elapsedMs = Date.now() - start;
const stat = fs.statSync(path.join(distDir, "index.mjs"));
console.log(`[build-bundle] dist/index.mjs ${(stat.size / 1024).toFixed(1)} KB in ${elapsedMs} ms`);
