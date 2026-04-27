import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../config/config.ts";
import { registerAutonomousPolicy } from "./autonomous-policy.ts";
import { TeamToolParams, type TeamToolParamsValue } from "../schema/team-tool-schema.ts";
import { startAsyncRunNotifier, stopAsyncRunNotifier, type AsyncNotifierState } from "./async-notifier.ts";
import { notifyActiveRuns } from "./session-summary.ts";
import { piTeamsHelp } from "./help.ts";
import { handleTeamManagerCommand } from "./team-manager-command.ts";
import { handleTeamTool, type TeamToolDetails } from "./team-tool.ts";
import { listRecentRuns } from "./run-index.ts";
import { RunDashboard, type RunDashboardSelection } from "../ui/run-dashboard.ts";
import { LiveRunSidebar } from "../ui/live-run-sidebar.ts";
import { registerPiCrewRpc, type PiCrewRpcHandle } from "./cross-extension-rpc.ts";
import { stopCrewWidget, updateCrewWidget, type CrewWidgetState } from "../ui/crew-widget.ts";
import { clearPiCrewPowerbar, registerPiCrewPowerbarSegments, updatePiCrewPowerbar } from "../ui/powerbar-publisher.ts";
import { DurableTextViewer, DurableTranscriptViewer } from "../ui/transcript-viewer.ts";
import { loadRunManifestById, updateRunStatus } from "../state/state-store.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { terminateActiveChildPiProcesses } from "../runtime/child-pi.ts";
import { SubagentManager, type SubagentRecord, type SubagentSpawnOptions } from "../runtime/subagent-manager.ts";

function parseRunArgs(args: string): TeamToolParamsValue {
	const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
	const params: TeamToolParamsValue = { action: "run" };
	const goalParts: string[] = [];
	for (const token of tokens) {
		if (token === "--async") params.async = true;
		else if (token === "--worktree") params.workspaceMode = "worktree";
		else if (token.startsWith("--team=")) params.team = token.slice("--team=".length);
		else if (token.startsWith("--workflow=")) params.workflow = token.slice("--workflow=".length);
		else if (token.startsWith("--agent=")) params.agent = token.slice("--agent=".length);
		else if (token.startsWith("--role=")) params.role = token.slice("--role=".length);
		else if (!params.team && goalParts.length === 0 && !token.startsWith("--")) params.team = token;
		else goalParts.push(token);
	}
	params.goal = goalParts.join(" ").trim() || undefined;
	return params;
}

function commandText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

async function notifyCommandResult(ctx: ExtensionCommandContext, text: string): Promise<void> {
	ctx.ui.notify(text.length > 800 ? `${text.slice(0, 797)}...` : text, "info");
}

function parseScalar(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^-?\d+$/.test(raw)) return Number(raw);
	if (raw.includes(",")) return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
	return raw;
}

async function selectAgentTask(ctx: ExtensionCommandContext, runId: string | undefined, taskId?: string): Promise<{ runId: string; taskId?: string } | undefined> {
	if (!runId) return undefined;
	if (taskId) return { runId, taskId };
	const loaded = loadRunManifestById(ctx.cwd, runId);
	if (!loaded) return { runId };
	const agents = readCrewAgents(loaded.manifest);
	if (ctx.hasUI && agents.length > 1) {
		const choice = await ctx.ui.select("Select pi-crew agent", agents.map((agent) => `${agent.taskId} ${agent.role}→${agent.agent} [${agent.status}]`));
		return { runId, taskId: choice?.split(" ")[0] };
	}
	return { runId, taskId: agents[0]?.taskId };
}

async function openTranscriptViewer(ctx: ExtensionCommandContext, runId: string | undefined, taskId?: string): Promise<boolean> {
	const selected = await selectAgentTask(ctx, runId, taskId);
	if (!selected) return false;
	// eslint-disable-next-line no-param-reassign
	runId = selected.runId;
	// eslint-disable-next-line no-param-reassign
	taskId = selected.taskId;
	if (!runId || !ctx.hasUI) return false;
	const loaded = loadRunManifestById(ctx.cwd, runId);
	if (!loaded) return false;
	await ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) => new DurableTranscriptViewer(loaded.manifest, theme, done, taskId), {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" },
	});
	return true;
}

