import type { RoleToolConfig } from "../config/role-tools.ts";
import { getToolConfig } from "../config/role-tools.ts";

export type ResourceSource = "builtin" | "user" | "project" | "git" | "dynamic";

export interface RoutingMetadata {
	triggers?: string[];
	useWhen?: string[];
	avoidWhen?: string[];
	cost?: "free" | "cheap" | "expensive";
	category?: string;
}

export interface AgentConfig {
	name: string;
	description: string;
	source: ResourceSource;
	filePath: string;
	systemPrompt: string;
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	skills?: string[];
	systemPromptMode?: "replace" | "append";
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	routing?: RoutingMetadata;
	memory?: "user" | "project" | "local";
	/** Tool loading strategy: "essential" = always load all tools, "lean" = only load tools in defaultTools list */
	loadMode?: "essential" | "lean";
	/** Explicit tool list when loadMode is "lean". null means all available tools. */
	defaultTools?: string[] | null;
	/** Context mode: "fresh" = clean start, "fork" = inherit parent session context */
	contextMode?: "fresh" | "fork";
	/** Maximum turns for this agent. Overrides runtime config if set. */
	maxTurns?: number;
	/** Effort level for this agent. Controls how much work the agent puts in. */
	effort?: "low" | "medium" | "high";
	/** Tools to explicitly forbid for this agent. Takes precedence over allowedTools. */
	disallowedTools?: string[];
	disabled?: boolean;
	override?: { source: "config"; path: string };
}

/**
 * Get session options (tools/excludeTools) for a specific role.
 * Used by child-pi to apply role-based tool restrictions.
 */
export function getAgentSessionOptions(role: string): {
	tools?: string[];
	excludeTools?: string[];
} {
	const config: RoleToolConfig = getToolConfig(role);

	if (config.tools || config.excludeTools) {
		return {
			tools: config.tools,
			excludeTools: config.excludeTools,
		};
	}

	return {};
}

/**
 * Build agent session options including role-based tool restrictions.
 * @param agent - The agent configuration
 * @param role - The role name to use for tool restrictions (defaults to agent.name)
 */
/** @internal */
function buildAgentSessionOptions(
	agent: AgentConfig,
	role?: string,
): {
	tools?: string[];
	excludeTools?: string[];
} {
	const effectiveRole = role ?? agent.name;
	return getAgentSessionOptions(effectiveRole);
}
