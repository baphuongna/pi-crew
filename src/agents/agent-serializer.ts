import type { AgentConfig } from "./agent-config.ts";

function line(key: string, value: string | boolean | string[] | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return `${key}: ${value.join(", ")}`;
	return `${key}: ${String(value)}`;
}

export function serializeAgent(agent: AgentConfig): string {
	const lines = [
		"---",
		`name: ${agent.name}`,
		`description: ${agent.description}`,
		line("model", agent.model),
		line("fallbackModels", agent.fallbackModels),
		line("thinking", agent.thinking),
		line("tools", agent.tools),
		line("scratchpad", agent.scratchpad),
		agent.extensions !== undefined ? (line("extensions", agent.extensions) ?? "extensions:") : undefined,
		line("skills", agent.skills),
		line("systemPromptMode", agent.systemPromptMode),
		line("inheritProjectContext", agent.inheritProjectContext),
		line("inheritSkills", agent.inheritSkills),
		line("memory", agent.memory),
		line("loadMode", agent.loadMode),
		line("defaultTools", agent.defaultTools ?? undefined),
		line("contextMode", agent.contextMode),
		line("triggers", agent.routing?.triggers),
		line("useWhen", agent.routing?.useWhen),
		line("avoidWhen", agent.routing?.avoidWhen),
		line("cost", agent.routing?.cost),
		line("category", agent.routing?.category),
		"---",
		"",
		agent.systemPrompt.trim(),
		"",
	].filter((entry): entry is string => entry !== undefined);
	return lines.join("\n");
}
