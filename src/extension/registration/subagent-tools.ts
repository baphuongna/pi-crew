import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { withSessionId } from "../team-tool/context.ts";
// Lazy-loaded: team-tool.ts pulls in entire runtime chain.
import type { handleTeamTool as HandleTeamToolFn } from "../team-tool.ts";

let _cachedHandleTeamTool: typeof HandleTeamToolFn | undefined;
async function handleTeamTool(
	params: Parameters<typeof HandleTeamToolFn>[0],
	ctx: Parameters<typeof HandleTeamToolFn>[1],
): Promise<Awaited<ReturnType<typeof HandleTeamToolFn>>> {
	if (!_cachedHandleTeamTool) {
		// LAZY: team-tool.ts pulls in entire runtime chain.
		const mod = await import("../team-tool.ts");
		_cachedHandleTeamTool = mod.handleTeamTool;
	}
	return _cachedHandleTeamTool(params, ctx);
}

import { Text } from "@earendil-works/pi-tui";
import { loadConfig } from "../../config/config.ts";
import { t } from "../../i18n.ts";
import type { BatchBarrier } from "../../runtime/batch-barrier.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import { checkSubagentSpawnPermission, currentCrewRole } from "../../runtime/role-permission.ts";
import { loadRunManifestById } from "../../state/state-store.ts";
import {
	readPersistedSubagentRecord,
	type SubagentManager,
	type SubagentSpawnOptions,
	savePersistedSubagentRecord,
} from "../../subagents/manager.ts";
import { formatCompactToolProgress } from "../../ui/tool-progress-formatter.ts";
import { agentToolRenderer } from "../../ui/tool-renderers/index.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import {
	__test__subagentSpawnParams,
	formatSubagentRecord,
	readSubagentRunResult,
	refreshPersistedSubagentRecord,
	subagentToolResult,
} from "./subagent-helpers.ts";

const TOOL_PROGRESS_TICK_MS = 1000;

type OnUpdate = (chunk: { content: { type: "text"; text: string }[] }) => void;

