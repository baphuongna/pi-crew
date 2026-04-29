import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, ResourceSource, RoutingMetadata } from "../agents/agent-config.ts";
import { serializeAgent } from "../agents/agent-serializer.ts";
import { allAgents, discoverAgents } from "../agents/discover-agents.ts";
import type { TeamToolDetails } from "./team-tool-types.ts";
import { toolResult, type PiTeamsToolResult } from "./tool-result.ts";
import type { TeamToolParamsValue } from "../schema/team-tool-schema.ts";
import type { TeamConfig, TeamRole } from "../teams/team-config.ts";
import { serializeTeam } from "../teams/team-serializer.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";
import { serializeWorkflow } from "../workflows/workflow-serializer.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";
import { projectCrewRoot, userPiRoot } from "../utils/paths.ts";
import { hasOwn, parseConfigObject, requireString, sanitizeName } from "../utils/names.ts";

interface ManagementContext {
	cwd: string;
}

type MutableSource = "user" | "project";

type MutableResource = AgentConfig | TeamConfig | WorkflowConfig;

function result(text: string, status: TeamToolDetails["status"] = "ok", isError = false): PiTeamsToolResult {
	return toolResult(text, { action: "management", status }, isError);
}

function scopeDir(ctx: ManagementContext, resource: "agent" | "team" | "workflow", scope: MutableSource): string {
	const base = scope === "user" ? userPiRoot() : projectCrewRoot(ctx.cwd);
	if (resource === "agent") return path.join(base, "agents");
	if (resource === "team") return path.join(base, "teams");
	return path.join(base, "workflows");
}

function extensionFor(resource: "agent" | "team" | "workflow"): string {
	if (resource === "agent") return ".md";
	if (resource === "team") return ".team.md";
	return ".workflow.md";
}

function backupFile(filePath: string): string {
	const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
	fs.copyFileSync(filePath, backupPath);
	return backupPath;
}

function targetPath(ctx: ManagementContext, resource: "agent" | "team" | "workflow", scope: MutableSource, name: string): string {
	return path.join(scopeDir(ctx, resource, scope), `${name}${extensionFor(resource)}`);
}

function parseStringArray(value: unknown): string[] | undefined {
	if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
	return undefined;
}

function parseRouting(value: Record<string, unknown>, fallback?: RoutingMetadata): RoutingMetadata | undefined {
	const routing = {
		triggers: hasOwn(value, "triggers") ? parseStringArray(value.triggers) : fallback?.triggers,
		useWhen: hasOwn(value, "useWhen") ? parseStringArray(value.useWhen) : fallback?.useWhen,
		avoidWhen: hasOwn(value, "avoidWhen") ? parseStringArray(value.avoidWhen) : fallback?.avoidWhen,
		cost: value.cost === "free" || value.cost === "cheap" || value.cost === "expensive" ? value.cost : fallback?.cost,
		category: hasOwn(value, "category") ? (typeof value.category === "string" && value.category.trim() ? value.category.trim() : undefined) : fallback?.category,
	};
	return routing.triggers || routing.useWhen || routing.avoidWhen || routing.cost || routing.category ? routing : undefined;
}

function parseRoles(value: unknown): { roles?: TeamRole[]; error?: string } {
	if (!Array.isArray(value) || value.length === 0) return { error: "config.roles must be a non-empty array." };
	const roles: TeamRole[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `config.roles[${i}] must be an object.` };
		const obj = item as Record<string, unknown>;
		const name = requireString(obj.name, `config.roles[${i}].name`);
		if (name.error) return { error: name.error };
		const agent = requireString(obj.agent, `config.roles[${i}].agent`);
		if (agent.error) return { error: agent.error };
		roles.push({
			name: sanitizeName(name.value!),
			agent: sanitizeName(agent.value!),
			description: typeof obj.description === "string" ? obj.description.trim() : undefined,
			model: typeof obj.model === "string" ? obj.model.trim() : undefined,
			maxConcurrency: typeof obj.maxConcurrency === "number" && Number.isInteger(obj.maxConcurrency) ? obj.maxConcurrency : undefined,
		});
	}
	return { roles };
}

