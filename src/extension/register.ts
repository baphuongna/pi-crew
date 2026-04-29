import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config/config.ts";
import { registerAutonomousPolicy } from "./autonomous-policy.ts";
import { startAsyncRunNotifier, stopAsyncRunNotifier, type AsyncNotifierState } from "./async-notifier.ts";
import { notifyActiveRuns } from "./session-summary.ts";
import { LiveRunSidebar } from "../ui/live-run-sidebar.ts";
import { registerPiCrewRpc, type PiCrewRpcHandle } from "./cross-extension-rpc.ts";
import { stopCrewWidget, updateCrewWidget, type CrewWidgetState } from "../ui/crew-widget.ts";
import { clearPiCrewPowerbar, registerPiCrewPowerbarSegments, updatePiCrewPowerbar } from "../ui/powerbar-publisher.ts";
import { loadRunManifestById, updateRunStatus } from "../state/state-store.ts";
import { terminateActiveChildPiProcesses } from "../subagents/spawn.ts";
import { SubagentManager } from "../subagents/manager.ts";
import { __test__subagentSpawnParams, sendFollowUp } from "./registration/subagent-helpers.ts";
import { DEFAULT_UI } from "../config/defaults.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { createManifestCache } from "../runtime/manifest-cache.ts";
import { resetTimings, time } from "../utils/timings.ts";
import { registerTeamCommands } from "./registration/commands.ts";
import { registerSubagentTools } from "./registration/subagent-tools.ts";
import { runArtifactCleanup } from "./registration/artifact-cleanup.ts";
import { registerTeamTool } from "./registration/team-tool.ts";
import { registerCompactionGuard } from "./registration/compaction-guard.ts";

export { __test__subagentSpawnParams };

