/**
 * Lifecycle handler installer for pi-crew.
 *
 * Owns:
 *   • `session_start` — heavy setup (config, scheduler, render loop, watchers,
 *     deferred crash recovery). This is the bulk of the orchestrator's
 *     per-session work, extracted here so `register.ts` stays thin.
 *   • `session_shutdown` — reason-aware cleanup (quit/reload aborts
 *     foreground runs; resume/new/fork preserves them).
 *   • `session_before_switch` — graceful session switch handoff.
 *
 * Imports here are kept top-level (non-lazy) on purpose: this module IS
 * where the heavy work happens, so there is no cold-start benefit to
 * deferring it. The session_start handler internally uses lazy imports
 * for its own per-call optional work (foreground-watchdog, atomic-write).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { DEFAULT_UI } from "../../config/defaults.ts";
import { pruneFinishedRuns, pruneUserLevelRuns } from "../../extension/run-maintenance.ts";
import { reconcileAllStaleRuns } from "../../runtime/crash-recovery.ts";
import { listLiveAgents } from "../../runtime/live-agent-manager.ts";
import type { createManifestCache } from "../../runtime/manifest-cache.ts";
import { cleanupOrphanWorkers } from "../../runtime/orphan-worker-registry.ts";
import { cleanupLegacyOrphanTempDirs, cleanupOrphanTempDirs } from "../../runtime/pi-args.ts";
import { CrewScheduler, type ScheduledJob } from "../../runtime/scheduler.ts";
import { tryRegisterSessionCleanup } from "../../runtime/session-resources.ts";
import { createSessionSnapshot } from "../../runtime/session-snapshot.ts";
import { applyCrewSettingsToConfig, loadCrewSettings } from "../../runtime/settings-store.ts";
import { loadRunManifestById } from "../../state/state-store.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { terminateActiveChildPiProcesses } from "../../subagents/spawn.ts";
import { summarizeHeartbeats } from "../../ui/heartbeat-aggregator.ts";
import { requestRender, setExtensionWidget } from "../../ui/pi-ui-compat.ts";
import {
	registerPiCrewPowerbarSegments,
	requestPowerbarUpdate,
	resetPowerbarDedupState,
	updatePiCrewPowerbar,
} from "../../ui/powerbar-publisher.ts";
import { RenderScheduler } from "../../ui/render-scheduler.ts";
import { runEventBus } from "../../ui/run-event-bus.ts";
import type { createRunSnapshotCache } from "../../ui/run-snapshot-cache.ts";
import { updateCrewWidget } from "../../ui/widget/index.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../../utils/paths.ts";
import { RunWatcherRegistry } from "../../utils/run-watcher-registry.ts";
import { extractSessionId } from "../../utils/session-utils.ts";
import { startAsyncRunNotifier, stopAsyncRunNotifier } from "../async-notifier.ts";
import { registerCrewAutocomplete } from "../crew-autocomplete.ts";
import { notifyActiveRuns } from "../session-summary.ts";
import { persistScheduledJobUpdate } from "../team-tool/handle-schedule.ts";
import { handleTeamTool } from "../team-tool.ts";
import { runArtifactCleanup } from "./artifact-cleanup.ts";
import type { RegistrationContext } from "./registration-types.ts";

/**
 * Register all session-lifecycle handlers on the ExtensionAPI. The caller
 * (`register.ts`) must have already wired the orchestrator-side cleanup
 * functions into `ctx.cleanupRuntime` and `ctx.cleanupSessionResourcesOnly`.
 */
export function installSessionLifecycleHandlers(pi: ExtensionAPI, ctx: RegistrationContext): void {
	installSessionShutdownHandler(pi, ctx);
	installSessionStartHandler(pi, ctx);
	installSessionBeforeSwitchHandler(pi, ctx);
}

/**
 * session_shutdown:
 *   • reason="quit" / "reload" → full cleanup (abort foreground runs).
 *   • reason="resume" / "new" / "fork" → resource cleanup only (preserve
 *     foreground runs; they share the process with the session).
 */
