import type { TeamConfig, TeamRole } from "./team-config.ts";

function line(key: string, value: string | string[] | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return `${key}: ${value.join(", ")}`;
	return `${key}: ${value}`;
}

function serializeRole(role: TeamRole): string {
	const parts = [`agent=${role.agent}`];
	if (role.model) parts.push(`model=${role.model}`);
	if (role.skills === false) parts.push("skills=false");
	else if (role.skills?.length) parts.push(`skills=${role.skills.join(",")}`);
	if (role.maxConcurrency !== undefined) parts.push(`maxConcurrency=${role.maxConcurrency}`);
	if (role.description) parts.push(role.description);
	return `- ${role.name}: ${parts.join(" ")}`;
}

export function serializeTeam(team: TeamConfig): string {
	const lines = [
		"---",
		`name: ${team.name}`,
		`description: ${team.description}`,
		team.defaultWorkflow ? `defaultWorkflow: ${team.defaultWorkflow}` : undefined,
		team.workspaceMode ? `workspaceMode: ${team.workspaceMode}` : undefined,
		team.maxConcurrency !== undefined ? `maxConcurrency: ${team.maxConcurrency}` : undefined,
		team.observability !== undefined ? `observability: ${team.observability}` : undefined,
		line("triggers", team.routing?.triggers),
		line("useWhen", team.routing?.useWhen),
		line("avoidWhen", team.routing?.avoidWhen),
		line("cost", team.routing?.cost),
		line("category", team.routing?.category),
		"---",
		"",
		...team.roles.map(serializeRole),
		"",
	].filter((entry): entry is string => entry !== undefined);
	return lines.join("\n");
}