export function registerPiTeams(pi: ExtensionAPI): void {
	resetTimings();
	time("register:start");
	const globalStore = globalThis as Record<string, unknown>;
	const runtimeCleanupStoreKey = "__piCrewRuntimeCleanup";
	const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
	time("register:init");
	if (typeof previousRuntimeCleanup === "function") {
		try {
			previousRuntimeCleanup();
		} catch (error) {
			logInternalError("register.prev-cleanup", error);
		}
	}
	const notifierState: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	let currentCtx: ExtensionContext | undefined;
	let rpcHandle: PiCrewRpcHandle | undefined;
	let cleanedUp = false;
	let manifestCache = createManifestCache(process.cwd());
	const getManifestCache = (cwd: string): ReturnType<typeof createManifestCache> => {
		if (manifestCache && currentCtx?.cwd === cwd) return manifestCache;
		if (manifestCache) manifestCache.dispose();
		manifestCache = createManifestCache(cwd);
		return manifestCache;
	};
	const telemetryEnabled = (): boolean => loadConfig(currentCtx?.cwd ?? process.cwd()).config.telemetry?.enabled !== false;
	const widgetState: CrewWidgetState = { frame: 0 };
	const subagentManager = new SubagentManager(
		4,
		(record) => {
			// Phase 1.3 + 1.6: Emit public crew.subagent.completed event with telemetry.
			// Users can opt out with config.telemetry.enabled=false.
			if (telemetryEnabled()) {
				pi.events?.emit?.("crew.subagent.completed", {
					id: record.id,
					runId: record.runId,
					type: record.type,
					status: record.status,
					turnCount: record.turnCount,
					terminated: record.terminated ?? false,
					durationMs: record.durationMs,
				});
			}
			if (!record.background || record.resultConsumed) return;
			if (record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "blocked" || record.status === "error") {
				sendFollowUp(pi, [`pi-crew subagent ${record.id} ${record.status}.`, record.runId ? `Run: ${record.runId}` : undefined, `Use get_subagent_result with agent_id=${record.id} for output.`].filter((line): line is string => Boolean(line)).join("\n"));
			}
		},
		1000,
		(event, payload) => {
			if (event === "subagent.stuck-blocked") {
				const id = typeof payload.id === "string" ? payload.id : "unknown";
				const runId = typeof payload.runId === "string" ? payload.runId : "unknown";
				const durationMs = typeof payload.durationMs === "number" ? payload.durationMs : 0;
				sendFollowUp(pi, [`pi-crew subagent ${id} may be stuck in blocked state for ${Math.max(1, Math.round(durationMs / 1000))}s.`, `Run: ${runId}`, `Use team status runId=${runId} and investigate.`, "Subagent may need manual intervention."].filter((line): line is string => Boolean(line)).join("\n"));
			}
			pi.events?.emit?.(event, payload);
		},
	);
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
		liveSidebarTimer = setInterval(() => requestRender(ctx), uiConfig?.dashboardLiveRefreshMs ?? DEFAULT_UI.refreshMs);
		liveSidebarTimer.unref?.();
		void ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) => new LiveRunSidebar({ cwd: ctx.cwd, runId, done, theme, config: uiConfig }), {
			overlay: true,
			overlayOptions: { width, minWidth: 40, maxHeight: "100%", anchor: "top-right", offsetX: 0, offsetY: 0, margin: { top: 0, right: 0, bottom: 0, left: 0 }, visible: (termWidth: number) => termWidth >= 100 },
		}).finally(() => {
			if (liveSidebarRunId === runId) liveSidebarRunId = undefined;
			if (liveSidebarTimer) clearInterval(liveSidebarTimer);
			liveSidebarTimer = undefined;
			updateCrewWidget(ctx, widgetState, loadConfig(ctx.cwd).config.ui, getManifestCache(ctx.cwd));
		});
	};
	const startForegroundRun = (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>, runId?: string): void => {
		const controller = new AbortController();
		foregroundControllers.add(controller);
		if (ctx.hasUI) {
			(ctx.ui as { setWorkingIndicator?: (options?: { frames?: string[]; intervalMs?: number }) => void }).setWorkingIndicator?.({ frames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"], intervalMs: 80 });
			ctx.ui.setWorkingMessage(runId ? `pi-crew foreground run ${runId}...` : "pi-crew foreground run...");
		}
		setImmediate(() => {
			void runner(controller.signal)
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					if (runId) {
						try {
							const loaded = loadRunManifestById(ctx.cwd, runId);
							if (loaded && loaded.manifest.status !== "completed" && loaded.manifest.status !== "failed" && loaded.manifest.status !== "cancelled" && loaded.manifest.status !== "blocked") updateRunStatus(loaded.manifest, "failed", message);
						} catch (statusError) {
							logInternalError("register.foreground-run-failure", statusError, `runId=${runId}`);
						}
					}
					ctx.ui.notify(`pi-crew foreground run failed: ${message}`, "error");
				})
				.finally(() => {
					foregroundControllers.delete(controller);
					if (ctx.hasUI) {
						(ctx.ui as { setWorkingIndicator?: (options?: { frames?: string[]; intervalMs?: number }) => void }).setWorkingIndicator?.();
						ctx.ui.setWorkingMessage();
					}
					if (runId) {
						const loaded = loadRunManifestById(ctx.cwd, runId);
						const status = loaded?.manifest.status ?? "finished";
						const level = status === "failed" || status === "blocked" ? "error" : status === "cancelled" ? "warning" : "info";
						ctx.ui.notify(`pi-crew run ${runId} ${status}. Use /team-summary ${runId} or /team-status ${runId}.`, level as "info" | "warning" | "error");
						// Phase 2.3: Persist run completion reference into the Pi session.
						pi.appendEntry("crew:run-completed", {
							runId,
							team: loaded?.manifest.team,
							workflow: loaded?.manifest.workflow,
							goal: loaded?.manifest.goal,
							status,
							taskCount: loaded?.tasks.length,
							timestamp: Date.now(),
						});
						// Phase 1.3: Emit public crew.run.* events
						const eventType = status === "completed" ? "crew.run.completed" : status === "failed" || status === "blocked" ? "crew.run.failed" : status === "cancelled" ? "crew.run.cancelled" : undefined;
						if (eventType) {
							pi.events?.emit?.(eventType, {
								runId,
								team: loaded?.manifest.team,
								workflow: loaded?.manifest.workflow,
								status,
								taskCount: loaded?.tasks.length,
								goal: loaded?.manifest.goal,
							});
						}
					}
					if (currentCtx) {
						const config = loadConfig(currentCtx.cwd).config.ui;
						updateCrewWidget(currentCtx, widgetState, config, getManifestCache(currentCtx.cwd));
						updatePiCrewPowerbar(pi.events, currentCtx.cwd, config, getManifestCache(currentCtx.cwd));
					}
				});
		});
	};
	time("register.policy");
	registerAutonomousPolicy(pi);
	time("register.rpc");
	rpcHandle = registerPiCrewRpc((pi as unknown as { events?: Parameters<typeof registerPiCrewRpc>[0] }).events, () => currentCtx);

	const cleanupRuntime = (): void => {
		if (cleanedUp) return;
		cleanedUp = true;
		stopSessionBoundSubagents();
		stopAsyncRunNotifier(notifierState);
		stopCrewWidget(currentCtx, widgetState, currentCtx ? loadConfig(currentCtx.cwd).config.ui : undefined);
		clearPiCrewPowerbar(pi.events);
		manifestCache.dispose();
		rpcHandle?.unsubscribe();
		rpcHandle = undefined;
		currentCtx = undefined;
		if (globalStore[runtimeCleanupStoreKey] === cleanupRuntime) delete globalStore[runtimeCleanupStoreKey];
	};
	globalStore[runtimeCleanupStoreKey] = cleanupRuntime;

	pi.on("session_start", (_event, ctx) => {
		runArtifactCleanup(ctx.cwd);
		time("register.session-start");
		cleanedUp = false;
		currentCtx = ctx;
		if (widgetState.interval) clearInterval(widgetState.interval);
		widgetState.interval = undefined;
		notifyActiveRuns(ctx);
		const loadedConfig = loadConfig(ctx.cwd);
		registerPiCrewPowerbarSegments(pi.events, loadedConfig.config.ui);
		startAsyncRunNotifier(ctx, notifierState, loadedConfig.config.notifierIntervalMs ?? DEFAULT_UI.notifierIntervalMs);
		const cache = getManifestCache(ctx.cwd);
		updateCrewWidget(ctx, widgetState, loadedConfig.config.ui, cache);
		updatePiCrewPowerbar(pi.events, ctx.cwd, loadedConfig.config.ui, cache);
		widgetState.interval = setInterval(() => {
			if (!currentCtx) return;
			const config = loadConfig(currentCtx.cwd).config.ui;
			const cache = getManifestCache(currentCtx.cwd);
			if (liveSidebarRunId) {
				currentCtx.ui.setWidget("pi-crew", undefined, { placement: config?.widgetPlacement ?? "aboveEditor" });
				currentCtx.ui.setWidget("pi-crew-active", undefined, { placement: config?.widgetPlacement ?? "aboveEditor" });
			} else {
				updateCrewWidget(currentCtx, widgetState, config, cache);
			}
			updatePiCrewPowerbar(pi.events, currentCtx.cwd, config, cache);
		}, DEFAULT_UI.widgetDefaultFrameMs);
		widgetState.interval.unref?.();
	});
	pi.on("session_before_switch", () => stopSessionBoundSubagents());
	pi.on("session_shutdown", () => cleanupRuntime());

	registerCompactionGuard(pi, { foregroundControllers });

	// Phase 1.4: Permission gate for destructive team actions.
	// AGENTS.md requires confirm=true for management deletes.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "team") return;
		const input = (event as { input?: Record<string, unknown> }).input;
		if (!input) return;
		const action = typeof input.action === "string" ? input.action : undefined;
		const destructiveActions = new Set(["delete", "forget", "prune", "cleanup"]);
		if (!action || !destructiveActions.has(action)) return;
		if (input.confirm === true || input.force === true) return;
		return {
			block: true,
			reason: `Destructive action '${action}' requires confirm=true (or force=true to bypass reference checks).`,
		};
	});

	registerTeamTool(pi, { foregroundControllers, startForegroundRun, openLiveSidebar, getManifestCache, widgetState });
	registerSubagentTools(pi, subagentManager);
	time("register.tools");

	registerTeamCommands(pi, { startForegroundRun, openLiveSidebar, getManifestCache });
}
