import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logInternalError } from "../utils/internal-error.ts";
import { isSafePathId, resolveContainedPath, resolveRealContainedPath } from "../utils/safe-paths.ts";

const PACKAGE_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

export interface SkillDescriptor {
	name: string;
	description: string;
	source: "project" | "package";
	path: string;
}

function listSkillDirs(cwd: string): Array<{ root: string; source: "project" | "package" }> {
	return [
		{ root: path.resolve(cwd, "skills"), source: "project" },
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
					const realPath = resolveRealContainedPath(dir.root, skillMdRelative);
					const content = fs.readFileSync(realPath, "utf-8");
					description = frontmatterDescription(content) ?? "";
					skillMdPath = realPath;
				} catch (error) {
					logInternalError("discoverSkills.readSkill", error, `skill=${entry.name}`);
				}
				results.push({ name: entry.name, description, source: dir.source, path: skillMdPath });
			}
		} catch (error) {
			logInternalError("discoverSkills.readdir", error, `root=${dir.root}`);
		}
	}
	return results;
}