function pushUnset(config: Record<string, unknown>, key: string): void {
	const current = Array.isArray(config.unset) ? config.unset : [];
	current.push(key);
	config.unset = current;
}

function setNestedConfig(config: Record<string, unknown>, key: string, value: unknown): void {
	const parts = key.split(".").filter(Boolean);
	if (parts.length === 0) return;
	let target = config;
	for (const part of parts.slice(0, -1)) {
		const current = target[part];
		if (!current || typeof current !== "object" || Array.isArray(current)) target[part] = {};
		target = target[part] as Record<string, unknown>;
	}
	target[parts[parts.length - 1]!] = value;
}

function sendFollowUp(pi: ExtensionAPI, content: string): void {
	const sender = (pi as unknown as { sendMessage?: (message: unknown, options?: unknown) => void }).sendMessage;
	if (typeof sender !== "function") return;
	sender.call(pi, { customType: "pi-crew-subagent-notification", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
}

function formatSubagentRecord(record: SubagentRecord): string {
	const duration = record.completedAt ? `${Math.round((record.completedAt - record.startedAt) / 1000)}s` : "running";
	return [
		`Agent: ${record.id}`,
		`Type: ${record.type}`,
		`Status: ${record.status}`,
		record.runId ? `Run: ${record.runId}` : undefined,
		`Description: ${record.description}`,
		record.model ? `Model: ${record.model}` : undefined,
		`Duration: ${duration}`,
		record.error ? `Error: ${record.error}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
}

function readSubagentRunResult(ctx: ExtensionContext | ExtensionCommandContext, record: SubagentRecord): string | undefined {
	if (!record.runId) return record.result;
	const loaded = loadRunManifestById(ctx.cwd, record.runId);
	const task = loaded?.tasks.find((item) => item.resultArtifact) ?? loaded?.tasks[0];
	const path = task?.resultArtifact?.path;
	if (!path) return undefined;
	try {
		return fs.readFileSync(path, "utf-8").trim();
	} catch {
		return undefined;
	}
}

function subagentToolResult(text: string, details: Record<string, unknown> = {}, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

export function __test__subagentSpawnParams(params: Record<string, unknown>, ctx: Pick<ExtensionContext, "cwd">): SubagentSpawnOptions {
	return {
		cwd: ctx.cwd,
		type: typeof params.subagent_type === "string" && params.subagent_type.trim() ? params.subagent_type.trim() : "executor",
		description: typeof params.description === "string" && params.description.trim() ? params.description.trim() : "pi-crew subagent",
		prompt: typeof params.prompt === "string" ? params.prompt : "",
		background: params.run_in_background === true,
		model: typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined,
		maxTurns: typeof params.max_turns === "number" && Number.isFinite(params.max_turns) ? params.max_turns : undefined,
	};
}

export function registerPiTeams(pi: ExtensionAPI): void {
	const globalStore = globalThis as Record<string, unknown>;
	const runtimeCleanupStoreKey = "__piCrewRuntimeCleanup";
	const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
	if (typeof previousRuntimeCleanup === "function") {
		try { previousRuntimeCleanup(); } catch {}
	}
	const notifierState: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	let currentCtx: ExtensionContext | undefined;
	let rpcHandle: PiCrewRpcHandle | undefined;
	let cleanedUp = false;
	const widgetState: CrewWidgetState = { frame: 0 };
	const subagentManager = new SubagentManager(4, (record) => {
		if (!record.background || record.resultConsumed) return;
		if (record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "error") {
			sendFollowUp(pi, [`pi-crew subagent ${record.id} ${record.status}.`, record.runId ? `Run: ${record.runId}` : undefined, `Use get_subagent_result with agent_id=${record.id} for output.`].filter((line): line is string => Boolean(line)).join("\n"));
		}
	});
	const foregroundControllers = new Set<AbortController>();
	let liveSidebarRunId: string | undefined;
	let liveSidebarTimer: ReturnType<typeof setInterval> | undefined;
	const requestRender = (ctx: ExtensionContext): void => (ctx.ui as { requestRender?: () => void }).requestRender?.();
	const stopSessionBoundSubagents = (): void => {
		for (const controller of foregroundControllers) controller.abort();
		foregroundControllers.clear();
		subagentManager.abortAll();
		terminateActiveChildPiProcesses();
		if (liveSidebarTimer) clearInterval(liveSidebarTimer);
		liveSidebarTimer = undefined;
		liveSidebarRunId = undefined;
		if (currentCtx) stopCrewWidget(currentCtx, widgetState, loadConfig(currentCtx.cwd).config.ui);
		clearPiCrewPowerbar(pi.events);
	};
	const openLiveSidebar = (ctx: ExtensionContext, runId: string): void => {
		const uiConfig = loadConfig(ctx.cwd).config.ui;
		const autoOpen = uiConfig?.autoOpenDashboard === true;
		const foregroundAutoOpen = uiConfig?.autoOpenDashboardForForegroundRuns !== false;
		if (!ctx.hasUI || !autoOpen || !foregroundAutoOpen || (uiConfig?.dashboardPlacement ?? "right") !== "right") return;
		if (liveSidebarRunId === runId) return;
		if (liveSidebarTimer) clearInterval(liveSidebarTimer);
		liveSidebarRunId = runId;
		ctx.ui.setWidget("pi-crew", undefined, { placement: uiConfig?.widgetPlacement ?? "aboveEditor" });
		ctx.ui.setWidget("pi-crew-active", undefined, { placement: uiConfig?.widgetPlacement ?? "aboveEditor" });
		const width = Math.min(90, Math.max(40, uiConfig?.dashboardWidth ?? 56));
		liveSidebarTimer = setInterval(() => requestRender(ctx), uiConfig?.dashboardLiveRefreshMs ?? 1000);
		liveSidebarTimer.unref?.();
		void ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) => new LiveRunSidebar({ cwd: ctx.cwd, runId, done, theme, config: uiConfig }), {
			overlay: true,
			overlayOptions: { width, minWidth: 40, maxHeight: "100%", anchor: "top-right", offsetX: 0, offsetY: 0, margin: { top: 0, right: 0, bottom: 0, left: 0 }, visible: (termWidth: number) => termWidth >= 100 },
		}).finally(() => {
			if (liveSidebarRunId === runId) liveSidebarRunId = undefined;
			if (liveSidebarTimer) clearInterval(liveSidebarTimer);
			liveSidebarTimer = undefined;
			updateCrewWidget(ctx, widgetState, loadConfig(ctx.cwd).config.ui);
		});
	};
	const startForegroundRun = (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>, runId?: string): void => {
		const controller = new AbortController();
		foregroundControllers.add(controller);
		setImmediate(() => {
			void runner(controller.signal)
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					if (runId) {
						try {
							const loaded = loadRunManifestById(ctx.cwd, runId);
							if (loaded && loaded.manifest.status !== "completed" && loaded.manifest.status !== "failed" && loaded.manifest.status !== "cancelled" && loaded.manifest.status !== "blocked") updateRunStatus(loaded.manifest, "failed", message);
						} catch {}
					}
					ctx.ui.notify(`pi-crew foreground run failed: ${message}`, "error");
				})
				.finally(() => {
					foregroundControllers.delete(controller);
					if (runId) {
						const loaded = loadRunManifestById(ctx.cwd, runId);
						const status = loaded?.manifest.status ?? "finished";
						const level = status === "failed" || status === "blocked" ? "error" : status === "cancelled" ? "warning" : "info";
						ctx.ui.notify(`pi-crew run ${runId} ${status}. Use /team-summary ${runId} or /team-status ${runId}.`, level as "info" | "warning" | "error");
					}
					if (currentCtx) {
						const config = loadConfig(currentCtx.cwd).config.ui;
						updateCrewWidget(currentCtx, widgetState, config);
						updatePiCrewPowerbar(pi.events, currentCtx.cwd, config);
					}
				});
		});
	};
	registerAutonomousPolicy(pi);
	rpcHandle = registerPiCrewRpc((pi as unknown as { events?: Parameters<typeof registerPiCrewRpc>[0] }).events, () => currentCtx);
	const cleanupRuntime = (): void => {
		if (cleanedUp) return;
		cleanedUp = true;
		stopSessionBoundSubagents();
		stopAsyncRunNotifier(notifierState);
		stopCrewWidget(currentCtx, widgetState, currentCtx ? loadConfig(currentCtx.cwd).config.ui : undefined);
		clearPiCrewPowerbar(pi.events);
		rpcHandle?.unsubscribe();
		rpcHandle = undefined;
		currentCtx = undefined;
		if (globalStore[runtimeCleanupStoreKey] === cleanupRuntime) delete globalStore[runtimeCleanupStoreKey];
	};
	globalStore[runtimeCleanupStoreKey] = cleanupRuntime;

	pi.on("session_start", (_event, ctx) => {
		cleanedUp = false;
		currentCtx = ctx;
		if (widgetState.interval) clearInterval(widgetState.interval);
		widgetState.interval = undefined;
		notifyActiveRuns(ctx);
		const loadedConfig = loadConfig(ctx.cwd);
		registerPiCrewPowerbarSegments(pi.events, loadedConfig.config.ui);
		startAsyncRunNotifier(ctx, notifierState, loadedConfig.config.notifierIntervalMs ?? 5000);
		updateCrewWidget(ctx, widgetState, loadedConfig.config.ui);
		updatePiCrewPowerbar(pi.events, ctx.cwd, loadedConfig.config.ui);
		widgetState.interval = setInterval(() => {
			if (!currentCtx) return;
			const config = loadConfig(currentCtx.cwd).config.ui;
			if (liveSidebarRunId) {
				currentCtx.ui.setWidget("pi-crew", undefined, { placement: config?.widgetPlacement ?? "aboveEditor" });
				currentCtx.ui.setWidget("pi-crew-active", undefined, { placement: config?.widgetPlacement ?? "aboveEditor" });
			} else {
				updateCrewWidget(currentCtx, widgetState, config);
			}
			updatePiCrewPowerbar(pi.events, currentCtx.cwd, config);
		}, 1000);
		widgetState.interval.unref?.();
	});
	pi.on("session_before_switch", () => {
		stopSessionBoundSubagents();
	});
	pi.on("session_shutdown", () => {
		cleanupRuntime();
	});

	const tool: ToolDefinition = {
		name: "team",
		label: "Team",
		description: "Coordinate Pi teams. Use proactively for complex multi-file work, planning, implementation, tests, reviews, security audits, research, async/background runs, and worktree-isolated execution. Use action='recommend' when unsure which team/workflow to choose. Destructive actions require explicit user confirmation.",
		promptSnippet: "Use the team tool proactively for coordinated multi-agent work. If unsure, call { action: 'recommend', goal } first, then run or plan with the suggested team/workflow.",
		parameters: TeamToolParams as never,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const controller = new AbortController();
			foregroundControllers.add(controller);
			const abort = (): void => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const output = await handleTeamTool(params as TeamToolParamsValue, { ...ctx, signal: controller.signal, startForegroundRun: (runner, runId) => startForegroundRun(ctx, runner, runId), onRunStarted: (runId) => openLiveSidebar(ctx, runId) });
				const config = loadConfig(ctx.cwd).config.ui;
				updateCrewWidget(ctx, widgetState, config);
				updatePiCrewPowerbar(pi.events, ctx.cwd, config);
				return output;
			} finally {
				signal?.removeEventListener("abort", abort);
				foregroundControllers.delete(controller);
			}
		},
	};

	pi.registerTool(tool);

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
			const options = __test__subagentSpawnParams(params as Record<string, unknown>, ctx);
			if (!options.prompt.trim()) return subagentToolResult("Agent requires prompt.", {}, true);
			const runner = async (spawnOptions: SubagentSpawnOptions, childSignal?: AbortSignal) => handleTeamTool({
				action: "run",
				agent: spawnOptions.type,
				goal: spawnOptions.prompt,
				model: spawnOptions.model,
				async: false,
				config: spawnOptions.maxTurns ? { runtime: { maxTurns: spawnOptions.maxTurns } } : undefined,
			}, spawnOptions.background ? { ...ctx, signal: childSignal, startForegroundRun: (run, runId) => startForegroundRun(ctx, run, runId), onRunStarted: (runId) => openLiveSidebar(ctx, runId) } : { ...ctx, signal: childSignal });
			const record = subagentManager.spawn(options, runner, options.background ? undefined : signal);
			if (options.background || record.status === "queued") {
				return subagentToolResult([`Agent ${record.status === "queued" ? "queued" : "started"}.`, `Agent ID: ${record.id}`, `Type: ${record.type}`, `Description: ${record.description}`, "Use get_subagent_result to retrieve output. Do not duplicate this agent's work."].join("\n"), { agentId: record.id, status: record.status });
			}
			await record.promise;
			const output = readSubagentRunResult(ctx, record) ?? record.result ?? "No output.";
			return subagentToolResult([`Agent ${record.id} ${record.status}.`, "", output].join("\n"), { agentId: record.id, runId: record.runId, status: record.status }, record.status === "failed" || record.status === "error");
		},
	};

	const getSubagentResultTool: ToolDefinition = {
		name: "get_subagent_result",
		label: "Get Agent Result",
		description: "Check status and retrieve results from a pi-crew background subagent.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "Agent ID returned by Agent." }),
			wait: Type.Optional(Type.Boolean({ description: "Wait for completion before returning." })),
			verbose: Type.Optional(Type.Boolean({ description: "Include status metadata before output." })),
		}) as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { agent_id?: string; wait?: boolean; verbose?: boolean };
			if (!p.agent_id) return subagentToolResult("get_subagent_result requires agent_id.", {}, true);
			const record = subagentManager.getRecord(p.agent_id);
			if (!record) return subagentToolResult(`Agent not found: ${p.agent_id}`, {}, true);
			let current = record;
			if (p.wait && (current.status === "running" || current.status === "queued")) {
				current.resultConsumed = true;
				current = await subagentManager.waitForRecord(current.id) ?? current;
			}
			const output = readSubagentRunResult(ctx, current);
			if (current.status !== "running" && current.status !== "queued") current.resultConsumed = true;
			const text = [p.verbose ? formatSubagentRecord(current) : undefined, output ? `${p.verbose ? "\n" : ""}${output}` : current.status === "running" || current.status === "queued" ? "Agent is still running. Use wait=true or check again later." : current.error ?? "No output."].filter((line): line is string => Boolean(line)).join("\n");
			return subagentToolResult(text, { agentId: current.id, runId: current.runId, status: current.status }, current.status === "failed" || current.status === "error");
		},
	};

	const steerSubagentTool: ToolDefinition = {
		name: "steer_subagent",
		label: "Steer Agent",
		description: "Send a steering note to a running pi-crew subagent. Live-session steering is planned; child-process runs expose durable status and can be cancelled if needed.",
		parameters: Type.Object({ agent_id: Type.String(), message: Type.String() }) as never,
		async execute(_id, params) {
			const p = params as { agent_id?: string; message?: string };
			const record = p.agent_id ? subagentManager.getRecord(p.agent_id) : undefined;
			if (!record) return subagentToolResult(`Agent not found: ${p.agent_id ?? ""}`, {}, true);
			return subagentToolResult([`Steering request noted for ${record.id}.`, "Current default pi-crew backend is child-process, so mid-turn session.steer is not available yet.", record.runId ? `Use team cancel runId=${record.runId} if the agent must be interrupted.` : undefined].filter((line): line is string => Boolean(line)).join("\n"), { agentId: record.id, runId: record.runId, status: record.status });
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
	for (const extraTool of [crewAgentTool, crewAgentResultTool, crewAgentSteerTool]) pi.registerTool(extraTool);
	for (const extraTool of [agentTool, getSubagentResultTool, steerSubagentTool]) {
		try { pi.registerTool(extraTool); } catch {}
	}

	pi.registerCommand("teams", {
		description: "List pi-crew teams, workflows, and agents",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "list" }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-run", {
		description: "Manually start a pi-crew run (agent may also use the team tool autonomously)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool(parseRunArgs(args), { ...ctx, startForegroundRun: (runner, runId) => startForegroundRun(ctx as ExtensionContext, runner, runId), onRunStarted: (runId) => openLiveSidebar(ctx as ExtensionContext, runId) });
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-status", {
		description: "Show pi-crew run status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			const result = await handleTeamTool({ action: "status", runId }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-resume", {
		description: "Resume a pi-crew run by re-queueing failed/cancelled/skipped/running tasks",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			const result = await handleTeamTool({ action: "resume", runId }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-summary", {
		description: "Show pi-crew run summary",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			const result = await handleTeamTool({ action: "summary", runId }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-events", {
		description: "Show full pi-crew event log for a run",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			const result = await handleTeamTool({ action: "events", runId }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-artifacts", {
		description: "List pi-crew artifacts for a run",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			const result = await handleTeamTool({ action: "artifacts", runId }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-worktrees", {
		description: "List pi-crew worktrees for a run",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			const result = await handleTeamTool({ action: "worktrees", runId }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-api", {
		description: "Run safe pi-crew API interop operations: <runId> <operation> [key=value]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.find((token) => !token.includes("=") && !token.startsWith("--"));
			const operation = tokens.find((token) => token !== runId && !token.includes("=") && !token.startsWith("--")) ?? "read-manifest";
			const config: Record<string, unknown> = { operation };
			for (const token of tokens.filter((item) => item.includes("="))) {
				const [key, ...rest] = token.split("=");
				if (key) config[key] = parseScalar(rest.join("="));
			}
			const result = await handleTeamTool({ action: "api", runId, config }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-imports", {
		description: "List imported pi-crew run bundles",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "imports" }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-import", {
		description: "Import a pi-crew run-export.json bundle into local imports",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const pathArg = tokens.find((token) => !token.startsWith("--"));
			const scope = tokens.includes("--user") ? "user" : "project";
			const result = await handleTeamTool({ action: "import", config: { path: pathArg, scope } }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-export", {
		description: "Export a pi-crew run bundle to artifacts/export",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			const result = await handleTeamTool({ action: "export", runId }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-prune", {
		description: "Prune old finished pi-crew runs, keeping the newest N",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const keepToken = tokens.find((token) => token.startsWith("--keep="));
			const keep = keepToken ? Number.parseInt(keepToken.slice("--keep=".length), 10) : undefined;
			const confirm = tokens.includes("--confirm");
			const result = await handleTeamTool({ action: "prune", keep, confirm }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-forget", {
		description: "Forget a pi-crew run by deleting its state and artifacts",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.find((token) => !token.startsWith("--"));
			const force = tokens.includes("--force");
			const confirm = tokens.includes("--confirm");
			const result = await handleTeamTool({ action: "forget", runId, force, confirm }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-cleanup", {
		description: "Clean up pi-crew worktrees for a run",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.find((token) => !token.startsWith("--"));
			const force = tokens.includes("--force");
			const result = await handleTeamTool({ action: "cleanup", runId, force }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-manager", {
		description: "Open a simple pi-crew interactive manager",
		handler: handleTeamManagerCommand,
	});

	pi.registerCommand("team-result", {
		description: "Open a pi-crew agent result viewer: <runId> [taskId]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [runId, rawTaskId] = args.trim().split(/\s+/).filter(Boolean);
			const selected = await selectAgentTask(ctx, runId, rawTaskId);
			const loaded = selected ? loadRunManifestById(ctx.cwd, selected.runId) : undefined;
			if (ctx.hasUI && loaded) {
				const agent = readCrewAgents(loaded.manifest).find((item) => item.taskId === selected?.taskId || item.id === selected?.taskId) ?? readCrewAgents(loaded.manifest)[0];
				const text = agent?.resultArtifactPath ? commandText(await handleTeamTool({ action: "api", runId: selected!.runId, config: { operation: "read-agent-output", agentId: agent.taskId, maxBytes: 64_000 } }, ctx)) : "(no result)";
				await ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) => new DurableTextViewer("pi-crew result", `${selected!.runId}:${agent?.taskId ?? "unknown"}`, text.split(/\r?\n/), theme, done), { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
				return;
			}
			const result = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-output", agentId: rawTaskId, maxBytes: 64_000 } }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-transcript", {
		description: "Open a pi-crew transcript viewer: <runId> [taskId]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [runId, taskId] = args.trim().split(/\s+/).filter(Boolean);
			if (await openTranscriptViewer(ctx, runId, taskId)) return;
			const result = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-transcript", agentId: taskId } }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-dashboard", {
		description: "Open a pi-crew run dashboard overlay",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			for (;;) {
				const runs = listRecentRuns(ctx.cwd, 50);
				const uiConfig = loadConfig(ctx.cwd).config.ui;
				const rightPanel = uiConfig?.dashboardPlacement !== "center";
				const width = rightPanel ? Math.min(90, Math.max(40, uiConfig?.dashboardWidth ?? 56)) : "90%";
				const selection = await ctx.ui.custom<RunDashboardSelection | undefined>((_tui, theme, _keybindings, done) => new RunDashboard(runs, done, theme, { placement: rightPanel ? "right" : "center", showModel: uiConfig?.showModel, showTokens: uiConfig?.showTokens, showTools: uiConfig?.showTools }), {
					overlay: true,
					overlayOptions: rightPanel
						? { width, minWidth: 40, maxHeight: "100%", anchor: "top-right", offsetX: 0, offsetY: 0, margin: { top: 0, right: 0, bottom: 0, left: 0 } }
						: { width, maxHeight: "90%", anchor: "center", margin: 2 },
				});
				if (!selection) return;
				if (selection.action === "reload") continue;
				if (selection.action === "agent-transcript" && await openTranscriptViewer(ctx, selection.runId)) continue;
				const result = selection.action === "api"
					? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-manifest" } }, ctx)
					: selection.action === "agents"
						? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "agent-dashboard" } }, ctx)
						: selection.action === "agent-events"
							? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-agent-events", limit: 50 } }, ctx)
							: selection.action === "agent-output"
								? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-agent-output", maxBytes: 32_000 } }, ctx)
								: selection.action === "agent-transcript"
									? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-agent-transcript" } }, ctx)
									: await handleTeamTool({ action: selection.action, runId: selection.runId }, ctx);
				await notifyCommandResult(ctx, commandText(result));
				return;
			}
		},
	});

	pi.registerCommand("team-init", {
		description: "Initialize project-local pi-crew directories and gitignore entries",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const result = await handleTeamTool({ action: "init", config: { copyBuiltins: tokens.includes("--copy-builtins"), overwrite: tokens.includes("--overwrite") } }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-autonomy", {
		description: "Show or toggle pi-crew autonomous delegation policy: status|on|off",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const mode = tokens[0]?.toLowerCase();
			const config = mode === "on" ? { profile: "suggested", enabled: true, injectPolicy: true }
				: mode === "off" ? { profile: "manual", enabled: false }
				: mode === "manual" || mode === "suggested" || mode === "assisted" || mode === "aggressive" ? { profile: mode, enabled: mode !== "manual", injectPolicy: mode !== "manual" }
				: {
					preferAsyncForLongTasks: tokens.includes("--prefer-async") ? true : undefined,
					allowWorktreeSuggestion: tokens.includes("--no-worktree-suggest") ? false : undefined,
				};
			const result = await handleTeamTool({ action: "autonomy", config }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-config", {
		description: "Show or update pi-crew config. Use key=value [--project] to update.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				const result = await handleTeamTool({ action: "config" }, ctx);
				await notifyCommandResult(ctx, commandText(result));
				return;
			}
			const config: Record<string, unknown> = { scope: tokens.includes("--project") ? "project" : "user" };
			for (const token of tokens) {
				if (token.startsWith("--unset=")) {
					pushUnset(config, token.slice("--unset=".length));
					continue;
				}
				if (!token.includes("=")) continue;
				const [key, ...rest] = token.split("=");
				if (!key) continue;
				const raw = rest.join("=");
				if (raw === "unset" || raw === "null") pushUnset(config, key);
				else setNestedConfig(config, key, parseScalar(raw));
			}
			const result = await handleTeamTool({ action: "config", config }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-validate", {
		description: "Validate pi-crew agents, teams, and workflows",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "validate" }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-help", {
		description: "Show pi-crew command help",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await notifyCommandResult(ctx, piTeamsHelp());
		},
	});

	pi.registerCommand("team-cancel", {
		description: "Cancel a pi-crew run",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			const result = await handleTeamTool({ action: "cancel", runId }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-doctor", {
		description: "Check pi-crew installation and discovery readiness",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "doctor" }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});
}
