import type { AgentConfig } from "../agents/agent-config.ts";
import type { SkillDescriptor } from "../skills/discover-skills.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import type { WorkflowConfig } from "../workflows/workflow-config.ts";
import { adapterRegistry } from "./registry.ts";
import type { ExportContent } from "./types.ts";

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function agentToExportContent(agent: AgentConfig): ExportContent {
	const category = agent.routing?.category ?? "agent";
	const tags = agent.routing?.triggers ?? [];
	return {
		id: slugify(agent.name),
		name: agent.name,
		description: agent.description,
		category,
		tags,
		body: agent.systemPrompt,
		source: { type: "agent", name: agent.name },
	};
}

export function teamToExportContent(team: TeamConfig): ExportContent {
	const category = team.routing?.category ?? "team";
	const tags = team.routing?.triggers ?? [];
	const rolesDesc = team.roles.map((role) => `- **${role.name}**: ${role.description ?? role.agent}`).join("\n");
	const body = `${team.description}\n\n### Roles\n${rolesDesc}`;
	return {
		id: slugify(team.name),
		name: team.name,
		description: team.description,
		category,
		tags,
		body,
		source: { type: "team", name: team.name },
	};
}

export function workflowToExportContent(workflow: WorkflowConfig): ExportContent {
	const stepsDesc = workflow.steps.map((step) => `- **${step.id}** (${step.role}): ${step.task}`).join("\n");
	const body = `${workflow.description}\n\n### Steps\n${stepsDesc}`;
	return {
		id: slugify(workflow.name),
		name: workflow.name,
		description: workflow.description,
		category: "workflow",
		tags: [],
		body,
		source: { type: "workflow", name: workflow.name },
	};
}

export function skillToExportContent(skill: SkillDescriptor): ExportContent {
	return {
		id: slugify(skill.name),
		name: skill.name,
		description: skill.description || `Skill: ${skill.name}`,
		category: "skill",
		tags: [],
		body: `Skill loaded from ${skill.source}: ${skill.path}`,
		source: { type: "skill", name: skill.name },
	};
}

export type ExportableResource =
	| { kind: "agent"; config: AgentConfig }
	| { kind: "team"; config: TeamConfig }
	| { kind: "workflow"; config: WorkflowConfig }
	| { kind: "skill"; config: SkillDescriptor };

export function resourcesToExportContent(resources: ExportableResource[]): ExportContent[] {
	const results: ExportContent[] = [];
	for (const resource of resources) {
		switch (resource.kind) {
			case "agent":
				results.push(agentToExportContent(resource.config));
				break;
			case "team":
				results.push(teamToExportContent(resource.config));
				break;
			case "workflow":
				results.push(workflowToExportContent(resource.config));
				break;
			case "skill":
				results.push(skillToExportContent(resource.config));
				break;
		}
	}
	return results;
}

export interface ToolExportResult {
	toolId: string;
	files: Array<{ path: string; content: string }>;
}

export function generateToolExport(toolId: string, resources: ExportableResource[], projectRoot?: string): ToolExportResult {
	const adapter = adapterRegistry.get(toolId);
	if (!adapter) {
		throw new Error(
			`Unknown export adapter: ${toolId}. Available: ${adapterRegistry
				.getAll()
				.map((a) => a.toolId)
				.join(", ")}`,
		);
	}
	const contents = resourcesToExportContent(resources);
	const files = contents.map((content): { path: string; content: string } => {
		const filePath = adapter.getFilePath(content);
		// Validate path containment when a project root is provided
		if (projectRoot) {
			try {
				resolveRealContainedPath(projectRoot, filePath);
			} catch (e) {
				throw new Error(
					`Export path '${filePath}' escapes project root '${projectRoot}': ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
		return {
			path: filePath,
			content: adapter.formatFile(content),
		};
	});
	// Merge duplicate file paths (e.g., codex adapter maps everything to AGENTS.md)
	const merged = new Map<string, string>();
	for (const f of files) {
		const existing = merged.get(f.path);
		merged.set(f.path, existing ? `${existing}\n\n${f.content}` : f.content);
	}
	const mergedFiles = [...merged.entries()].map(([p, content]) => ({
		path: p,
		content,
	}));
	return { toolId, files: mergedFiles };
}