function installSessionShutdownHandler(pi: ExtensionAPI, ctx: RegistrationContext): void {
	pi.on("session_shutdown", (event) => {
		const reason = typeof event === "object" && event !== null && "reason" in event ? (event as { reason: string }).reason : undefined;
		if (reason === "quit" || reason === "reload") {
			// Actual shutdown — abort foreground runs and cleanup everything
			ctx.cleanupRuntime();
		} else {
			// Session switch (resume/new/fork) — cleanup resources but preserve foreground runs
			ctx.cleanupSessionResourcesOnly();
		}
	});
}

/**
 * session_before_switch:
 *   Bump generation, deactivate delivery coordinator, stop async notifier,
 *   abort session-bound subagents. Foreground team runs are NOT aborted here.
 */
function installSessionBeforeSwitchHandler(pi: ExtensionAPI, ctx: RegistrationContext): void {
	pi.on("session_before_switch", () => {
		ctx.sessionGeneration++;
		const pendingCount = ctx.lifecycleState.deliveryCoordinator?.getPendingCount() ?? 0;
		try {
			const activeRuns = ctx.currentCtx
				? ctx
						.getManifestCache(ctx.currentCtx.cwd)
						.list(50)
						.filter((run) => run.status === "running" || run.status === "queued" || run.status === "blocked")
				: [];
			const snapshot = createSessionSnapshot(activeRuns, pendingCount, ctx.sessionGeneration);
			if (pendingCount > 0 || snapshot.activeRunIds.length > 0)
				logInternalError("register.session-before-switch", undefined, JSON.stringify(snapshot));
		} catch (error) {
			logInternalError("register.session-before-switch.snapshot", error);
		}
		if (pendingCount > 0) {
			logInternalError("register.session-before-switch", `Switching session with ${pendingCount} pending deliveries`);
		}
		ctx.lifecycleState.deliveryCoordinator?.deactivate();
		resetPowerbarDedupState();
		stopAsyncRunNotifier(ctx.notifierState);
		ctx.stopSessionBoundSubagents();
	});
}

/**
 * session_start — the bulk of pi-crew's per-session work.
 *
 * Pipeline:
 *   1. Resolve session metadata + restore brief mode (best-effort).
 *   2. Bump generation, set currentCtx, register autocomplete (once).
 *   3. Schedule deferred crash recovery (orphan cleanup, stale-reconcile,
 *      auto-prune). MUST run in setTimeout(0) — these block 100ms-1s on
 *      Windows and cannot stall the session_start event.
 *   4. Synchronously: load config + crew settings, start CrewScheduler,
 *      configure notifications/observability/delivery-coordinator,
 *      register Pi-side powerbar segments, start async notifier,
 *      kick off the render scheduler + preload loop + bounded watchers.
 */
