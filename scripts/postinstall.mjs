#!/usr/bin/env node
/**
 * Cross-platform postinstall orchestrator.
 *
 *   1. Build the ESM bundle (best-effort; on failure we log a fallback and
 *      let Pi fall back to strip-types loading).
 *   2. Install the bundled crew-vibes.ttf into the user fonts directory so
 *      the crew-vibes speed/capacity PUA glyphs render.
 *   3. Copy bundled skills to ~/.pi/agent/skills/ so they are available
 *      globally (not just inside the pi-crew project).
 *
 * Replaces the old `postinstall` shell chain so the font install runs on
 * every platform without relying on shell-specific chaining (`;`/`&&`).
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function run(scriptRel) {
	const abs = join(root, scriptRel);
	if (!existsSync(abs)) return 1;
	const result = spawnSync(process.execPath, [abs], { stdio: "inherit" });
	return result.status ?? 1;
}

/**
 * Copy each skill directory from pi-crew/skills/ to ~/.pi/agent/skills/.
 * Best-effort: must never fail the install.
 */
function copySkills() {
	const srcSkillsDir = join(root, "skills");
	if (!existsSync(srcSkillsDir)) return;

	const destSkillsDir = join(homedir(), ".pi", "agent", "skills");
	try {
		mkdirSync(destSkillsDir, { recursive: true });
	} catch {
		return; // can't create dest — skip silently
	}

	for (const entry of readdirSync(srcSkillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skillMd = join(srcSkillsDir, entry.name, "SKILL.md");
		if (!existsSync(skillMd)) continue;
		try {
			cpSync(join(srcSkillsDir, entry.name), join(destSkillsDir, entry.name), {
				recursive: true,
			});
		} catch {
			// best-effort: skip this skill on error
		}
	}
}

function main() {
	try {
		// Dev clones ship scripts/build-bundle.mjs and devDeps (esbuild) so the
		// bundle rebuilds; published packages omit both and rely on committed
		// dist/index.mjs, so this best-effort build simply no-ops.
		const bundleStatus = run("scripts/build-bundle.mjs");
		if (bundleStatus !== 0) {
			// TB-11: Surface bundle failures loudly to stderr instead of console.warn,
			// which can scroll off in noisy install logs. We still don't `process.exit(1)`
			// here — the install itself must succeed via the strip-types fallback —
			// but the failure must be obvious to whoever runs `npm install`.
			process.stderr.write(
				"\u001b[31m[pi-crew] postinstall: bundle build FAILED\u001b[0m — using committed dist/ (or strip-types fallback). Run 'npm run build:bundle' to retry. See logs above for esbuild errors.\n",
			);
		}
		// Font install is best-effort and must never fail the install.
		run("scripts/install-crew-vibes-font.mjs");
		// Copy bundled skills to ~/.pi/agent/skills/ for global availability.
		copySkills();
	} catch (err) {
		// Postinstall must NEVER fail the install (SEC-M2).
		console.warn("[pi-crew] postinstall: best-effort step failed:", err instanceof Error ? err.message : err);
	}
}

main();