function parseSteps(value: unknown): { steps?: WorkflowStep[]; error?: string } {
	if (!Array.isArray(value) || value.length === 0) return { error: "config.steps must be a non-empty array." };
	const steps: WorkflowStep[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `config.steps[${i}] must be an object.` };
		const obj = item as Record<string, unknown>;
		const id = requireString(obj.id, `config.steps[${i}].id`);
		if (id.error) return { error: id.error };
		const role = requireString(obj.role, `config.steps[${i}].role`);
		if (role.error) return { error: role.error };
		steps.push({
			id: sanitizeName(id.value!),
			role: sanitizeName(role.value!),
			task: typeof obj.task === "string" ? obj.task : "{goal}",
			dependsOn: parseStringArray(obj.dependsOn),
			parallelGroup: typeof obj.parallelGroup === "string" ? obj.parallelGroup.trim() : undefined,
			output: obj.output === false ? false : typeof obj.output === "string" ? obj.output.trim() : undefined,
			reads: obj.reads === false ? false : parseStringArray(obj.reads),
			model: typeof obj.model === "string" ? obj.model.trim() : undefined,
			skills: obj.skills === false ? false : parseStringArray(obj.skills),
			progress: typeof obj.progress === "boolean" ? obj.progress : undefined,
			worktree: typeof obj.worktree === "boolean" ? obj.worktree : undefined,
			verify: typeof obj.verify === "boolean" ? obj.verify : undefined,
		});
	}
	return { steps };
}

function parseWorkflowMaxConcurrency(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

function findResource(ctx: ManagementContext, resource: "agent" | "team" | "workflow", name: string, scope?: string): MutableResource[] {
	const normalized = sanitizeName(name);
	const sourceMatches = (item: { name: string; source: ResourceSource }) => (scope === "user" || scope === "project" ? item.source === scope : item.source !== "builtin") && item.name === normalized;
	if (resource === "agent") return allAgents(discoverAgents(ctx.cwd)).filter(sourceMatches);
	if (resource === "team") return allTeams(discoverTeams(ctx.cwd)).filter(sourceMatches);
	return allWorkflows(discoverWorkflows(ctx.cwd)).filter(sourceMatches);
}

function findReferences(ctx: ManagementContext, resource: "agent" | "team" | "workflow", name: string): string[] {
	const refs: string[] = [];
	if (resource === "agent") {
		for (const team of allTeams(discoverTeams(ctx.cwd))) {
			for (const role of team.roles) {
				if (role.agent === name) refs.push(`team '${team.name}' role '${role.name}'`);
			}
		}
	}
	if (resource === "workflow") {
		for (const team of allTeams(discoverTeams(ctx.cwd))) {
			if (team.defaultWorkflow === name) refs.push(`team '${team.name}' defaultWorkflow`);
		}
	}
	return refs;
}

function updateReferencesForRename(ctx: ManagementContext, resource: "agent" | "team" | "workflow", oldName: string, newName: string, scope: MutableSource, dryRun: boolean): string[] {
	if (oldName === newName) return [];
	if (resource !== "agent" && resource !== "workflow") return [];
	const changed: string[] = [];
	for (const team of allTeams(discoverTeams(ctx.cwd)).filter((candidate) => candidate.source === scope)) {
		let updated = false;
		let nextTeam = team;
		if (resource === "agent") {
			const roles = team.roles.map((role) => role.agent === oldName ? { ...role, agent: newName } : role);
			updated = roles.some((role, index) => role.agent !== team.roles[index]!.agent);
			nextTeam = { ...team, roles };
		}
		if (resource === "workflow" && team.defaultWorkflow === oldName) {
			updated = true;
			nextTeam = { ...team, defaultWorkflow: newName };
		}
		if (!updated) continue;
		changed.push(team.filePath);
		if (!dryRun) {
			backupFile(team.filePath);
			fs.writeFileSync(team.filePath, serializeTeam(nextTeam), "utf-8");
		}
	}
	return changed;
}

function resolveMutable(ctx: ManagementContext, params: TeamToolParamsValue): { resource?: MutableResource; error?: PiTeamsToolResult } {
	if (!params.resource) return { error: result("resource is required for update/delete.", "error", true) };
	const name = params.resource === "agent" ? params.agent : params.resource === "team" ? params.team : params.workflow;
	if (!name) return { error: result(`${params.resource} name is required.`, "error", true) };
	const matches = findResource(ctx, params.resource, name, params.scope);
	if (matches.length === 0) return { error: result(`${params.resource} '${name}' not found in mutable user/project scopes.`, "error", true) };
	if (matches.length > 1) return { error: result(`${params.resource} '${name}' exists in multiple scopes. Specify scope: 'user' or 'project'.`, "error", true) };
	return { resource: matches[0] };
}

export function handleCreate(params: TeamToolParamsValue, ctx: ManagementContext): PiTeamsToolResult {
	if (!params.resource) return result("resource is required for create.", "error", true);
	const parsed = parseConfigObject(params.config);
	if (parsed.error) return result(parsed.error, "error", true);
	const cfg = parsed.value!;
	const nameValue = requireString(cfg.name, "config.name");
	if (nameValue.error) return result(nameValue.error, "error", true);
	const descriptionValue = requireString(cfg.description, "config.description");
	if (descriptionValue.error) return result(descriptionValue.error, "error", true);
	const name = sanitizeName(nameValue.value!);
	if (!name) return result("config.name is invalid after sanitization.", "error", true);
	const scope = cfg.scope === "project" ? "project" : "user";
	const filePath = targetPath(ctx, params.resource, scope, name);
	if (fs.existsSync(filePath)) return result(`File already exists: ${filePath}`, "error", true);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });

	let content: string;
	if (params.resource === "agent") {
		const agent: AgentConfig = {
			name,
			description: descriptionValue.value!,
			source: scope,
			filePath,
			systemPrompt: typeof cfg.systemPrompt === "string" ? cfg.systemPrompt : "",
			model: typeof cfg.model === "string" ? cfg.model : undefined,
			fallbackModels: parseStringArray(cfg.fallbackModels),
			thinking: typeof cfg.thinking === "string" ? cfg.thinking : undefined,
			tools: parseStringArray(cfg.tools),
			extensions: hasOwn(cfg, "extensions") ? parseStringArray(cfg.extensions) ?? [] : undefined,
			skills: parseStringArray(cfg.skills),
			systemPromptMode: cfg.systemPromptMode === "append" ? "append" : "replace",
			inheritProjectContext: cfg.inheritProjectContext === true,
			inheritSkills: cfg.inheritSkills === true,
			routing: parseRouting(cfg),
		};
		content = serializeAgent(agent);
	} else if (params.resource === "team") {
		const parsedRoles = parseRoles(cfg.roles);
		if (parsedRoles.error) return result(parsedRoles.error, "error", true);
		content = serializeTeam({
			name,
			description: descriptionValue.value!,
			source: scope,
			filePath,
			roles: parsedRoles.roles!,
			defaultWorkflow: typeof cfg.defaultWorkflow === "string" ? sanitizeName(cfg.defaultWorkflow) : undefined,
			workspaceMode: cfg.workspaceMode === "worktree" ? "worktree" : "single",
			maxConcurrency: typeof cfg.maxConcurrency === "number" && Number.isInteger(cfg.maxConcurrency) ? cfg.maxConcurrency : undefined,
			routing: parseRouting(cfg),
		});
	} else {
		const parsedSteps = parseSteps(cfg.steps);
		if (parsedSteps.error) return result(parsedSteps.error, "error", true);
		content = serializeWorkflow({
			name,
			description: descriptionValue.value!,
			source: scope,
			filePath,
			maxConcurrency: parseWorkflowMaxConcurrency(cfg.maxConcurrency),
			steps: parsedSteps.steps!,
		});
	}

	if (params.dryRun) return result(`[dry-run] Would create ${params.resource} '${name}' at ${filePath}:\n\n${content}`);
	fs.writeFileSync(filePath, content, "utf-8");
	return result(`Created ${params.resource} '${name}' at ${filePath}.`);
}