function installSessionStartHandler(pi: ExtensionAPI, ctx: RegistrationContext): void {
	pi.on("session_start", (_event, extensionCtx) => {
		runArtifactCleanup(extensionCtx.cwd);

		// Restore brief mode state from session entries (best-effort).
		try {
			const entries = extensionCtx.sessionManager?.getEntries?.();
			if (entries) {
				// LAZY: brief-mode is only used inside the session-start restore path.
				import("../../ui/tool-renderers/brief-mode.ts")
					.then(({ restoreBriefState }) => {
						restoreBriefState(entries);
					})
					.catch(() => {
						/* non-critical */
					});
			}
		} catch {
			/* non-critical */
		}

		ctx.cleanedUp = false;
		ctx.sessionGeneration++;
		const ownerGeneration = ctx.sessionGeneration;
		ctx.currentCtx = extensionCtx;
		// Round 13 UX: register the crew natural-language autocomplete provider
		// once we have a UI context. Guarded so repeated session_start events
		// don't stack wrappers (each wrapper delegates, but stacking wastes
		// call depth).
		if (!ctx.crewAutocompleteRegistered) {
			ctx.crewAutocompleteRegistered = true;
			registerCrewAutocomplete(extensionCtx);
		}
		if (ctx.widgetState.interval) clearInterval(ctx.widgetState.interval);
		ctx.widgetState.interval = undefined;
		notifyActiveRuns(extensionCtx);

		const currentSessionId = extractSessionId(extensionCtx);

		// Defer ALL heavy cleanup to after the session_start handler returns.
		// These operations involve synchronous directory scanning (readdirSync, readFileSync)
		// which can take 100ms–1s+ on Windows. They MUST NOT block the session_start event.
		setTimeout(() => {
			void runDeferredSessionCleanup(pi, ctx, ownerGeneration, currentSessionId, extensionCtx);
		}, 0);

		const loadedConfig = loadConfig(extensionCtx.cwd);
		const crewSettings = loadCrewSettings(extensionCtx.cwd);
		applyCrewSettingsToConfig(loadedConfig.config, crewSettings);

		// Start scheduler with event-based executor
		const sessionId =
			extensionCtx.sessionManager?.getSessionId?.() ??
			(typeof extensionCtx === "object" && extensionCtx !== null && "sessionId" in extensionCtx
				? (extensionCtx as Record<string, unknown>).sessionId
				: undefined);
		ctx.crewScheduler = setupCrewScheduler(pi, ctx, extensionCtx, sessionId);

		// Wire scheduler into handle-schedule.ts so handlers can add/list jobs.
		// Uses a global symbol so the module doesn't need a direct circular import.
		(globalThis as Record<symbol | string, unknown>)[Symbol.for("pi-crew:scheduler")] = ctx.crewScheduler;
		// Load scheduled jobs from settings if present
		if (Array.isArray(crewSettings.scheduledJobs)) {
			for (const job of crewSettings.scheduledJobs) {
				try {
					ctx.crewScheduler.add(job as ScheduledJob);
				} catch {
					/* skip invalid */
				}
			}
		}
		ctx.autoRecoveryLast.clear();
		ctx.configureNotifications(extensionCtx);
		ctx.configureObservability(extensionCtx);
		ctx.configureDeliveryCoordinator();
		if (typeof sessionId === "string" && sessionId) ctx.lifecycleState.deliveryCoordinator?.activate(sessionId);
		tryRegisterSessionCleanup(pi, () => {
			terminateActiveChildPiProcesses();
			ctx.cleanupRuntime();
		});
		registerPiCrewPowerbarSegments(pi.events, loadedConfig.config.ui);
		startAsyncRunNotifier(extensionCtx, ctx.notifierState, loadedConfig.config.notifierIntervalMs ?? DEFAULT_UI.notifierIntervalMs, {
			generation: ownerGeneration,
			isCurrent: (generation) => generation === ctx.sessionGeneration && ctx.currentCtx === extensionCtx && !ctx.cleanedUp,
		});
		const cache = ctx.getManifestCache(extensionCtx.cwd);
		updateCrewWidget(extensionCtx, ctx.widgetState, loadedConfig.config.ui, cache, ctx.getRunSnapshotCache(extensionCtx.cwd));
		updatePiCrewPowerbar(
			pi.events,
			extensionCtx.cwd,
			loadedConfig.config.ui,
			cache,
			ctx.getRunSnapshotCache(extensionCtx.cwd),
			extensionCtx,
			ctx.widgetState.notificationCount ?? 0,
		);
		setupRenderLoop(pi, ctx, extensionCtx, loadedConfig);
	});
}

/**
 * Heavy cleanup that runs after session_start returns.
 *
 * Wrapped in setTimeout(0) so the session_start event is not blocked by
 * the synchronous I/O involved (readdirSync, readFileSync) — observed to
 * take 100ms-1s+ on Windows with many runs on disk.
 */
