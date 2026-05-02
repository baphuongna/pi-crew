import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { handleTeamTool } from "../team-tool.ts";
import { checkSubagentSpawnPermission, currentCrewRole } from "../../runtime/role-permission.ts";
import { readPersistedSubagentRecord, savePersistedSubagentRecord, type SubagentManager, type SubagentSpawnOptions } from "../../subagents/manager.ts";
import { loadConfig } from "../../config/config.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { __test__subagentSpawnParams, formatSubagentRecord, readSubagentRunResult, refreshPersistedSubagentRecord, subagentToolResult } from "./subagent-helpers.ts";
import { t } from "../../i18n.ts";

export interface SubagentToolRegistrationOptions {
	ownerSessionGeneration?: () => number;
}

export function registerSubagentTools(pi: ExtensionAPI, subagentManager: SubagentManager, options: SubagentToolRegistrationOptions = {}): void {
	const agentTool: ToolDefinition = {
		name: "Agent",
		label: "Agent",
		description: "Launch a real pi-crew subagent. Uses pi-crew's durable child-process runtime by default; set run_in_background=true for parallel/background work, then use get_subagent_result.",
		promptSnippet: "Use Agent to delegate focused work to a real pi-crew subagent. Use run_in_background=true for parallel work and get_subagent_result to join results.",
		promptGuidelines: [
			"Use Agent for independent exploration, review, verification, or implementation subtasks instead of doing all work in the parent turn.",
			"For parallel work, launch multiple Agent calls with run_in_background=true, then call get_subagent_result for each result.",
			"Available pi-crew subagent types include explorer, planner, analyst, executor, reviewer, verifier, writer, security-reviewer, and test-engineer.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "The task for the subagent to perform." }),
			description: Type.String({ description: "Short 3-5 word task description." }),
			subagent_type: Type.String({ description: "pi-crew agent name, e.g. explorer, planner, executor, reviewer, verifier, writer, security-reviewer, test-engineer." }),
			model: Type.Optional(Type.String({ description: "Optional model override. If omitted, pi-crew uses Pi-configured model fallback." })),
			max_turns: Type.Optional(Type.Number({ description: "Reserved for live-session subagents; child-process runtime may ignore this." })),
			run_in_background: Type.Optional(Type.Boolean({ description: "Run in background and return an agent ID immediately." })),
		}) as never,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const currentRole = currentCrewRole();
			const permission = checkSubagentSpawnPermission(currentRole);
			if (!permission.allowed) return subagentToolResult(permission.reason ?? "Current role cannot spawn subagents.", { role: currentRole, mode: permission.mode }, true);
			const spawnOptions = __test__subagentSpawnParams(params as Record<string, unknown>, ctx);
			spawnOptions.ownerSessionGeneration = options.ownerSessionGeneration?.();
			if (!spawnOptions.prompt.trim()) return subagentToolResult(t("agent.requiresPrompt"), {}, true);
			const runner = async (currentOptions: SubagentSpawnOptions, childSignal?: AbortSignal) => handleTeamTool({ action: "run", agent: currentOptions.type, goal: currentOptions.prompt, model: currentOptions.model, async: currentOptions.background, config: currentOptions.maxTurns ? { runtime: { maxTurns: currentOptions.maxTurns } } : undefined } as TeamToolParamsValue, currentOptions.background ? { ...ctx, signal: childSignal } : { ...ctx, signal: childSignal });
			const record = subagentManager.spawn(spawnOptions, runner, spawnOptions.background ? undefined : signal);
			if (spawnOptions.background || record.status === "queued") {
				// Phase 1.1a: Terminate turn for background queued — no LLM follow-up needed.
				// Phase 1.6: Record was terminated for telemetry.
				record.terminated = true;
				savePersistedSubagentRecord(ctx.cwd, record);
				return { ...subagentToolResult([t("agent.started", { state: record.status === "queued" ? "queued" : "started" }), t("agent.id", { id: record.id }), t("agent.type", { type: record.type }), t("agent.description", { description: record.description }), t("agent.retrieveHint")].join("\n"), { agentId: record.id, status: record.status }), terminate: true };
			}
			await record.promise;
			const output = readSubagentRunResult(ctx, record) ?? record.result ?? t("agent.noOutput");
			const foregroundResult = subagentToolResult([t("agent.foregroundStatus", { id: record.id, status: record.status }), "", output].join("\n"), { agentId: record.id, runId: record.runId, status: record.status }, record.status === "failed" || record.status === "error");
			if (loadConfig(ctx.cwd).config.tools?.terminateOnForeground === true) {
				record.terminated = true;
				savePersistedSubagentRecord(ctx.cwd, record);
				return { ...foregroundResult, terminate: true };
			}
			return foregroundResult;
		},
	};

	const getSubagentResultTool: ToolDefinition = {
		name: "get_subagent_result",
		label: "Get Agent Result",
		description: "Check status and retrieve results from a pi-crew background subagent.",
		parameters: Type.Object({ agent_id: Type.String({ description: "Agent ID returned by Agent." }), wait: Type.Optional(Type.Boolean({ description: "Wait for completion before returning." })), verbose: Type.Optional(Type.Boolean({ description: "Include status metadata before output." })) }) as never,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as { agent_id?: string; wait?: boolean; verbose?: boolean };
			if (!p.agent_id) return subagentToolResult(t("result.requiresAgentId"), {}, true);
			const inMemory = subagentManager.getRecord(p.agent_id);
			const record = inMemory ?? readPersistedSubagentRecord(ctx.cwd, p.agent_id);
			if (!record) return subagentToolResult(t("result.notFound", { id: p.agent_id }), {}, true);
			let current = refreshPersistedSubagentRecord(ctx, record);
			if (inMemory && current !== inMemory) Object.assign(inMemory, current);
			if (!inMemory && !current.runId && (current.status === "running" || current.status === "queued")) {
				current = { ...current, status: "error", error: t("result.unrecoverable"), completedAt: current.completedAt ?? Date.now() };
				savePersistedSubagentRecord(ctx.cwd, current);
			}
			if (p.wait && (current.status === "running" || current.status === "queued")) {
				const waited = await subagentManager.waitForRecord(current.id);
				if (waited) current = waited;
				if (current.status === "blocked") {
					current.resultConsumed = false;
					if (inMemory) inMemory.resultConsumed = false;
					savePersistedSubagentRecord(ctx.cwd, current);
				}
				else while (current.status === "running" || current.status === "queued") {
					if (signal?.aborted) {
						current = { ...current, status: "error", error: t("result.waitAborted"), completedAt: Date.now() };
						savePersistedSubagentRecord(ctx.cwd, current);
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 1000));
					current = refreshPersistedSubagentRecord(ctx, current);
					if (!current.runId) break;
				}
			}
			const output = readSubagentRunResult(ctx, current);
			if (current.status !== "running" && current.status !== "queued" && current.status !== "blocked") {
				current.resultConsumed = true;
				if (inMemory) inMemory.resultConsumed = true;
				savePersistedSubagentRecord(ctx.cwd, current);
			}
			const text = [p.verbose ? formatSubagentRecord(current) : undefined, output ? `${p.verbose ? "\n" : ""}${output}` : current.status === "running" || current.status === "queued" ? t("result.stillRunning") : current.error ?? t("agent.noOutput")].filter((line): line is string => Boolean(line)).join("\n");
			return subagentToolResult(text, { agentId: current.id, runId: current.runId, status: current.status }, current.status === "failed" || current.status === "error");
		},
	};

	const steerSubagentTool: ToolDefinition = {
		name: "steer_subagent",
		label: "Steer Agent",
		description: "Send a steering note to a running pi-crew subagent. Live-session steering is planned; child-process runs expose durable status and can be cancelled if needed.",
		parameters: Type.Object({ agent_id: Type.String(), message: Type.String() }) as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { agent_id?: string; message?: string };
			const record = p.agent_id ? subagentManager.getRecord(p.agent_id) ?? readPersistedSubagentRecord(ctx.cwd, p.agent_id) : undefined;
			if (!record) return subagentToolResult(t("result.notFound", { id: p.agent_id ?? "" }), {}, true);
			return subagentToolResult([t("steer.noted", { id: record.id }), t("steer.unavailable"), record.runId ? t("steer.cancelHint", { runId: record.runId }) : undefined].filter((line): line is string => Boolean(line)).join("\n"), { agentId: record.id, runId: record.runId, status: record.status });
		},
	};

	const crewAgentTool: ToolDefinition = { ...agentTool, name: "crew_agent", label: "Crew Agent", description: "Launch a real pi-crew subagent using a conflict-safe pi-crew-specific tool name.", promptSnippet: "Use crew_agent when you need pi-crew subagents and another extension may own the generic Agent tool." };
	const crewAgentResultTool: ToolDefinition = { ...getSubagentResultTool, name: "crew_agent_result", label: "Get Crew Agent Result", description: "Check status and retrieve results from a pi-crew subagent using the conflict-safe tool name." };
	const crewAgentSteerTool: ToolDefinition = { ...steerSubagentTool, name: "crew_agent_steer", label: "Steer Crew Agent", description: "Send a steering note to a pi-crew subagent using the conflict-safe tool name." };
	const toolConfig = loadConfig(process.cwd()).config.tools;
	const enableSteer = toolConfig?.enableSteer !== false;
	const enableClaudeStyleAliases = toolConfig?.enableClaudeStyleAliases !== false;

	for (const extraTool of enableSteer ? [crewAgentTool, crewAgentResultTool, crewAgentSteerTool] : [crewAgentTool, crewAgentResultTool]) pi.registerTool(extraTool);
	if (enableClaudeStyleAliases) {
		for (const extraTool of enableSteer ? [agentTool, getSubagentResultTool, steerSubagentTool] : [agentTool, getSubagentResultTool]) {
			try {
				pi.registerTool(extraTool);
			} catch (error) {
				logInternalError("register.duplicate-tool", error, `tool=${extraTool.name}`);
			}
		}
	}
}