export interface SubagentToolRegistrationOptions {
	ownerSessionGeneration?: () => number;
	startForegroundRun?: (ctx: unknown, runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	/** Rule 1 batch barrier. When present, agents spawned with a batchId are
	 * registered here so their completion notifications are coalesced. */
	batchBarrier?: BatchBarrier;
}

export function registerSubagentTools(
	pi: ExtensionAPI,
	subagentManager: SubagentManager,
	options: SubagentToolRegistrationOptions = {},
): void {
	const agentTool: ToolDefinition = {
		name: "Agent",
		label: "Agent",
		description:
			"Launch a real pi-crew subagent. Uses pi-crew's durable child-process runtime by default; set run_in_background=true for parallel/background work, then use get_subagent_result.",
		promptSnippet:
			"Use Agent to delegate focused work to a real pi-crew subagent. Use run_in_background=true for parallel work and get_subagent_result to join results.",
		promptGuidelines: [
			"Use Agent for independent exploration, review, verification, or implementation subtasks instead of doing all work in the parent turn.",
			"For parallel work, launch multiple Agent calls with run_in_background=true, then call get_subagent_result for each result.",
			"Available pi-crew subagent types include explorer, planner, analyst, executor, reviewer, verifier, writer, security-reviewer, and test-engineer.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description: "The task for the subagent to perform.",
			}),
			description: Type.String({
				description: "Short 3-5 word task description.",
			}),
			subagent_type: Type.String({
				description:
					"pi-crew agent name, e.g. explorer, planner, executor, reviewer, verifier, writer, security-reviewer, test-engineer.",
			}),
			model: Type.Optional(
				Type.String({
					description: "Optional model override. If omitted, pi-crew uses Pi-configured model fallback.",
				}),
			),
			skill: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String()), Type.Boolean()], {
					description: "Skill name(s) to inject for this subagent, or false to disable selected/default skills.",
				}),
			),
			max_turns: Type.Optional(
				Type.Number({
					description: "Reserved for live-session subagents; child-process runtime may ignore this.",
				}),
			),
			run_in_background: Type.Optional(
				Type.Boolean({
					description: "Run in background and return an agent ID immediately.",
				}),
			),
			batch_id: Type.Optional(
				Type.String({
					description:
						"Optional batch grouping id. Background agents sharing the same batch_id receive ONE consolidated completion notification when ALL members finish (instead of N individual notifications). Use this when launching several background agents in one turn and you do not join them immediately. Omit for the default individual-notification behavior.",
				}),
			),
		}) as never,
		async execute(_id, params, signal, onUpdate, ctx) {
			// Diagnostic: detect pre-aborted signal before spawn
			if (signal?.aborted) {
				logInternalError(
					"subagent-tools.pre-aborted-signal",
					undefined,
					`aborted=true paramsKeys=${Object.keys(params as object).join(",")}`,
				);
				return subagentToolResult(
					"Agent tool signal was already aborted before execution started. This usually means Pi cancelled the tool call before it ran.",
					{ action: "agent", status: "error" },
					true,
				);
			}
			const currentRole = currentCrewRole();
			const permission = checkSubagentSpawnPermission(currentRole);
			if (!permission.allowed)
				return subagentToolResult(
					permission.reason ?? "Current role cannot spawn subagents.",
					{ role: currentRole, mode: permission.mode },
					true,
				);
			const spawnOptions = __test__subagentSpawnParams(params as Record<string, unknown>, ctx);
			spawnOptions.ownerSessionGeneration = options.ownerSessionGeneration?.();
			if (!spawnOptions.prompt.trim()) return subagentToolResult(t("agent.requiresPrompt"), {}, true);
			// Extract sessionId from sessionManager.getSessionId() so team runs created
			// by the Agent tool have proper session ownership for isolation.
			const ctxWithSession = withSessionId(ctx);
			const runner = async (currentOptions: SubagentSpawnOptions, childSignal?: AbortSignal) =>
				handleTeamTool(
					{
						action: "run",
						agent: currentOptions.type,
						goal: currentOptions.prompt,
						model: currentOptions.model,
						skill: currentOptions.skill,
						async: currentOptions.background,
						config: currentOptions.maxTurns ? { runtime: { maxTurns: currentOptions.maxTurns } } : undefined,
					} as TeamToolParamsValue,
					{
						...ctxWithSession,
						signal: childSignal,
						...(options.startForegroundRun
							? {
									startForegroundRun: (runRunner: (sig?: AbortSignal) => Promise<void>, runId?: string) =>
										options.startForegroundRun!(ctxWithSession, runRunner, runId),
								}
							: {}),
					},
				);
			const record = subagentManager.spawn(spawnOptions, runner, spawnOptions.background ? undefined : signal);
			// Rule 1: register batch membership so completions can be coalesced.
			if (spawnOptions.batchId && spawnOptions.background) {
				options.batchBarrier?.register(spawnOptions.batchId, record.id, { description: record.description, type: record.type });
			}
			if (spawnOptions.background || record.status === "queued") {
				// Phase 1.1a: Terminate turn for background queued — no LLM follow-up needed.
				// Phase 1.6: Record was terminated for telemetry.
				record.terminated = true;
				savePersistedSubagentRecord(ctx.cwd, record);
				return {
					...subagentToolResult(
						[
							t("agent.started", {
								state: record.status === "queued" ? "queued" : "started",
							}),
							t("agent.id", { id: record.id }),
							t("agent.type", { type: record.type }),
							t("agent.description", {
								description: record.description,
							}),
							t("agent.retrieveHint"),
						].join("\n"),
						{ agentId: record.id, status: record.status },
					),
					terminate: true,
				};
			}
			const stopProgress = startAgentToolProgress(ctx.cwd, record.id, onUpdate as OnUpdate | undefined, subagentManager);
			try {
				await record.promise;
			} finally {
				stopProgress();
			}
			// Diagnostic: log when foreground subagent ends in "stopped" to surface the abort reason
			if (record.status === "stopped") {
				logInternalError(
					"subagent-tools.foreground-stopped",
					undefined,
					`agentId=${record.id} runId=${record.runId ?? ""} error=${record.error ?? "(none)"} result=${(record.result ?? "").slice(0, 200)}`,
				);
			}
			const output = readSubagentRunResult(ctx, record) ?? record.result ?? record.error ?? t("agent.noOutput");
			const foregroundResult = subagentToolResult(
				[
					t("agent.foregroundStatus", {
						id: record.id,
						status: record.status,
					}),
					"",
					output,
				].join("\n"),
				{
					agentId: record.id,
					runId: record.runId,
					status: record.status,
				},
				record.status === "failed" || record.status === "error" || record.status === "stopped",
			);
			if (loadConfig(ctx.cwd).config.tools?.terminateOnForeground === true) {
				record.terminated = true;
				savePersistedSubagentRecord(ctx.cwd, record);
				return { ...foregroundResult, terminate: true };
			}
			return foregroundResult;
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderCall(args: any, theme: any, context: any): any {
			return agentToolRenderer.renderCall(args, theme, context);
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderResult(result: any, options: any, theme: any, context: any): any {
			try {
				return agentToolRenderer.renderResult(result, options, theme, context);
			} catch (e: any) {
				return new Text("agent-err: " + (e?.message ?? "unknown"), 0, 0);
			}
		},
	};

	const getSubagentResultTool: ToolDefinition = {
		name: "get_subagent_result",
		label: "Get Agent Result",
		description: "Check status and retrieve results from a pi-crew background subagent.",
		parameters: Type.Object({
			agent_id: Type.String({
				description: "Agent ID returned by Agent.",
			}),
			wait: Type.Optional(
				Type.Boolean({
					description: "Wait for completion before returning.",
				}),
			),
			verbose: Type.Optional(
				Type.Boolean({
					description: "Include status metadata before output.",
				}),
			),
		}) as never,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as {
				agent_id?: string;
				wait?: boolean;
				verbose?: boolean;
			};
			if (!p.agent_id) return subagentToolResult(t("result.requiresAgentId"), {}, true);
			const inMemory = subagentManager.getRecord(p.agent_id);
			const record = inMemory ?? readPersistedSubagentRecord(ctx.cwd, p.agent_id);
			if (!record) return subagentToolResult(t("result.notFound", { id: p.agent_id }), {}, true);
			let current = refreshPersistedSubagentRecord(ctx, record);
			if (inMemory && current !== inMemory) Object.assign(inMemory, current);
			if (!inMemory && !current.runId && (current.status === "running" || current.status === "queued")) {
				current = {
					...current,
					status: "error",
					error: t("result.unrecoverable"),
					completedAt: current.completedAt ?? Date.now(),
				};
				savePersistedSubagentRecord(ctx.cwd, current);
			}
			if (p.wait && (current.status === "running" || current.status === "queued")) {
				const waited = await subagentManager.waitForRecord(current.id);
				if (waited) current = waited;
				if (current.status === "blocked") {
					current.resultConsumed = false;
					if (inMemory) inMemory.resultConsumed = false;
					savePersistedSubagentRecord(ctx.cwd, current);
				} else {
					const waitStartMs = Date.now();
					const maxWaitMs = 300_000; // 5 minutes
					while (current.status === "running" || current.status === "queued") {
						if (signal?.aborted) {
							current = {
								...current,
								status: "error",
								error: t("result.waitAborted"),
								completedAt: Date.now(),
							};
							savePersistedSubagentRecord(ctx.cwd, current);
							break;
						}
						if (Date.now() - waitStartMs > maxWaitMs) {
							current = {
								...current,
								status: "error",
								error: t("result.waitTimeout"),
								completedAt: Date.now(),
							};
							savePersistedSubagentRecord(ctx.cwd, current);
							break;
						}
						await new Promise((resolve) => setTimeout(resolve, 1000));
						current = refreshPersistedSubagentRecord(ctx, current);
						if (!current.runId) break;
					}
				}
			}
			const output = readSubagentRunResult(ctx, current);
			if (current.status !== "running" && current.status !== "queued" && current.status !== "blocked") {
				current.resultConsumed = true;
				if (inMemory) inMemory.resultConsumed = true;
				savePersistedSubagentRecord(ctx.cwd, current);
			}
			const text = [
				p.verbose ? formatSubagentRecord(current) : undefined,
				output
					? `${p.verbose ? "\n" : ""}${output}`
					: current.status === "running" || current.status === "queued"
						? t("result.stillRunning")
						: (current.error ?? t("agent.noOutput")),
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
			return subagentToolResult(
				text,
				{
					agentId: current.id,
					runId: current.runId,
					status: current.status,
				},
				current.status === "failed" || current.status === "error",
			);
		},
	};

	const steerSubagentTool: ToolDefinition = {
		name: "steer_subagent",
		label: "Steer Agent",
		description:
			"Send a steering note to a running pi-crew subagent. Live-session steering is planned; child-process runs expose durable status and can be cancelled if needed.",
		parameters: Type.Object({
			agent_id: Type.String(),
			message: Type.String(),
		}) as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { agent_id?: string; message?: string };
			const record = p.agent_id
				? (subagentManager.getRecord(p.agent_id) ?? readPersistedSubagentRecord(ctx.cwd, p.agent_id))
				: undefined;
			if (!record) return subagentToolResult(t("result.notFound", { id: p.agent_id ?? "" }), {}, true);
			return subagentToolResult(
				[
					t("steer.noted", { id: record.id }),
					t("steer.unavailable"),
					record.runId ? t("steer.cancelHint", { runId: record.runId }) : undefined,
				]
					.filter((line): line is string => Boolean(line))
					.join("\n"),
				{
					agentId: record.id,
					runId: record.runId,
					status: record.status,
				},
			);
		},
	};

	const crewAgentTool: ToolDefinition = {
		...agentTool,
		name: "crew_agent",
		label: "Crew Agent",
		description: "Launch a real pi-crew subagent using a conflict-safe pi-crew-specific tool name.",
		promptSnippet: "Use crew_agent when you need pi-crew subagents and another extension may own the generic Agent tool.",
	};
	const crewAgentResultTool: ToolDefinition = {
		...getSubagentResultTool,
		name: "crew_agent_result",
		label: "Get Crew Agent Result",
		description: "Check status and retrieve results from a pi-crew subagent using the conflict-safe tool name.",
	};
	const crewAgentSteerTool: ToolDefinition = {
		...steerSubagentTool,
		name: "crew_agent_steer",
		label: "Steer Crew Agent",
		description: "Send a steering note to a pi-crew subagent using the conflict-safe tool name.",
	};
	const toolConfig = loadConfig(process.cwd()).config.tools;
	const enableSteer = toolConfig?.enableSteer !== false;
	const enableClaudeStyleAliases = toolConfig?.enableClaudeStyleAliases !== false;

	for (const extraTool of enableSteer ? [crewAgentTool, crewAgentResultTool, crewAgentSteerTool] : [crewAgentTool, crewAgentResultTool])
		pi.registerTool(extraTool);
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

function startAgentToolProgress(cwd: string, agentRecordId: string, onUpdate: OnUpdate | undefined, manager: SubagentManager): () => void {
	if (!onUpdate) return () => {};
	const startedAt = Date.now();
	const tick = (): void => {
		try {
			const record = manager.getRecord(agentRecordId);
			if (!record) return;
			let manifest;
			let tasks;
			let agents;
			if (record.runId) {
				const loaded = loadRunManifestById(cwd, record.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
				if (loaded) {
					manifest = loaded.manifest;
					tasks = loaded.tasks;
					try {
						agents = readCrewAgents(loaded.manifest);
					} catch {
						/* ignore */
					}
				}
			}
			const text = formatCompactToolProgress({
				agentId: record.id,
				status: record.status,
				runId: record.runId,
				startedAt: record.startedAt ?? startedAt,
				manifest,
				tasks,
				agents,
				error: record.error,
			});
			onUpdate({ content: [{ type: "text", text }] });
		} catch (error) {
			logInternalError("subagent-tools.progress", error, `agentId=${agentRecordId}`);
		}
	};
	tick();
	const timer = setInterval(tick, TOOL_PROGRESS_TICK_MS);
	if (typeof timer.unref === "function") timer.unref();
	return () => clearInterval(timer);
}
