import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// peer-dep.ts resolves @earendil-works/pi-coding-agent robustly across install
// layouts. See src/runtime/peer-dep.ts (split-scope install fix).
import { getAgentDir } from "../runtime/peer-dep.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { isSafePathId, resolveContainedPath, resolveRealContainedPath } from "../utils/safe-paths.ts";
import { parseSkillFrontmatter, validateSkillFrontmatter, type SkillValidationError } from "./validate.ts";

const PACKAGE_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

const CACHE_TTL_MS = 30_000; // 30 seconds
let cache: { skills: SkillDescriptor[]; cachedAt: number; cwd: string } | null = null;

export interface SkillDescriptor {
	name: string;
	description: string;
	/**
	 * Source of the skill. F6 (v0.7.9) adds the Agent Skills spec roots:
	 * - `project-pi` / `user-pi` — Pi's standard `.pi/skills/`
	 * - `project-agents` / `user-agents` — cross-tool Agent Skills spec (`.agents/skills/`)
	 * The original `project` / `package` are kept for back-compat.
	 */
	source: "project" | "package" | "project-pi" | "user-pi" | "project-agents" | "user-agents";
	path: string;
}

/**
 * F6 (v0.7.9): discover skills from all five roots (matching pi-subagents'
 * skill-loader so users authoring skills under either convention find them).
 * Roots, in precedence order (first hit wins):
 *   1. <cwd>/.pi/skills          (project, Pi standard)
 *   2. <cwd>/.agents/skills      (project, Agent Skills spec — agentskills.io)
 *   3. <cwd>/skills              (project, legacy pi-crew convention)
 *   4. <getAgentDir>/skills      (user, Pi standard)
 *   5. <homedir>/.agents/skills  (user, Agent Skills spec)
 *   6. <homedir>/.pi/skills      (user, legacy Pi — pre-standard)
 *   7. PACKAGE_SKILLS_DIR        (bundled, trusted)
 * The `PACKAGE_SKILLS_DIR` (bundled) and the legacy `<cwd>/skills` root are
 * kept as separate `source` values to preserve the existing capability
 * inventory shape — callers that key on `source === "package"` / `source ===
 * "project"` keep working.
 */
function listSkillDirs(cwd: string): Array<{ root: string; source: SkillDescriptor["source"] }> {
	return [
		{ root: path.resolve(cwd, ".pi", "skills"), source: "project-pi" },
		{ root: path.resolve(cwd, ".agents", "skills"), source: "project-agents" },
		{ root: path.resolve(cwd, "skills"), source: "project" },
		{ root: path.join(getAgentDir(), "skills"), source: "user-pi" },
		{ root: path.join(os.homedir(), ".agents", "skills"), source: "user-agents" },
		{ root: path.join(os.homedir(), ".pi", "skills"), source: "user-pi" },
		{ root: PACKAGE_SKILLS_DIR, source: "package" },
	];
}

// ── Diagnostics (L3) ──────────────────────────────────────────────────────────
// Module-level buffer populated each `discoverSkills()` call. Cleared at the
// start of every call so callers see only the most recent run's diagnostics.
// Surfaced via `getLastDiscoveryDiagnostics()` so capability-inventory and
// other consumers can convert silent exclusions into visible feedback.
let lastDiagnostics: SkillValidationError[] = [];

export function getLastDiscoveryDiagnostics(): SkillValidationError[] {
	return lastDiagnostics;
}

/**
 * Parse frontmatter defensively. Falls back to the legacy line-prefix match
 * if YAML parsing fails — preserves back-compat for malformed but readable
 * SKILL.md files that pre-date the validator (we record a diagnostic in that
 * case but still return the description we could salvage).
 */
function readDescription(content: string): { description: string; parseError: string | null } {
	const parsed = parseSkillFrontmatter(content);
	if (parsed.ok) {
		const d = parsed.data.description;
		return { description: typeof d === "string" ? d : "", parseError: null };
	}
	// YAML parse failed — fall back to legacy line-prefix match so we don't
	// regress existing skills whose frontmatter the old parser could read.
	const legacyMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (legacyMatch) {
		const line = legacyMatch[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));
		const fallback = line?.slice("description:".length).trim() ?? "";
		return { description: fallback, parseError: parsed.error };
	}
	return { description: "", parseError: parsed.error };
}

export function discoverSkills(cwd: string): SkillDescriptor[] {
	if (cache && cache.cwd === cwd && Date.now() - cache.cachedAt < CACHE_TTL_MS) return cache.skills;
	const results: SkillDescriptor[] = [];
	const diagnostics: SkillValidationError[] = [];
	for (const dir of listSkillDirs(cwd)) {
		if (!fs.existsSync(dir.root)) continue;
		try {
			for (const entry of fs.readdirSync(dir.root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (!isSafePathId(entry.name)) continue;
				const skillDirPath = path.join(dir.root, entry.name);
				try {
					if (fs.lstatSync(skillDirPath).isSymbolicLink()) continue;
				} catch { continue; }
				const skillMdRelative = path.join(entry.name, "SKILL.md");
				let skillMdPath: string;
				try {
					skillMdPath = resolveContainedPath(dir.root, skillMdRelative);
				} catch { continue; }
				if (!fs.existsSync(skillMdPath)) continue;
				try {
					if (fs.lstatSync(skillMdPath).isSymbolicLink()) continue;
				} catch { continue; }
				let description = "";
				try {
					let readPath = skillMdPath;
					try {
						readPath = resolveRealContainedPath(dir.root, skillMdRelative);
						skillMdPath = readPath;
					} catch {
						// resolveRealContainedPath may fail for symlinked system paths
						// (e.g. macOS /var → /private/var). Fall through with un-resolved path.
					}
					const content = fs.readFileSync(readPath, "utf-8");
					const { description: desc, parseError } = readDescription(content);
					description = desc;
					if (parseError) {
						diagnostics.push({
							path: path.dirname(skillMdPath),
							field: "frontmatter",
							reason: parseError,
							severity: "error",
						});
					}
				} catch (error) {
					logInternalError("discoverSkills.readSkill", error, `skill=${entry.name}`);
				}
				results.push({ name: entry.name, description, source: dir.source, path: skillMdPath });
			}
		} catch (error) {
			logInternalError("discoverSkills.readdir", error, `root=${dir.root}`);
		}
	}
	// L3: strict validation pass after we've collected every (skill, source)
	// candidate. Excludes malformed skills (HYBRID policy: missing/malformed
	// `name`/`description` hard-fail; unknown props warn). Diagnostics are
	// always recorded, including for skills that PASSED validation but had
	// unknown-prop warnings.
	const filtered: SkillDescriptor[] = [];
	for (const skill of results) {
		const validation = validateSkillFrontmatter(path.dirname(skill.path));
		if (validation.ok) {
			filtered.push(skill);
		} else {
			diagnostics.push(...validation.errors);
		}
	}
	lastDiagnostics = diagnostics;
	cache = { skills: filtered, cachedAt: Date.now(), cwd };
	return filtered;
}