async function runDeferredSessionCleanup(
	pi: ExtensionAPI,
	ctx: RegistrationContext,
	ownerGeneration: number,
	currentSessionId: string | undefined,
	extensionCtx: ExtensionContext,
): Promise<void> {
	if (ctx.cleanedUp || ctx.sessionGeneration !== ownerGeneration) return; // session switched while we waited

	// 2.7: load crash-recovery lazily once per session_start cleanup batch.
	let crashRecovery: Awaited<ReturnType<typeof ctx.importCrashRecovery>> | undefined;
	try {
		crashRecovery = await ctx.importCrashRecovery();
	} catch (error) {
		logInternalError("register.sessionStart.lazyCrashRecovery", error);
		return;
	}
	if (ctx.cleanedUp || ctx.sessionGeneration !== ownerGeneration) return;
	const { cancelOrphanedRuns: cancelOrphanedRunsFn, purgeStaleActiveRunIndex: purgeStaleActiveRunIndexFn } = crashRecovery;

	// Auto-cancel orphaned runs
	if (currentSessionId) {
		try {
			const { cancelled } = (
				cancelOrphanedRunsFn as (
					cwd: string,
					cache: ReturnType<typeof createManifestCache>,
					sessionId: string,
				) => { cancelled: string[] }
			)(extensionCtx.cwd, ctx.getManifestCache(extensionCtx.cwd), currentSessionId);
			if (cancelled.length > 0) {
				ctx.notifyOperator({
					id: `orphan_cleanup`,
					severity: "info",
					source: "crash-recovery",
					title: `Cleaned up ${cancelled.length} orphaned run(s)`,
					body: `Runs from previous sessions were auto-cancelled: ${cancelled.join(", ")}`,
				});
			}
		} catch (error) {
			logInternalError("register.sessionStart.orphanCleanup", error);
		}
	}

	// Startup cleanup (Fix A): run orphan-temp-dir cleanup
	try {
		const orphanTmp = cleanupOrphanTempDirs();
		const legacyTmp = cleanupLegacyOrphanTempDirs();
		if (orphanTmp.cleaned > 0 || legacyTmp.cleaned > 0) {
			ctx.notifyOperator({
				id: `startup_temp_cleanup_${Date.now()}`,
				severity: "info",
				source: "temp-cleanup",
				title: `Startup cleanup: removed ${orphanTmp.cleaned + legacyTmp.cleaned} orphan temp dir(s)`,
				body: `${orphanTmp.cleaned} from ~/.pi/agent/pi-crew/tmp/ + ${legacyTmp.cleaned} legacy /tmp/pi-crew-*`,
			});
		}
	} catch (error) {
		logInternalError("register.sessionStart.startupTempCleanup", error);
	}

	// Orphan worker cleanup (Fix B): kill stale background-runner processes
	try {
		const orphanWorkers = cleanupOrphanWorkers(currentSessionId);
		if (orphanWorkers.killed > 0) {
			ctx.notifyOperator({
				id: `orphan_workers_cleanup`,
				severity: "info",
				source: "worker-cleanup",
				title: `Cleaned up ${orphanWorkers.killed} orphan worker(s)`,
				body: `Background workers from previous (SIGKILL'd) sessions were terminated (pruned ${orphanWorkers.pruned} dead, kept ${orphanWorkers.kept}).`,
			});
		}
	} catch (error) {
		logInternalError("register.sessionStart.orphanWorkers", error);
	}

	// Global purge of stale active-run-index entries
	try {
		const { purged } = purgeStaleActiveRunIndexFn();
		if (purged.length > 0) {
			ctx.notifyOperator({
				id: `active_index_purge`,
				severity: "info",
				source: "crash-recovery",
				title: `Purged ${purged.length} stale active-run-index entr${purged.length === 1 ? "y" : "ies"}`,
				body: `Cleaned up global active run index`,
			});
		}
	} catch (error) {
		logInternalError("register.sessionStart.globalIndexPurge", error);
	}

	// Reconcile stale runs found on disk
	try {
		const staleResults = reconcileAllStaleRuns(extensionCtx.cwd, ctx.getManifestCache(extensionCtx.cwd)) ?? [];
		if (staleResults.length > 0) {
			ctx.notifyOperator({
				id: "stale_reconcile",
				severity: "info",
				source: "crash-recovery",
				title: `Reconciled ${staleResults.length} stale run(s)`,
				body: `Found and repaired ghost runs from previous sessions: ${staleResults.map((r) => r.runId).join(", ")}`,
			});
		}
	} catch (error) {
		logInternalError("register.sessionStart.reconcileStale", error);
	}

	// Auto-prune finished project-level run directories
	try {
		const { removed } = pruneFinishedRuns(extensionCtx.cwd, 10);
		if (removed.length > 0) {
			ctx.notifyOperator({
				id: `auto_prune_project`,
				severity: "info",
				source: "run-maintenance",
				title: `Auto-pruned ${removed.length} finished project run(s)`,
				body: `Removed old finished runs: ${removed.join(", ")}`,
			});
		}
	} catch (error) {
		logInternalError("register.sessionStart.autoPruneProject", error);
	}

	// Auto-prune finished user-level run directories
	try {
		const { removed } = pruneUserLevelRuns(10);
		if (removed.length > 0) {
			ctx.notifyOperator({
				id: `auto_prune_user`,
				severity: "info",
				source: "run-maintenance",
				title: `Auto-pruned ${removed.length} finished user-level run(s)`,
				body: `Removed old finished runs: ${removed.join(", ")}`,
			});
		}
	} catch (error) {
		logInternalError("register.sessionStart.autoPruneUser", error);
	}
}

