import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config/config.ts";
import { registerAutonomousPolicy } from "./autonomous-policy.ts";
import { TeamToolParams, type TeamToolParamsValue } from "../schema/team-tool-schema.ts";
import { startAsyncRunNotifier, stopAsyncRunNotifier, type AsyncNotifierState } from "./async-notifier.ts";
import { notifyActiveRuns } from "./session-summary.ts";
import { piTeamsHelp } from "./help.ts";
import { handleTeamManagerCommand } from "./team-manager-command.ts";
import { handleTeamTool, type TeamToolDetails } from "./team-tool.ts";
import { listRuns } from "./run-index.ts";
import { RunDashboard, type RunDashboardSelection } from "../ui/run-dashboard.ts";
import { registerPiCrewRpc, type PiCrewRpcHandle } from "./cross-extension-rpc.ts";
import { stopCrewWidget, updateCrewWidget, type CrewWidgetState } from "../ui/crew-widget.ts";
import { clearPiCrewPowerbar, registerPiCrewPowerbarSegments, updatePiCrewPowerbar } from "../ui/powerbar-publisher.ts";
import { DurableTextViewer, DurableTranscriptViewer } from "../ui/transcript-viewer.ts";
import { loadRunManifestById } from "../state/state-store.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { terminateActiveChildPiProcesses } from "../runtime/child-pi.ts";

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
	const foregroundControllers = new Set<AbortController>();
	const startForegroundRun = (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>): void => {
		const controller = new AbortController();
		foregroundControllers.add(controller);
		setImmediate(() => {
			void runner(controller.signal)
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`pi-crew foreground run failed: ${message}`, "error");
				})
				.finally(() => {
					foregroundControllers.delete(controller);
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
		for (const controller of foregroundControllers) controller.abort();
		foregroundControllers.clear();
		terminateActiveChildPiProcesses();
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
		notifyActiveRuns(ctx);
		const loadedConfig = loadConfig(ctx.cwd);
		registerPiCrewPowerbarSegments(pi.events, loadedConfig.config.ui);
		startAsyncRunNotifier(ctx, notifierState, loadedConfig.config.notifierIntervalMs ?? 5000);
		updateCrewWidget(ctx, widgetState, loadedConfig.config.ui);
		updatePiCrewPowerbar(pi.events, ctx.cwd, loadedConfig.config.ui);
		widgetState.interval = setInterval(() => {
			if (!currentCtx) return;
			const config = loadConfig(currentCtx.cwd).config.ui;
			updateCrewWidget(currentCtx, widgetState, config);
			updatePiCrewPowerbar(pi.events, currentCtx.cwd, config);
		}, 1000);
		widgetState.interval.unref?.();
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
				const output = await handleTeamTool(params as TeamToolParamsValue, { ...ctx, signal: controller.signal, startForegroundRun: (runner) => startForegroundRun(ctx, runner) });
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
			const result = await handleTeamTool(parseRunArgs(args), { ...ctx, startForegroundRun: (runner) => startForegroundRun(ctx as ExtensionContext, runner) });
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
				const runs = listRuns(ctx.cwd).slice(0, 50);
				const uiConfig = loadConfig(ctx.cwd).config.ui;
				const rightPanel = uiConfig?.dashboardPlacement !== "center";
				const width = rightPanel ? Math.min(120, Math.max(32, uiConfig?.dashboardWidth ?? 52)) : "90%";
				const selection = await ctx.ui.custom<RunDashboardSelection | undefined>((_tui, theme, _keybindings, done) => new RunDashboard(runs, done, theme, { showModel: uiConfig?.showModel, showTokens: uiConfig?.showTokens, showTools: uiConfig?.showTools }), {
					overlay: true,
					overlayOptions: { width, minWidth: rightPanel ? 32 : undefined, maxHeight: "90%", anchor: rightPanel ? "right-center" : "center", offsetX: rightPanel ? -1 : 0, margin: rightPanel ? { top: 1, right: 1, bottom: 1, left: 0 } : 2 },
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
