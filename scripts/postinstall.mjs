#!/usr/bin/env node
/**
 * Cross-platform postinstall orchestrator.
 *
 *   1. Build the ESM bundle (best-effort; on failure we log a fallback and
 *      let Pi fall back to strip-types loading).
 *   2. Install the bundled crew-vibes.ttf into the user fonts directory so
 *      the crew-vibes speed/capacity PUA glyphs render.
 *
 * Replaces the old `postinstall` shell chain so the font install runs on
 * every platform without relying on shell-specific chaining (`;`/`&&`).
 */
import { existsSync, spawnSync } from "node:child_process";
import { spawnSync as spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function run(scriptRel) {
	const abs = join(root, scriptRel);
	if (!existsSync(abs)) return 1;
	const result = spawn(process.execPath, [abs], { stdio: "inherit" });
	return result.status ?? 1;
}

function main() {
	// Dev clones ship scripts/build-bundle.mjs and devDeps (esbuild) so the
	// bundle rebuilds; published packages omit both and rely on committed
	// dist/index.mjs, so this best-effort build simply no-ops.
	const bundleStatus = run("scripts/build-bundle.mjs");
	if (bundleStatus !== 0) {
		console.warn(
			"[pi-crew] postinstall: bundle build skipped or failed; using committed dist/ (or strip-types fallback). Run npm run build:bundle to retry.",
		);
	}
	// Font install is best-effort and must never fail the install.
	run("scripts/install-crew-vibes-font.mjs");
}

main();