/**
 * Build a CrewScheduler wired to the current session. The scheduler's
 * executor closure invokes handleTeamTool lazily — the heavy team-tool
 * import only fires when a scheduled job actually runs.
 */
function setupCrewScheduler(
	pi: ExtensionAPI,
	ctx: RegistrationContext,
	extensionCtx: ExtensionContext,
	sessionId: string | undefined,
): CrewScheduler {
	const crewScheduler = new CrewScheduler();
	crewScheduler.start({
		emit: (event) => {
			if (ctx.cleanedUp) return;
			pi.events?.emit?.("crew-scheduler", event);
		},
		executor: (job) => {
			let runParams: { action: string; team: string; goal: string };
			try {
				runParams = JSON.parse(job.prompt);
			} catch {
				runParams = {
					action: "run",
					team: "default",
					goal: job.prompt,
				};
			}
			if (runParams.action !== "run") return `scheduled-${job.id}-${Date.now()}`;
			const agentId = `scheduled-${job.id}-${Date.now()}`;
			setImmediate(async () => {
				try {
					const runResult = await handleTeamTool(
						{
							action: "run",
							team: runParams.team,
							goal: runParams.goal,
							async: true,
						},
						{ cwd: extensionCtx.cwd, sessionId },
					);
					const runId = runResult?.details?.runId;
					if (runId && typeof runId === "string") {
						crewScheduler?.recordSpawnedRun(job.id, runId);
						// Update run manifest with scheduler provenance for traceability
						try {
							const cwd = extensionCtx.cwd ?? process.cwd();
							const loaded = loadRunManifestById(cwd, runId);
							if (loaded) {
								// LAZY: defer dynamic import of atomic-write.ts to its call site.
								const { atomicWriteJson } = await import("../../state/atomic-write.ts");
								atomicWriteJson(loaded.manifest.stateRoot + "/manifest.json", {
									...loaded.manifest,
									schedulerJobId: job.id,
									schedulerName: job.name,
								});
							}
						} catch {
							/* best-effort provenance tracking */
						}
					}
					try {
						const updatedJob = crewScheduler?.list().find((j) => j.id === job.id);
						if (updatedJob) persistScheduledJobUpdate(extensionCtx.cwd, updatedJob);
					} catch {
						/* best-effort */
					}
					crewScheduler?.update(job.id, {
						runCount: job.runCount + 1,
						lastRun: new Date().toISOString(),
						lastStatus: "success",
					});
				} catch (err) {
					logInternalError("scheduler.execute", err);
					crewScheduler?.update(job.id, { lastStatus: "error" });
				}
			});
			return agentId;
		},
		finalizer: () => {},
		runCancelFn: (runId: string) => {
			try {
				handleTeamTool({ action: "cancel", runId, confirm: true }, { cwd: extensionCtx.cwd, sessionId }).catch((err) =>
					logInternalError("scheduler.runCancelFn", err, `runId=${runId}`),
				);
			} catch (err) {
				logInternalError("scheduler.runCancelFn.sync", err, `runId=${runId}`);
			}
		},
	});
	return crewScheduler;
}

/**
 * Build the render scheduler + preload loop + bounded run watchers.
 *
 * Render path:
 *   - RenderScheduler fires renderTick() every `effectiveRefreshMs()`.
 *   - 160ms when live agents OR background runs are active (spinner-friendly),
 *     else the configured `dashboardLiveRefreshMs` (default DEFAULT_UI.refreshMs).
 *   - renderTick reads from a pre-computed frame (`lastPreloadedManifests`) —
 *     zero fs I/O on the hot path.
 *
 * Watchers:
 *   - pts/2 hang fix (2026-06-16): a SINGLE non-recursive watcher on the
 *     `runs/` root (new-run detection) plus per-active-run watchers
 *     reconciled each preload tick. Total inotify cost: O(active runs).
 */
