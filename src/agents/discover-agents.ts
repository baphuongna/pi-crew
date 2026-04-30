import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, ResourceSource } from "./agent-config.ts";
import { loadConfig } from "../config/config.ts";
import { parseCsv, parseFrontmatter } from "../utils/frontmatter.ts";
import { packageRoot, projectCrewRoot, userPiRoot } from "../utils/paths.ts";

export interface AgentDiscoveryResult {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
}

function parseCost(value: string | undefined): "free" | "cheap" | "expensive" | undefined {
	return value === "free" || value === "cheap" || value === "expensive" ? value : undefined;
}

function parseMemory(value: string | undefined): "user" | "project" | "local" | undefined {
	return value === "user" || value === "project" || value === "local" ? value : undefined;
}

function parseAgentFile(filePath: string, source: ResourceSource): AgentConfig | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);
		const name = frontmatter.name?.trim() || path.basename(filePath, path.extname(filePath));
		const description = frontmatter.description?.trim() || "No description provided.";
		const triggers = parseCsv(frontmatter.triggers ?? frontmatter.trigger);
		const useWhen = parseCsv(frontmatter.useWhen);
		const avoidWhen = parseCsv(frontmatter.avoidWhen);
		const cost = parseCost(frontmatter.cost);
		const category = frontmatter.category?.trim() || undefined;
		return {
			name,
			description,
			source,
			filePath,
			systemPrompt: body.trim(),
			model: frontmatter.model || undefined,
			fallbackModels: parseCsv(frontmatter.fallbackModels),
			thinking: frontmatter.thinking || undefined,
			tools: parseCsv(frontmatter.tools),
			extensions: frontmatter.extensions === "" ? [] : parseCsv(frontmatter.extensions),
			skills: parseCsv(frontmatter.skills ?? frontmatter.skill),
			systemPromptMode: frontmatter.systemPromptMode === "append" ? "append" : "replace",
			inheritProjectContext: frontmatter.inheritProjectContext === "true",
			inheritSkills: frontmatter.inheritSkills === "true",
			memory: parseMemory(frontmatter.memory),
			disabled: frontmatter.disabled === "true" || frontmatter.enabled === "false",
			routing: triggers || useWhen || avoidWhen || cost || category ? { triggers, useWhen, avoidWhen, cost, category } : undefined,
		};
	} catch {
		return undefined;
	}
}

function readAgentDir(dir: string, source: ResourceSource): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((entry) => entry.endsWith(".md") && !entry.endsWith(".team.md") && !entry.endsWith(".workflow.md"))
		.map((entry) => parseAgentFile(path.join(dir, entry), source))
		.filter((agent): agent is AgentConfig => agent !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));
}

function applyAgentOverrides(agents: AgentConfig[], cwd: string): AgentConfig[] {
	const loaded = loadConfig(cwd);
	const config = loaded.config.agents;
	const overrides = config?.overrides ?? {};
	return agents
		.filter((agent) => !(config?.disableBuiltins && agent.source === "builtin"))
		.map((agent) => {
			const overrideEntry = Object.entries(overrides).find(([name]) => name.toLowerCase() === agent.name.toLowerCase());
			if (!overrideEntry) return agent;
			const [, override] = overrideEntry;
			return {
				...agent,
				disabled: override.disabled ?? agent.disabled,
				model: override.model === false ? undefined : override.model ?? agent.model,
				fallbackModels: override.fallbackModels === false ? undefined : override.fallbackModels ?? agent.fallbackModels,
				thinking: override.thinking === false ? undefined : override.thinking ?? agent.thinking,
				tools: override.tools === false ? undefined : override.tools ?? agent.tools,
				override: { source: "config", path: loaded.path },
			};
		});
}

export function discoverAgents(cwd: string): AgentDiscoveryResult {
	return {
		builtin: applyAgentOverrides(readAgentDir(path.join(packageRoot(), "agents"), "builtin"), cwd),
		user: applyAgentOverrides(readAgentDir(path.join(userPiRoot(), "agents"), "user"), cwd),
		project: applyAgentOverrides(readAgentDir(path.join(projectCrewRoot(cwd), "agents"), "project"), cwd),
	};
}

export function allAgents(discovery: AgentDiscoveryResult): AgentConfig[] {
	const byName = new Map<string, AgentConfig>();
	for (const agent of [...discovery.project, ...discovery.builtin, ...discovery.user]) {
		byName.set(agent.name.toLowerCase(), agent);
	}
	return [...byName.values()].filter((agent) => !agent.disabled).sort((a, b) => a.name.localeCompare(b.name));
}
