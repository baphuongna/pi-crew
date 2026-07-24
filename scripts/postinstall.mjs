#!/usr/bin/env node
/**
 * Cross-platform postinstall orchestrator.
 *
 *   1. Build the ESM bundle (best-effort; on failure we log a fallback and
 *      let Pi fall back to strip-types loading).
 *   2. Install the bundled crew-vibes.ttf into the user fonts directory so
 *      the crew-vibes speed/capacity PUA glyphs render.
 *   3. Remove stale skill copies from ~/.pi/agent/skills/ (migration from
 *      the v0.9.47 copySkills() bug — see cleanupStaleSkillCopies()).
 *
 * Replaces the old `postinstall` shell chain so the font install runs on
 * every platform without relying on shell-specific chaining (`;`/`&&`).
 *
 * NOTE: skills are NOT copied here. Pi discovers skills natively from the
 * npm package dir (`~/.pi/agent/npm/node_modules/pi-crew/skills/`); copying
 * them to ~/.pi/agent/skills/ only creates duplicate "collision" warnings.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
 * Remove stale skill copies from ~/.pi/agent/skills/ that are byte-identical
 * to the bundled skills/ — left over from the v0.9.47 copySkills() postinstall
 * (which redundantly copied all skills, causing "collision" warnings).
 *
 * Pi discovers skills natively from the npm package dir, so these copies only
 * create noise AND can shadow newer package versions on upgrade.
 *
 * SAFE: only removes EXACT (byte-identical) copies. A skill the user has
 * customized (differs from the package) is preserved. Best-effort, never
 * fails the install.
 */
function cleanupStaleSkillCopies() {
	const srcSkillsDir = join(root, "skills");
	if (!existsSync(srcSkillsDir)) return;

	const destSkillsDir = join(homedir(), ".pi", "agent", "skills");
	if (!existsSync(destSkillsDir)) return;

	let removed = 0;
	let kept = 0;
	for (const entry of readdirSync(srcSkillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const srcSkillMd = join(srcSkillsDir, entry.name, "SKILL.md");
		if (!existsSync(srcSkillMd)) continue;
		const destSkillDir = join(destSkillsDir, entry.name);
		const destSkillMd = join(destSkillDir, "SKILL.md");
		if (!existsSync(destSkillMd)) continue;
		try {
			const srcContent = readFileSync(srcSkillMd, "utf8");
			const destContent = readFileSync(destSkillMd, "utf8");
			if (srcContent === destContent) {
				rmSync(destSkillDir, { recursive: true, force: true });
				removed++;
			} else {
				// User customized this skill — preserve it.
				kept++;
			}
		} catch {
			// best-effort: skip this skill on error
		}
	}
	if (removed > 0) {
		const note = kept > 0 ? ` (${kept} customized copy(ies) preserved)` : "";
		console.warn(
			`[pi-crew] postinstall: removed ${removed} stale skill cop${removed === 1 ? "y" : "ies"} from ~/.pi/agent/skills/${note}.`,
		);
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
		// Migration cleanup: remove stale skill copies from v0.9.47's copySkills().
		cleanupStaleSkillCopies();
	} catch (err) {
		// Postinstall must NEVER fail the install (SEC-M2).
		console.warn("[pi-crew] postinstall: best-effort step failed:", err instanceof Error ? err.message : err);
	}
}

main();