function setupRenderLoop(
	pi: ExtensionAPI,
	ctx: RegistrationContext,
	extensionCtx: ExtensionContext,
	loadedConfig: ReturnType<typeof loadConfig>,
): void {
	ctx.disposeRenderSchedulerSubscriptions();
	ctx.renderScheduler?.dispose();
	ctx.terminalStatus?.dispose();
	ctx.terminalStatus = undefined;
	ctx.terminalStatusActive = false;

	// Phase 12: Async preloading — renderTick reads only a pre-computed frame.
	let preloading = false;
	let lastPreloadedConfig: ReturnType<typeof loadConfig> | undefined;
	let lastPreloadedManifests: TeamRunManifest[] = [];
	let lastFrameManifestCache: ReturnType<typeof createManifestCache> | undefined;
	let lastFrameSnapshotCache: ReturnType<typeof createRunSnapshotCache> | undefined;

	const ownerGeneration = ctx.sessionGeneration;

	const buildFrame = async (): Promise<boolean> => {
		if (!ctx.currentCtx) return false;
		lastPreloadedConfig = loadConfig(ctx.currentCtx.cwd);
		lastFrameManifestCache = ctx.getManifestCache(ctx.currentCtx.cwd);
		lastFrameSnapshotCache = ctx.getRunSnapshotCache(ctx.currentCtx.cwd);
		const manifests = lastFrameManifestCache.list(20);
		lastPreloadedManifests = manifests;
		// pts/2 hang fix: reconcile per-run watchers against the ACTIVE set only.
		{
			const onRunChange = (runId: string): void => {
				if (ctx.cleanedUp || ctx.sessionGeneration !== ownerGeneration) return;
				// FLICKER FIX: rebuild-in-place instead of deleting the entry. The
				// file just changed on disk, so force a fresh snapshot while keeping
				// the entry populated — deleting it left a window where the widget's
				// `get()` returned undefined and dropped the run to "(loading…)".
				try {
					ctx.getRunSnapshotCache(ctx.currentCtx?.cwd ?? process.cwd()).refresh(runId);
				} catch (error) {
					logInternalError("register.runWatcher.refresh", error, runId);
				}
				ctx.renderScheduler?.schedule({ runId });
			};
			const onWatchErr = (error: unknown): void => {
				logInternalError("register.runWatcher.change", error);
			};
			const active = manifests
				.filter((r) => r.status === "running" || r.status === "queued" || r.status === "planning")
				.map((r) => ({ runId: r.runId, runDir: r.stateRoot }));
			ctx.crewRunWatchers?.reconcile(active, onRunChange, onWatchErr);
			ctx.userCrewWatchers?.reconcile(active, onRunChange, onWatchErr);
		}
		const runIds = manifests.map((r) => r.runId);
		await lastFrameSnapshotCache.preloadAllStale(runIds);
		return true;
	};

	const backgroundPreload = (): void => {
		if (!ctx.currentCtx || preloading) return;
		preloading = true;
		buildFrame()
			.then((ok) => {
				preloading = false;
				if (ok) ctx.renderScheduler?.schedule();
			})
			.catch((error: unknown) => {
				preloading = false;
				logInternalError("register.backgroundPreload", error);
			});
	};

	const startPreloadLoop = (intervalMs: number, dynamicMs?: () => number): void => {
		if (ctx.preloadTimer) clearTimeout(ctx.preloadTimer);
		const tick = (): void => {
			backgroundPreload();
			const nextMs = dynamicMs?.() ?? intervalMs;
			ctx.preloadTimer = setTimeout(tick, nextMs);
			ctx.preloadTimer.unref();
		};
		ctx.preloadTimer = setTimeout(tick, intervalMs);
		ctx.preloadTimer.unref();
	};

	const renderTick = (): void => {
		if (!ctx.currentCtx) return;
		const config = lastPreloadedConfig?.config.ui;
		const activeCache = lastFrameManifestCache ?? ctx.getManifestCache(ctx.currentCtx.cwd);
		const snapshotCache = lastFrameSnapshotCache ?? ctx.getRunSnapshotCache(ctx.currentCtx.cwd);
		const manifests = lastPreloadedManifests;
		if (!lastPreloadedConfig) backgroundPreload();
		if (ctx.uiState.liveSidebarRunId) {
			const placement = config?.widgetPlacement ?? DEFAULT_UI.widgetPlacement;
			if (ctx.widgetState.lastVisibility !== "hidden" || ctx.widgetState.lastPlacement !== placement) {
				setExtensionWidget(ctx.currentCtx, "pi-crew", undefined, { placement });
				setExtensionWidget(ctx.currentCtx, "pi-crew-active", undefined, { placement });
				ctx.widgetState.lastVisibility = "hidden";
				ctx.widgetState.lastPlacement = placement;
				ctx.widgetState.lastKey = "pi-crew-active";
				ctx.widgetState.model = undefined;
			}
			requestRender(ctx.currentCtx);
		} else {
			updateCrewWidget(ctx.currentCtx, ctx.widgetState, config, activeCache, snapshotCache, manifests);
		}
		requestPowerbarUpdate(
			pi.events,
			ctx.currentCtx.cwd,
			config,
			activeCache,
			snapshotCache,
			ctx.currentCtx,
			ctx.widgetState.notificationCount ?? 0,
			manifests,
		);
		// Health notifications: only warn about genuinely running runs.
		const currentSessionGen = ctx.sessionGeneration;
		const currentSessionId = ctx.currentCtx ? (ctx.currentCtx as { sessionId?: string }).sessionId : undefined;
		const sessionManifests = manifests.filter(
			(run) =>
				!run.ownerSessionId ||
				run.ownerSessionId === currentSessionId ||
				(run as unknown as Record<string, unknown>).ownerSessionGeneration === currentSessionGen,
		);
		const now = Date.now();
		for (const run of sessionManifests) {
			if (run.status !== "running") continue;
			try {
				const snapshot = snapshotCache.get(run.runId);
				if (!snapshot) continue;
				if (snapshot.manifest.status !== "running") continue;
				const summary = summarizeHeartbeats(snapshot, { now });
				const maybeNotifyHealth = (kind: string, count: number, title: string, body: string): void => {
					if (count <= 0) return;
					const key = `${kind}_${run.runId}`;
					const previous = ctx.autoRecoveryLast.get(key);
					if (previous !== undefined && now - previous.lastAccessAt < 5 * 60_000) return;
					// Defensive cap: evict entry with oldest lastAccessAt before inserting/updating.
					while (ctx.autoRecoveryLast.size >= ctx.AUTO_RECOVERY_LAST_MAX_ENTRIES) {
						let oldestKey: string | undefined;
						let oldestAccess = Infinity;
						for (const [k, v] of ctx.autoRecoveryLast) {
							if (v.lastAccessAt < oldestAccess) {
								oldestAccess = v.lastAccessAt;
								oldestKey = k;
							}
						}
						if (oldestKey === undefined) break;
						ctx.autoRecoveryLast.delete(oldestKey);
					}
					ctx.autoRecoveryLast.set(key, {
						insertedAt: now,
						lastAccessAt: now,
					});
					ctx.notifyOperator({
						id: key,
						severity: "warning",
						source: "health",
						runId: run.runId,
						title,
						body,
					});
				};
				maybeNotifyHealth(
					"recovery_dead_workers",
					summary.dead,
					`Run ${run.runId} has ${summary.dead} dead worker(s).`,
					"Open /team-dashboard → 5 health → R recovery / K kill stale / D diagnostic.",
				);
				maybeNotifyHealth(
					"recovery_missing_heartbeat",
					summary.missing,
					`Run ${run.runId} has ${summary.missing} worker(s) missing heartbeat.`,
					"Open /team-dashboard → 5 health → inspect health actions.",
				);
			} catch (error) {
				logInternalError("register.health-notification", error, run.runId);
			}
		}
	};

	const fallbackMs = loadedConfig.config.ui?.dashboardLiveRefreshMs ?? DEFAULT_UI.refreshMs;
	const liveRefreshMs = 160;
	const hasActiveWork = (): boolean => {
		if (listLiveAgents().some((a) => a.status === "running")) return true;
		return lastPreloadedManifests.some((r) => r.status === "running" || r.status === "queued" || r.status === "planning");
	};
	const effectiveRefreshMs = () => (hasActiveWork() ? liveRefreshMs : fallbackMs);
	ctx.renderScheduler = new RenderScheduler(pi.events, renderTick, {
		fallbackMs: effectiveRefreshMs,
		onInvalidate: (payload: unknown) => {
			const runId =
				typeof payload === "object" &&
				payload !== null &&
				"runId" in payload &&
				typeof (payload as { runId: unknown }).runId === "string"
					? (payload as { runId: string }).runId
					: undefined;
			// FLICKER FIX: never hard-delete snapshot entries from a render-scheduler
			// invalidate. A no-runId payload — emitted by EVERY fallback tick
			// (~every 160ms while a run is active) — previously ran
			// `invalidate(undefined)` → `entries.clear()`, wiping ALL snapshots.
			// The next `renderTick` then saw `get() === undefined` for every run,
			// so `activeWidgetRuns` dropped them to "(loading…)" until the async
			// preload rebuilt the cache — an endless visible flicker. For a
			// specific runId we now refresh-if-stale (stale-while-revalidate) so
			// the widget always sees a populated snapshot; a no-runId tick does
			// nothing (renderTick itself repaints; the cache's own
			// run:state/worker:lifecycle subscription refreshes affected runs).
			if (!runId) return;
			try {
				ctx.getRunSnapshotCache(extensionCtx.cwd).refreshIfStale(runId);
			} catch (error) {
				logInternalError("register.renderScheduler.refresh", error, runId);
			}
		},
	});
	// Fix D: bridge internal runEventBus events to renderScheduler so the UI
	// re-renders within debounceMs of any agent lifecycle event.
	const sched = ctx.renderScheduler;
	const unsubscribeRunEvents = runEventBus.onAny((event) => {
		sched.schedule({
			runId: event.runId,
			source: "runEventBus",
			type: event.type,
		});
	});
	ctx.renderSchedulerUnsubscribers.push(unsubscribeRunEvents);
	startPreloadLoop(fallbackMs, effectiveRefreshMs);

	// Bounded run watcher setup (pts/2 hang fix 2026-06-16).
	const crewRunWatcherOnChange = (runId: string): void => {
		if (ctx.cleanedUp || ctx.sessionGeneration !== ownerGeneration) return;
		// FLICKER FIX: rebuild-in-place instead of deleting the entry (see
		// onRunChange above). A hard delete left `get()` returning undefined for
		// a frame, dropping the run to "(loading…)" and causing visible flicker.
		try {
			ctx.getRunSnapshotCache(ctx.currentCtx?.cwd ?? process.cwd()).refresh(runId);
		} catch (error) {
			logInternalError("register.crewRunWatcher.refresh", error, runId);
		}
		ctx.renderScheduler?.schedule({ runId });
	};
	const crewRunWatcherOnError = (error: unknown): void => {
		logInternalError("register.crewRunWatchers.error", error);
	};
	try {
		ctx.crewRunWatchers?.closeAll();
		ctx.crewRunWatchers = undefined;
		const crewRunsDir = path.join(projectCrewRoot(extensionCtx.cwd), "state", "runs");
		if (fs.existsSync(crewRunsDir)) {
			ctx.crewRunWatchers = new RunWatcherRegistry();
			ctx.crewRunWatchers.setRootWatcher(crewRunsDir, crewRunWatcherOnChange, crewRunWatcherOnError);
		}
	} catch (error) {
		logInternalError("register.crewRunWatchers.start", error);
	}
	try {
		ctx.userCrewWatchers?.closeAll();
		ctx.userCrewWatchers = undefined;
		const userRunsDir = path.join(userCrewRoot(), "state", "runs");
		if (fs.existsSync(userRunsDir)) {
			ctx.userCrewWatchers = new RunWatcherRegistry();
			ctx.userCrewWatchers.setRootWatcher(userRunsDir, crewRunWatcherOnChange, crewRunWatcherOnError);
		}
	} catch (error) {
		logInternalError("register.userCrewWatchers.start", error);
	}
	// Kick an immediate preload so the first buildFrame reconciles per-run
	// watchers for any runs that are already active on session start.
	backgroundPreload();
}
