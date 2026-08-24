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
import { getCrewEnv } from "../../config/env-vars.ts";
import { pruneFinishedRuns, pruneUserLevelRuns } from "../../extension/run-maintenance.ts";
import { type BrokerSpawnCredentials, setActiveBrokerIssuer } from "../../runtime/broker/broker-issuer.ts";
import { CrewBroker } from "../../runtime/broker/crew-broker.ts";
import { terminateActiveChildPiProcesses } from "../../runtime/child-pi/child-pi.ts";
import { forgetDetachedRun, hasDetachedRuns, peekFinishedDetachedRunResults } from "../../runtime/detached-run-results.ts";
import { listLiveAgents } from "../../runtime/live-session/live-agent-manager.ts";
import type { createManifestCache } from "../../runtime/manifest-cache.ts";
import { configuredModelInfosFromPiConfig } from "../../runtime/model/model-fallback.ts";
import { cleanupLegacyOrphanTempDirs, cleanupOrphanTempDirs, currentCrewDepth, resolveCrewMaxDepth } from "../../runtime/model/pi-args.ts";
import { clearProviderQuotaCache, noteProviderResponse } from "../../runtime/model/provider-quota.ts";
import { noteSessionModel, noteSessionThinking, resolveProviderForResponse } from "../../runtime/model/session-model.ts";
import { cleanupOrphanWorkers } from "../../runtime/orphan-worker-registry.ts";
import { reconcileAllStaleRuns } from "../../runtime/recovery/crash-recovery.ts";
import { CrewScheduler, type ScheduledJob } from "../../runtime/scheduling/scheduler.ts";
import { tryRegisterSessionCleanup } from "../../runtime/session-resources.ts";
import { createSessionSnapshot } from "../../runtime/session-snapshot.ts";
import { applyCrewSettingsTiersToConfig, loadCrewSettingsTiers } from "../../runtime/settings-store.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { summarizeHeartbeats } from "../../ui/heartbeat-aggregator.ts";
import { installInlinePanel } from "../../ui/inline-panel/index.ts";
import { clearSessionSwitchInFlight, markSessionSwitchInFlight } from "../../ui/inline-panel/view-session-store.ts";
import { requestRender, setExtensionWidget, toPiWidgetPlacement } from "../../ui/pi-ui-compat.ts";
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
import { extractBrokerSessionId } from "../../utils/session-utils.ts";
import { getBrokerSocketPath } from "../../utils/socket-path.ts";
import { startAsyncRunNotifier, stopAsyncRunNotifier } from "../async-notifier.ts";
import { registerCrewAutocomplete } from "../crew-autocomplete.ts";
import { notifyActiveRuns } from "../session-summary.ts";
import { persistScheduledJobUpdate, registerCrewScheduler } from "../team-tool/handle-schedule.ts";
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
	installModelTrackingHandlers(pi);
}

/**
 * Hand over the outcome of runs detached by an agent-view switch.
 *
 * Delivered as a DISPLAYED session entry (not a follow-up queue item): an idle
 * session never flushes a follow-up, so the queued variant left the result
 * invisible. Each result is dropped from the registry only after its send
 * succeeded, and only while the owning session is current — a worker's view
 * session must never receive the parent run's report.
 */
function deliverDetachedRunResults(pi: ExtensionAPI, extensionCtx: ExtensionContext): void {
	if (!hasDetachedRuns()) return;
	try {
		// Agent views are in-document panes now, never sessions: the current
		// session is always the main one, so detached results always deliver.
		const inViewSession = false;
		for (const { runId, text } of peekFinishedDetachedRunResults({ inViewSession })) {
			pi.sendMessage({ customType: "pi-crew-run-result", content: text, display: true });
			forgetDetachedRun(runId);
			try {
				extensionCtx.ui.notify(text.split("\n")[0] ?? `pi-crew run finished: ${runId}`, "info");
			} catch {
				/* toast is secondary to the session entry */
			}
		}
	} catch (error) {
		// Keep the entry: the next tick retries rather than losing the outcome.
		logInternalError("register.detachedRunResults", error);
	}
}

/**
 * model_select / thinking_level_select:
 *   Track what the MAIN session is *actually* running so subagents that
 *   inherit the parent model (`model: false` — every builtin agent) follow it.
 *   `ctx.model` alone is the session's saved model and can point at whatever a
 *   previous session persisted, which made inherited models jump around.
 */
