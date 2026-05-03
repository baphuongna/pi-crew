import * as fs from "node:fs";
import * as path from "node:path";
import type { ResourceSource } from "../agents/agent-config.ts";
import type { TeamConfig, TeamRole } from "./team-config.ts";
import { parseCsv, parseFrontmatter } from "../utils/frontmatter.ts";
import { parseGitUrl } from "../utils/git.ts";
import { packageRoot, projectCrewRoot, userPiRoot } from "../utils/paths.ts";

export interface TeamDiscoveryResult {
	builtin: TeamConfig[];
	user: TeamConfig[];
	project: TeamConfig[];
}

function parseRoleSkills(value: string | undefined): string[] | false | undefined {
	if (!value) return undefined;
	if (value === "false") return false;
	const skills = value.split(",").map((entry) => entry.trim()).filter(Boolean);
	return skills.length ? skills : undefined;
}

function parseRoleLine(line: string): TeamRole | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("-")) return undefined;
	const value = trimmed.slice(1).trim();
	if (!value) return undefined;
	const separator = value.indexOf(":");
	const namePart = separator >= 0 ? value.slice(0, separator) : value;
	const restPart = separator >= 0 ? value.slice(separator + 1) : "";
	const name = namePart.trim();
	if (!name) return undefined;
	const metadata: Record<string, string> = {};
	let descriptionSource = restPart.replace(/\bskills\s*=\s*([\w-]+(?:\s*,\s*[\w-]+)*)/g, (_match, raw: string) => {
		metadata.skills = raw.replace(/\s*,\s*/g, ",").trim();
		return "";
	});
	descriptionSource = descriptionSource.replace(/\b(agent|model|maxConcurrency)\s*=\s*(\S+)/g, (_match, key: string, raw: string) => {
		metadata[key] = raw.trim();
		return "";
	});
	const description = descriptionSource.replace(/\s+/g, " ").trim() || undefined;
	const maxConcurrency = metadata.maxConcurrency ? (() => { const p = Number.parseInt(metadata.maxConcurrency, 10); return p > 0 ? p : undefined; })() : undefined;
	return {
		name,
		agent: metadata.agent ?? name,
		description,
		model: metadata.model,
		skills: parseRoleSkills(metadata.skills),
		maxConcurrency: maxConcurrency && maxConcurrency > 0 ? maxConcurrency : undefined,
	};
}

function parseCost(value: string | undefined): "free" | "cheap" | "expensive" | undefined {
	return value === "free" || value === "cheap" || value === "expensive" ? value : undefined;
}

function parseTeamSource(rawSource: string | undefined, fallback: ResourceSource): { source: ResourceSource; sourceUrl: string | undefined } {
	if (!rawSource) return { source: fallback, sourceUrl: undefined };
	const parsed = parseGitUrl(rawSource);
	if (!parsed) return { source: fallback, sourceUrl: undefined };
	return { source: "git", sourceUrl: parsed.repo };
}

function parseTeamFile(filePath: string, source: ResourceSource): TeamConfig | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);
		const name = frontmatter.name?.trim() || path.basename(filePath, ".team.md");
		const roles = body.split("\n").map(parseRoleLine).filter((role): role is TeamRole => role !== undefined);
		const triggers = parseCsv(frontmatter.triggers ?? frontmatter.trigger);
		const useWhen = parseCsv(frontmatter.useWhen);
		const avoidWhen = parseCsv(frontmatter.avoidWhen);
		const cost = parseCost(frontmatter.cost);
		const category = frontmatter.category?.trim() || undefined;
		const sourceInfo = parseTeamSource(frontmatter.source, source);
		return {
			name,
			description: frontmatter.description?.trim() || "No description provided.",
			source: sourceInfo.source,
			sourceUrl: sourceInfo.sourceUrl,
			filePath,
			roles,
			defaultWorkflow: frontmatter.defaultWorkflow || frontmatter.workflow || undefined,
			workspaceMode: frontmatter.workspaceMode?.trim() === "worktree" ? "worktree" : "single",
			maxConcurrency: frontmatter.maxConcurrency ? Number.parseInt(frontmatter.maxConcurrency, 10) : undefined,
			routing: triggers || useWhen || avoidWhen || cost || category ? { triggers, useWhen, avoidWhen, cost, category } : undefined,
		};
	} catch {
		return undefined;
	}
}

function readTeamDir(dir: string, source: ResourceSource): TeamConfig[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((entry) => entry.endsWith(".team.md"))
		.map((entry) => parseTeamFile(path.join(dir, entry), source))
		.filter((team): team is TeamConfig => team !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverTeams(cwd: string): TeamDiscoveryResult {
	return {
		builtin: readTeamDir(path.join(packageRoot(), "teams"), "builtin"),
		user: readTeamDir(path.join(userPiRoot(), "teams"), "user"),
		project: readTeamDir(path.join(projectCrewRoot(cwd), "teams"), "project"),
	};
}

export function allTeams(discovery: TeamDiscoveryResult): TeamConfig[] {
	const byName = new Map<string, TeamConfig>();
	for (const team of [...discovery.project, ...discovery.builtin, ...discovery.user]) {
		byName.set(team.name, team);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
