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

const distDir = path.join(root, "dist");
fs.mkdirSync(distDir, { recursive: true });

const start = Date.now();
const result = await build({
	entryPoints: [path.join(root, "index.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	outfile: path.join(distDir, "index.mjs"),
	sourcemap: true,
	logLevel: "info",
	// Keep peer deps external so consumers' Pi versions resolve naturally.
	external: [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-tui",
		// Direct deps as well — bundling their full graph would inflate the
		// output and override consumer-installed versions.
		"cli-highlight",
		"diff",
		"jiti",
		"typebox",
	],
	// All node:* and Node-built-in modules are external by default for
	// platform=node, but list explicitly for clarity.
	banner: { js: "// pi-crew bundled by scripts/build-bundle.mjs (5.5)" },
	metafile: true,
});

fs.writeFileSync(path.join(distDir, "build-meta.json"), JSON.stringify(result.metafile, null, 2) + "\n", "utf-8");
const elapsedMs = Date.now() - start;
const stat = fs.statSync(path.join(distDir, "index.mjs"));
console.log(`[build-bundle] dist/index.mjs ${(stat.size / 1024).toFixed(1)} KB in ${elapsedMs} ms`);