function installModelTrackingHandlers(pi: ExtensionAPI): void {
	pi.on("model_select", (event) => {
		noteSessionModel(event.model);
	});
	pi.on("thinking_level_select", (event) => {
		noteSessionThinking(event.level);
	});
	// Quota-aware routing: capture rate-limit headers from the main session's
	// provider responses so the fallback chain can deprioritize exhausted
	// providers. The event doesn't carry a provider field, so we attribute it
	// to the currently tracked session model's provider.
	pi.on("after_provider_response", (event) => {
		const provider = resolveProviderForResponse();
		if (provider) noteProviderResponse(provider, event.status, event.headers);
	});
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
		// The switch tears the current turn down right after this handler
		// (teardownCurrent → session.abort()). That turn-abort must NOT cancel
		// a foreground team run that is still forming (see run-deadline.ts):
		// foreground runs survive session switches (P0). Cleared on the next
		// session_start.
		markSessionSwitchInFlight();
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
		clearProviderQuotaCache();
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
		// Any session start means a pending switch landed — the turn-abort
		// suppression window for that switch is over.
		clearSessionSwitchInFlight();
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
		// Seed the live-model tracker; a later model_select overrides it.
		noteSessionModel(extensionCtx.model, "session_start");
		noteSessionThinking(extensionCtx.thinkingLevel);
		// Round 13 UX: register the crew natural-language autocomplete provider
		// once we have a UI context. Guarded so repeated session_start events
		// don't stack wrappers (each wrapper delegates, but stacking wastes
		// call depth).
		if (!ctx.crewAutocompleteRegistered) {
			ctx.crewAutocompleteRegistered = true;
			registerCrewAutocomplete(extensionCtx);
		}
		notifyActiveRuns(extensionCtx);

		const currentSessionId = extractBrokerSessionId(extensionCtx);
		// Phase 0 broker: feed the captured session_id to the controller so
		// it can issue tokens for child runs in this session. The controller
		// already gates by flag + root-session; this is a no-op when disabled.
		ctx.brokerController?.setSessionId(currentSessionId);

		// Defer ALL heavy cleanup to after the session_start handler returns.
		// These operations involve synchronous directory scanning (readdirSync, readFileSync)
		// which can take 100ms–1s+ on Windows. They MUST NOT block the session_start event.
		setTimeout(() => {
			void runDeferredSessionCleanup(pi, ctx, ownerGeneration, currentSessionId, extensionCtx);
		}, 0);

		const loadedConfig = loadConfig(extensionCtx.cwd);
		// Wave 2B (P1 security): crew settings load as TIERS — the project-tier
		// <cwd>/.pi/crew-settings.json is untrusted (a cloned repo can ship it)
		// and now goes through sanitizeProjectConfig + tighten-only guard
		// tiering instead of being applied raw over the sanitized config (the
		// pre-2B `loadCrewSettings` + `applyCrewSettingsToConfig` bypass).
		// See src/runtime/settings-store.ts for the tier pipeline + the
		// scheduledJobs/schedulingEnabled boundary decision.
		const crewSettingsTiers = loadCrewSettingsTiers(extensionCtx.cwd);
		const settingsWarnings = applyCrewSettingsTiersToConfig(loadedConfig.config, crewSettingsTiers);
		if (settingsWarnings.length > 0) {
			(loadedConfig.warnings ??= []).push(...settingsWarnings);
		}

		// Start scheduler with event-based executor
		const sessionId =
			extensionCtx.sessionManager?.getSessionId?.() ??
			(typeof extensionCtx === "object" && extensionCtx !== null && "sessionId" in extensionCtx
				? (extensionCtx as Record<string, unknown>).sessionId
				: undefined);
		ctx.crewScheduler = setupCrewScheduler(pi, ctx, extensionCtx, sessionId);

		// Wire scheduler into handle-schedule.ts so handlers can add/list jobs.
		// EXT-9: module-scoped setter (was globalThis[Symbol.for(...)]).
		registerCrewScheduler(ctx.crewScheduler);
		// Load scheduled jobs from settings if present.
		// BOUNDARY (Wave B2): project-tier scheduledJobs are OPT-IN GATED — the
		// registration loop reads the gated `effectiveScheduledJobs` view (user
		// jobs always; project jobs ONLY when the user-tier global file has BOTH
		// schedulingEnabled:true AND allowProjectScheduledJobs:true).
		// <cwd>/.pi/crew-settings.json remains the persistence store for the
		// user's own `crew schedule add/update/remove` commands (handle-schedule.ts),
		// so crew-schedule users must set both flags in ~/.pi/crew-settings.json.
		// `schedulingEnabled` is user-tier-only (project values always dropped).
		for (const job of crewSettingsTiers.effectiveScheduledJobs) {
			try {
				ctx.crewScheduler.add(job as ScheduledJob);
			} catch {
				/* skip invalid */
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
		// Inline agent panel: keyboard-navigable rows under the prompt + per-agent
		// transcript pane. Installed after the widget so the row projection sees
		// the same caches the widget paint uses.
		installInlinePanel(pi, extensionCtx, loadedConfig.config.ui);
		// Returning from an agent view lands here: report any detached run that
		// finished while the view was open, without waiting for a render tick.
		deliverDetachedRunResults(pi, extensionCtx);
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
		const { purged } = purgeStaleActiveRunIndexFn(300_000, Date.now(), currentSessionId);
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
		const staleResults =
			reconcileAllStaleRuns(extensionCtx.cwd, ctx.getManifestCache(extensionCtx.cwd), Date.now(), currentSessionId) ?? [];
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
		finalizer: () => undefined,
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
/**
 * Phase 5 (Vector #3): keep only the CURRENT session's owned runs (plus
 * ownerless runs) for health notifications. Previously the inline filter derived
 * `currentSessionId` from a cast that was always `undefined` and compared
 * against `ownerSessionGeneration` (a field absent from TeamRunManifest), so
 * together they dropped EVERY owned run. Exported for unit testing.
 */
export function filterManifestsForHealthNotifications(
	manifests: TeamRunManifest[],
	currentSessionId: string | undefined,
): TeamRunManifest[] {
	return manifests.filter((run) => !run.ownerSessionId || run.ownerSessionId === currentSessionId);
}

/**
 * bug-026 sub-issue C: runEventBus event types that mark a run TERMINAL,
 * across BOTH type namespaces seen on the bus — dotted `run.*` strings (kept
 * for parity with classifyEventChannel's WORKER_LIFECYCLE_TYPES, see
 * src/ui/run-event-bus.ts:31-44) and underscore `run_*` (the native
 * RunEventType namespace actually emitted by team-runner, e.g.
 * `run_completed`). Exported for unit testing.
 */
export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
	"run.completed",
	"run.failed",
	"run.cancelled",
	"run_completed",
	"run_failed",
	"run_cancelled",
]);

/** True when a runEventBus event type marks the run terminal (either namespace). */
export function isTerminalRunEventType(type: string): boolean {
	return TERMINAL_RUN_EVENT_TYPES.has(type);
}

/** Pure filter: drop `runId` from a preloaded-manifest frame (bug-026 sub-issue C eviction). */
export function evictRunFromManifests(manifests: TeamRunManifest[], runId: string): TeamRunManifest[] {
	return manifests.filter((m) => m.runId !== runId);
}

/**
 * Apply a runEventBus payload to a preloaded-manifest frame: evict the run on
 * terminal events, pass through unchanged otherwise. This is the exact logic
 * wired into the setupRenderLoop `runEventBus.onAny` subscription (bug-026
 * sub-issue C); exported so tests can exercise it end-to-end against the
 * real bus without spinning up the full render loop.
 */
export function applyTerminalRunEventToManifests(manifests: TeamRunManifest[], event: { type: string; runId: string }): TeamRunManifest[] {
	return isTerminalRunEventType(event.type) ? evictRunFromManifests(manifests, event.runId) : manifests;
}

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
				// PERF (2026-08-24): route through the coalesced ASYNC refresh —
				// fs.watch can fire many times per second and the sync rebuild
				// blocked the UI event loop. The entry stays populated until the
				// async rebuild re-sets it in place; the render schedule below
				// repaints while it lands.
				try {
					ctx.getRunSnapshotCache(ctx.currentCtx?.cwd ?? process.cwd()).scheduleRefresh(runId);
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
		deliverDetachedRunResults(pi, ctx.currentCtx);
		const config = lastPreloadedConfig?.config.ui;
		const activeCache = lastFrameManifestCache ?? ctx.getManifestCache(ctx.currentCtx.cwd);
		const snapshotCache = lastFrameSnapshotCache ?? ctx.getRunSnapshotCache(ctx.currentCtx.cwd);
		const manifests = lastPreloadedManifests;
		if (!lastPreloadedConfig) backgroundPreload();
		if (ctx.uiState.liveSidebarRunId || ctx.uiState.dashboardOpen) {
			const placement = toPiWidgetPlacement(config?.widgetPlacement ?? DEFAULT_UI.widgetPlacement);
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
		// Phase 5 (Vector #3): derive currentSessionId via the working accessor.
		// ctx is RegistrationContext; currentCtx holds the ExtensionContext whose
		// sessionManager exposes getSessionId(). The previous cast to {sessionId?}
		// was always undefined, and the ownerSessionGeneration clause referenced a
		// field absent from TeamRunManifest — together they dropped EVERY owned
		// run. Now only the current session's owned runs + ownerless runs pass.
		const currentSessionId = ctx.currentCtx?.sessionManager?.getSessionId();
		const sessionManifests = filterManifestsForHealthNotifications(manifests, currentSessionId);
		const now = Date.now();
		// FIX #2: clear path — when a run is detected terminal, dismiss any
		// previously-emitted health notification for it AND drop its cooldown
		// (autoRecoveryLast) so a future genuine re-occurrence can re-notify.
		// Keeps the dashboard clean and stops the 5-min re-fire cycle.
		const clearHealthNotifications = (runId: string): void => {
			for (const kind of ["recovery_dead_workers", "recovery_missing_heartbeat"]) {
				const key = `${kind}_${runId}`;
				ctx.autoRecoveryLast.delete(key);
				ctx.notifyOperator({
					id: key,
					clear: true,
					severity: "info",
					source: "health",
					runId,
					title: `Cleared ${kind} for ${runId}`,
				});
			}
		};
		for (const run of sessionManifests) {
			if (run.status !== "running") {
				// GATE 1 — preloaded manifest says terminal. Purge any stale snapshot
				// and clear previously-emitted health notifications so the dashboard
				// stays clean (belt-and-suspenders with the FIX #1 fresh-read gate).
				snapshotCache.invalidate(run.runId);
				clearHealthNotifications(run.runId);
				continue;
			}
			try {
				// FIX #1: re-verify against a FRESH manifest read. The preloaded `run`
				// (from lastPreloadedManifests) can lag the on-disk terminal
				// transition; the manifest cache has a 500ms TTL + file watcher so it
				// is the source of truth. A terminal run must NEVER reach
				// maybeNotifyHealth. Also purge the stale snapshot + clear any
				// previously-emitted health notification for this run.
				const freshManifest = ctx.getManifestCache(extensionCtx.cwd).get(run.runId);
				if (freshManifest?.status !== "running") {
					snapshotCache.invalidate(run.runId);
					clearHealthNotifications(run.runId);
					continue;
				}
				const snapshot = snapshotCache.get(run.runId);
				if (!snapshot) continue;
				if (snapshot.manifest.status !== "running") {
					// GATE 2 — a running snapshot paired with a now-terminal manifest is
					// stale. Purge it so subsequent ticks get a fresh view, and clear.
					snapshotCache.invalidate(run.runId);
					clearHealthNotifications(run.runId);
					continue;
				}
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
		// bug-026 sub-issue C: evict terminal runs from the preloaded manifest
		// frame so a stale "running" entry cannot persist for the session
		// lifetime. Additive to the renderTick GATE 1 / FIX #1 / GATE 2 snapshot
		// purges (which invalidate the snapshot cache) — those gates do not
		// touch lastPreloadedManifests itself.
		lastPreloadedManifests = applyTerminalRunEventToManifests(lastPreloadedManifests, event);
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
		// PERF (2026-08-24): coalesced ASYNC refresh — fs.watch can fire many
		// times per second and the sync rebuild blocked the UI event loop; the
		// render schedule below repaints while the rebuild lands.
		try {
			ctx.getRunSnapshotCache(ctx.currentCtx?.cwd ?? process.cwd()).scheduleRefresh(runId);
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

// =============================================================================
// Phase 0 inter-pi broker lifecycle controller (sub-task 0.5)
// =============================================================================
//
// `installCrewBrokerLifecycleController` wires the per-session broker into
// the existing extension lifecycle. The controller:
//
//  - is a no-op unless broker.enabled is true AND the current process is the
//    root pi session (PI_CREW_KIND !== "subagent" AND currentCrewDepth === 0).
//    Children NEVER install a broker.
//  - lazily constructs a single CrewBroker instance per session_id. listen()
//    is deferred until the first child run actually requests broker credentials.
//  - issues a heap-only token per child run via `issueForChild`. The token
//    NEVER leaves the parent's heap and the child's env (PI_CREW_BROKER_TOKEN).
//    It is never written to disk.
//  - retains the broker across session switches when the session_id is
//    unchanged; on a session_id change, stops the old broker and binds a new
//    one on the next acquire.
//  - stops the broker during session_shutdown BEFORE the runtime cleanup path.
//
// The gate is re-evaluated on every `issueForChild` call (cheap env+depth
// check) so the kill switch (PI_CREW_BROKER=0) takes effect immediately.

export interface CrewBrokerLifecycleController {
	/** Issue credentials for a child run. Returns undefined when the broker
	 *  is disabled, this process is a subagent, or no session_id is known. */
	issueForChild(runId: string, taskId?: string): Promise<BrokerSpawnCredentials | undefined>;
	/** Stop the broker (idempotent). Called on session_shutdown. */
	stop(): Promise<void>;
	/** Test/lifecycle seam: remember the most recent session_id for token issuance. */
	setSessionId(sessionId: string | undefined): void;
}

function isRootSession(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.PI_CREW_KIND === "subagent") return false;
	try {
		return currentCrewDepth(env) === 0;
	} catch {
		return false;
	}
}

export function installCrewBrokerLifecycleController(_pi: ExtensionAPI, _ctx: RegistrationContext): CrewBrokerLifecycleController {
	let broker: CrewBroker | null = null;
	let brokerSessionId: string | undefined;
	let starting: Promise<CrewBroker> | null = null;
	let cachedSessionId: string | undefined;

	function effectiveEnabled(): boolean {
		// Env wins over config. PI_CREW_BROKER=1 forces on, =0 forces off.
		const envOverride = getCrewEnv("PI_CREW_BROKER");
		if (envOverride === "0") return false;
		// Config block: read fresh so a runtime config update takes effect.
		try {
			const cfg = loadConfig().config.broker;
			if (envOverride === "1") return cfg !== undefined ? cfg.enabled !== false : true;
			// Phase 4 (v0.9.47) default-on: enabled unless explicitly disabled.
			return cfg?.enabled !== false;
		} catch {
			// Fail-safe: config load failed → keep broker disabled.
			return false;
		}
	}

	async function getOrStartBroker(sessionId: string): Promise<CrewBroker> {
		if (broker && brokerSessionId === sessionId) return broker;
		if (broker && brokerSessionId !== sessionId) {
			try {
				await broker.stop();
			} catch {
				/* ignore */
			}
			broker = null;
			brokerSessionId = undefined;
		}
		if (!broker && !starting) {
			starting = (async () => {
				const cfg = (() => {
					try {
						// B1 battery 2026-08-18 (third config-layer bug): loadConfig()
						// WITHOUT cwd reads only the user config — the workspace
						// .crew/config.json (where broker.waitMethodsEnabled:true would
						// live) was never merged, so the flag stayed default-false even
						// after the parser + merge fixes. Pass the SAME cwd the broker
						// itself uses below.
						return loadConfig(process.cwd()).config.broker;
					} catch {
						return undefined;
					}
				})();
				// T3/R5 (ADR-5 §10): governed-nesting + limits config for the delegate
				// surface — same cwd discipline as the broker block above.
				const nestingCfg = (() => {
					try {
						const c = loadConfig(process.cwd()).config;
						return { nesting: c.nesting, limits: c.limits };
					} catch {
						return undefined;
					}
				})();
				const b = new CrewBroker({
					sessionId,
					socketPath: getBrokerSocketPath(sessionId),
					maxFrameBytes: cfg?.maxFrameBytes ?? 262144,
					outboundQueueCap: cfg?.outboundQueueCap ?? 256,
					// WP-2 review round 1 (P1): thread the capability gate into the
					// PRODUCTION broker — the constructor default (false) made
					// config.broker.waitMethodsEnabled a dead knob and the ADR-0
					// "then true" flip a silent no-op. Fail-closed when unset.
					waitMethodsEnabled: cfg?.waitMethodsEnabled ?? false,
					// T3/R5 (ADR-5 §10): governed-nesting capability gate — fail-closed
					// default; production threads config.nesting (sensitive: user config
					// only). Nested-slot sizing + admission-time model catalog (ADR-5 §7 —
					// the production wiring MUST supply it) + workspace gate mirror.
					nestingEnabled: nestingCfg?.nesting?.enabled ?? false,
					...(nestingCfg?.nesting?.maxSlots !== undefined ? { nestingMaxSlots: nestingCfg.nesting.maxSlots } : {}),
					...(nestingCfg?.nesting?.maxDepth !== undefined ? { nestingMaxDepth: nestingCfg.nesting.maxDepth } : {}),
					// ADR-5 §12: enabling the sensitive USER-config-only flag IS the manual
					// trust decision for the escalation surface.
					nestingTrustedEscalation: nestingCfg?.nesting?.enabled === true,
					...(nestingCfg?.limits?.maxConcurrentWorkers !== undefined
						? { globalWorkerSemaphore: nestingCfg.limits.maxConcurrentWorkers }
						: {}),
					serializeOnPathOverlap: nestingCfg?.limits?.serializeOnPathOverlap ?? false,
					modelCatalog: () => {
						try {
							return configuredModelInfosFromPiConfig(process.cwd()).map((info) => info.fullId);
						} catch {
							return undefined;
						}
					},
					enabled: true,
					cwd: process.cwd(),
				});
				try {
					await b.start();
					broker = b;
					brokerSessionId = sessionId;
					return b;
				} finally {
					starting = null;
				}
			})();
		}
		return starting!;
	}

	const issueForChild = async (runId: string, taskId?: string, childDepth?: number): Promise<BrokerSpawnCredentials | undefined> => {
		if (!runId || typeof runId !== "string") return undefined;
		if (!isRootSession(process.env)) return undefined;
		if (!effectiveEnabled()) return undefined;
		// ADR-5 §4 (governed nesting): tokens are minted ONLY for children that
		// may themselves delegate — childDepth < resolved maxDepth. At the default
		// maxDepth=2 a delegate-spawned depth-2 grandchild gets NO credentials
		// (env containment: no PI_CREW_BROKER_SOCKET/TOKEN at depth 2; identity
		// routing via PI_CREW_BROKER_RUN_ID/TASK_ID is threaded unconditionally
		// elsewhere). Undefined childDepth = legacy worker spawn (depth 1).
		if (childDepth !== undefined && childDepth >= resolveCrewMaxDepth(undefined)) return undefined;
		const sessionId = cachedSessionId;
		if (!sessionId) return undefined;
		try {
			const b = await getOrStartBroker(sessionId);
			const token = b.issueRunToken(runId, taskId);
			return { socketPath: b.socketPath, token };
		} catch {
			return undefined;
		}
	};

	// Publish this issuer as the process-local active issuer so runChildPi can
	// default `brokerIssuer` without the registration context being threaded
	// through every runner call site. The issuer self-gates (root + flag), so
	// publishing it unconditionally is safe even when the broker is disabled.
	setActiveBrokerIssuer(issueForChild);

	return {
		issueForChild,
		stop: async () => {
			setActiveBrokerIssuer(undefined);
			if (broker) {
				try {
					await broker.stop();
				} catch {
					/* ignore */
				}
				broker = null;
				brokerSessionId = undefined;
			}
		},
		/** Test seam: remember the most recent session_id for token issuance. */
		setSessionId: (sessionId: string | undefined) => {
			// Runtime validation: cap the length and charset to defend against
			// a hostile extension supplying a huge or pathological id. The
			// socket path is already hash-derived (4..32 hex), so a longer
			// sessionId is harmless on disk but wastes heap.
			if (typeof sessionId !== "string") return;
			if (sessionId.length === 0 || sessionId.length > 256) return;
			cachedSessionId = sessionId;
		},
	};
}

/** Marker used by tests to confirm the controller object identity. */
export const __test__brokerControllerMarker = true;
