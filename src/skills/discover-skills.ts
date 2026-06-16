import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { logInternalError } from "../utils/internal-error.ts";
import { isSafePathId, resolveContainedPath, resolveRealContainedPath } from "../utils/safe-paths.ts";

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

function frontmatterDescription(content: string): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return undefined;
	const line = match[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));
	return line?.slice("description:".length).trim();
}

export function discoverSkills(cwd: string): SkillDescriptor[] {
	if (cache && cache.cwd === cwd && Date.now() - cache.cachedAt < CACHE_TTL_MS) return cache.skills;
	const results: SkillDescriptor[] = [];
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
					description = frontmatterDescription(content) ?? "";
				} catch (error) {
					logInternalError("discoverSkills.readSkill", error, `skill=${entry.name}`);
				}
				results.push({ name: entry.name, description, source: dir.source, path: skillMdPath });
			}
		} catch (error) {
			logInternalError("discoverSkills.readdir", error, `root=${dir.root}`);
		}
	}
	cache = { skills: results, cachedAt: Date.now(), cwd };
	return results;
}
