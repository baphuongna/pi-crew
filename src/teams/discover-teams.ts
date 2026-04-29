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

function parseRoleLine(line: string): TeamRole | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("-")) return undefined;
	const value = trimmed.slice(1).trim();
	if (!value) return undefined;
	const [namePart, restPart] = value.split(":", 2);
	const name = namePart?.trim();
	if (!name) return undefined;
	const agentMatch = restPart?.match(/agent\s*=\s*([\w-]+)/);
	return {
		name,
		agent: agentMatch?.[1] ?? name,
		description: restPart?.replace(/agent\s*=\s*[\w-]+/, "").trim() || undefined,
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
			workspaceMode: frontmatter.workspaceMode === "worktree" ? "worktree" : "single",
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
	for (const team of [...discovery.builtin, ...discovery.user, ...discovery.project]) {
		byName.set(team.name, team);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