export function handleUpdate(params: TeamToolParamsValue, ctx: ManagementContext): PiTeamsToolResult {
	const resolved = resolveMutable(ctx, params);
	if (resolved.error) return resolved.error;
	const parsed = parseConfigObject(params.config);
	if (parsed.error) return result(parsed.error, "error", true);
	const cfg = parsed.value!;
	const current = resolved.resource!;
	const nextName = hasOwn(cfg, "name") ? sanitizeName(String(cfg.name ?? "")) : current.name;
	if (!nextName) return result("config.name is invalid after sanitization.", "error", true);
	const source = current.source === "project" ? "project" : "user";
	const nextPath = targetPath(ctx, params.resource!, source, nextName);
	if (nextPath !== current.filePath && fs.existsSync(nextPath)) return result(`Target file already exists: ${nextPath}`, "error", true);

	let content: string;
	if (params.resource === "agent") {
		const agent = current as AgentConfig;
		content = serializeAgent({
			...agent,
			name: nextName,
			filePath: nextPath,
			description: typeof cfg.description === "string" && cfg.description.trim() ? cfg.description.trim() : agent.description,
			systemPrompt: typeof cfg.systemPrompt === "string" ? cfg.systemPrompt : agent.systemPrompt,
			model: hasOwn(cfg, "model") ? (typeof cfg.model === "string" && cfg.model.trim() ? cfg.model.trim() : undefined) : agent.model,
			fallbackModels: hasOwn(cfg, "fallbackModels") ? parseStringArray(cfg.fallbackModels) : agent.fallbackModels,
			thinking: hasOwn(cfg, "thinking") ? (typeof cfg.thinking === "string" && cfg.thinking.trim() ? cfg.thinking.trim() : undefined) : agent.thinking,
			tools: hasOwn(cfg, "tools") ? parseStringArray(cfg.tools) : agent.tools,
			extensions: hasOwn(cfg, "extensions") ? parseStringArray(cfg.extensions) ?? [] : agent.extensions,
			skills: hasOwn(cfg, "skills") ? parseStringArray(cfg.skills) : agent.skills,
			systemPromptMode: cfg.systemPromptMode === "append" ? "append" : cfg.systemPromptMode === "replace" ? "replace" : agent.systemPromptMode,
			inheritProjectContext: typeof cfg.inheritProjectContext === "boolean" ? cfg.inheritProjectContext : agent.inheritProjectContext,
			inheritSkills: typeof cfg.inheritSkills === "boolean" ? cfg.inheritSkills : agent.inheritSkills,
			routing: parseRouting(cfg, agent.routing),
		});
	} else if (params.resource === "team") {
		const team = current as TeamConfig;
		let roles = team.roles;
		if (hasOwn(cfg, "roles")) {
			const parsedRoles = parseRoles(cfg.roles);
			if (parsedRoles.error) return result(parsedRoles.error, "error", true);
			roles = parsedRoles.roles!;
		}
		content = serializeTeam({
			...team,
			name: nextName,
			filePath: nextPath,
			description: typeof cfg.description === "string" && cfg.description.trim() ? cfg.description.trim() : team.description,
			roles,
			defaultWorkflow: hasOwn(cfg, "defaultWorkflow") ? (typeof cfg.defaultWorkflow === "string" ? sanitizeName(cfg.defaultWorkflow) : undefined) : team.defaultWorkflow,
			workspaceMode: cfg.workspaceMode === "worktree" ? "worktree" : cfg.workspaceMode === "single" ? "single" : team.workspaceMode,
			maxConcurrency: typeof cfg.maxConcurrency === "number" && Number.isInteger(cfg.maxConcurrency) ? cfg.maxConcurrency : team.maxConcurrency,
			routing: parseRouting(cfg, team.routing),
		});
	} else {
		const workflow = current as WorkflowConfig;
		let steps = workflow.steps;
		if (hasOwn(cfg, "steps")) {
			const parsedSteps = parseSteps(cfg.steps);
			if (parsedSteps.error) return result(parsedSteps.error, "error", true);
			steps = parsedSteps.steps!;
		}
		content = serializeWorkflow({
			...workflow,
			name: nextName,
			filePath: nextPath,
			description: typeof cfg.description === "string" && cfg.description.trim() ? cfg.description.trim() : workflow.description,
			maxConcurrency: hasOwn(cfg, "maxConcurrency") ? parseWorkflowMaxConcurrency(cfg.maxConcurrency) : workflow.maxConcurrency,
			steps,
		});
	}

	const referenceUpdates = params.updateReferences ? updateReferencesForRename(ctx, params.resource!, current.name, nextName, source, true) : [];
	if (params.dryRun) {
		return result([`[dry-run] Would update ${params.resource} at ${current.filePath}:`, "", content, ...(referenceUpdates.length ? ["", "Would update references in:", ...referenceUpdates.map((filePath) => `- ${filePath}`)] : [])].join("\n"));
	}
	const backupPath = backupFile(current.filePath);
	if (nextPath !== current.filePath) fs.renameSync(current.filePath, nextPath);
	fs.writeFileSync(nextPath, content, "utf-8");
	const updatedRefs = params.updateReferences ? updateReferencesForRename(ctx, params.resource!, current.name, nextName, source, false) : [];
	return result([`Updated ${params.resource} at ${nextPath}. Backup: ${backupPath}.`, ...(updatedRefs.length ? ["Updated references:", ...updatedRefs.map((filePath) => `- ${filePath}`)] : [])].join("\n"));
}

export function handleDelete(params: TeamToolParamsValue, ctx: ManagementContext): PiTeamsToolResult {
	if (!params.confirm) return result("delete requires confirm: true.", "error", true);
	const resolved = resolveMutable(ctx, params);
	if (resolved.error) return resolved.error;
	const refs = findReferences(ctx, params.resource!, resolved.resource!.name);
	if (refs.length > 0 && !params.force) {
		return result(`${params.resource} '${resolved.resource!.name}' is still referenced. Use force: true to delete anyway.\n${refs.map((ref) => `- ${ref}`).join("\n")}`, "error", true);
	}
	if (params.dryRun) return result(`[dry-run] Would delete ${params.resource} at ${resolved.resource!.filePath}.${refs.length ? `\nReferences:\n${refs.map((ref) => `- ${ref}`).join("\n")}` : ""}`);
	const backupPath = backupFile(resolved.resource!.filePath);
	fs.unlinkSync(resolved.resource!.filePath);
	return result(`Deleted ${params.resource} at ${resolved.resource!.filePath}. Backup: ${backupPath}.`);
}
