/**
 * Lifecycle handler installer for pi-crew.
 *
 * Owns:
 *   • `session_start` — heavy setup (config, scheduler, deferred crash
 *     recovery). This is the bulk of the orchestrator's per-session work,
 *     extracted here so `register.ts` stays thin. The render loop + preload
 *     pipeline + bounded run watchers live in ./render-loop.ts (QW#2).
 *   • `session_shutdown` — reason-aware cleanup (quit/reload aborts
 *     foreground runs; resume/new/fork preserves them).
 *   • `session_before_switch` — graceful session switch handoff.
 *
 * Imports here are kept top-level (non-lazy) on purpose: this module IS
 * where the heavy work happens, so there is no cold-start benefit to
 * deferring it. The session_start handler internally uses lazy imports
 * for its own per-call optional work (foreground-watchdog, atomic-write).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { DEFAULT_UI } from "../../config/defaults.ts";
import { getCrewEnv } from "../../config/env-vars.ts";
import {
	pruneFinishedRuns,
	pruneUserLevelRuns,
	resolveAutoPruneAgeFloorMs,
	resolveAutoPruneKeep,
} from "../../extension/run-maintenance.ts";
import { type BrokerSpawnCredentials, setActiveBrokerIssuer, setActiveBrokerRevoker } from "../../runtime/broker/broker-issuer.ts";
import { CrewBroker } from "../../runtime/broker/crew-broker.ts";
import { terminateActiveChildPiProcesses } from "../../runtime/child-pi/child-pi.ts";
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
import { applyCrewSettingsTiersToConfig, loadCrewSettingsTiers, scheduledJobsHiddenCountOf } from "../../runtime/settings-store.ts";
import type { ReconcileResult } from "../../runtime/stale-reconciler.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import { installInlinePanel } from "../../ui/inline-panel/index.ts";
import { clearSessionSwitchInFlight, markSessionSwitchInFlight } from "../../ui/inline-panel/view-session-store.ts";
import { registerPiCrewPowerbarSegments, resetPowerbarDedupState, updatePiCrewPowerbar } from "../../ui/powerbar-publisher.ts";
import { updateCrewWidget } from "../../ui/widget/index.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { extractBrokerSessionId } from "../../utils/session-utils.ts";
import { getBrokerSocketPath } from "../../utils/socket-path.ts";
import { startAsyncRunNotifier, stopAsyncRunNotifier } from "../async-notifier.ts";
import { registerCrewAutocomplete } from "../crew-autocomplete.ts";
import { notifyActiveRuns } from "../session-summary.ts";
import { persistScheduledJobUpdate, registerCrewScheduler, stashScheduledJobsHiddenCount } from "../team-tool/handle-schedule.ts";
import { handleTeamTool } from "../team-tool.ts";
import { runArtifactCleanup } from "./artifact-cleanup.ts";
import type { RegistrationContext } from "./registration-types.ts";
import { deliverDetachedRunResults, setupRenderLoop } from "./render-loop.ts";
import { createScheduleEventNotifier } from "./schedule-toast-bridge.ts";
import { refreshCrossExtensionWiringForSession } from "./wire-cross-extension.ts";

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

// ─── NEW-2 (SDD-4 follow-up, P3 review MAJOR 1): honest stale-reconcile notify ──

/**
 * Repaired runIds already surfaced by the session-start stale-reconcile
 * notify in THIS process, bounded so a long-lived session cannot grow the set
 * unboundedly (overflow clears — a re-notify after 256+ distinct repairs is
 * acceptable noise, an unbounded leak is not).
 *
 * Cross-restart dedupe is structural, not tracked here: a real repair persists
 * a terminal run status, so the run drops out of the reconcile input and can
 * never re-notify. The set guards the two in-process repeat windows — session
 * reload/fork re-firing session_start, and a repair whose persistence failed
 * (disk error / lock steal leaves the run reconcileable while the notify still
 * claimed it). Observed pre-fix (2026-09-29): 77 dishonest notifies/day,
 * ~3x per runId, because non-repaired verdicts (blocked_awaiting_approval,
 * waiting_answer, result_exists) never persist anything and re-fired the
 * "Found and repaired ghost runs" text on every session start.
 */
const notifiedRepairedRunIds = new Set<string>();
const NOTIFIED_REPAIRED_RUN_IDS_CAP = 256;

/** What the session-start stale-reconcile notify should say (or null: say nothing). */
export interface StaleReconcileNotifyPlan {
	title: string;
	body: string;
}

/**
 * NEW-2: decide the operator notification for a session-start reconcile
 * batch. Honest by construction — a notify is emitted ONLY when reconcile
 * actually repaired something (`repaired === true`): non-repaired verdicts
 * are intentional states (plan approval pending, ask parked, result already
 * exists) that the run dashboard already surfaces, so claiming "repaired"
 * for them was a false system statement. The title says exactly what
 * happened ("Repaired N stale run(s)"), the body names each repaired runId
 * with its verdict, and each repaired runId notifies at most once per
 * process (bounded set above).
 */
export function decideStaleReconcileNotification(staleResults: ReconcileResult[]): StaleReconcileNotifyPlan | null {
	const repaired = staleResults.filter((r) => r.repaired === true && !notifiedRepairedRunIds.has(r.runId));
	if (repaired.length === 0) return null;
	for (const r of repaired) {
		if (notifiedRepairedRunIds.size >= NOTIFIED_REPAIRED_RUN_IDS_CAP) notifiedRepairedRunIds.clear();
		notifiedRepairedRunIds.add(r.runId);
	}
	return {
		title: `Repaired ${repaired.length} stale run(s)`,
		body: `Repaired stale runs from previous sessions: ${repaired.map((r) => `${r.runId} (${r.verdict})`).join(", ")}`,
	};
}

/** Test seam: reset the per-process dedupe set between unit tests. */
export function __test__resetNotifiedRepairedRunIds(): void {
	notifiedRepairedRunIds.clear();
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
		// F13 (RR-018): RPC wiring is extension-lifetime and survives session
		// switches; rebind the crew global registry to THIS session's manifest
		// cache (idempotent — see wire-cross-extension.ts).
		refreshCrossExtensionWiringForSession(pi, ctx);

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
		// P2-1 (B2 gate visibility): stash the hidden project-tier count from the
		// SAME tiers read above (zero extra disk I/O — disk reads are legal here
		// at session_start but never on later paint paths) so the crew widget
		// line and the dashboard pane can surface "N project-tier jobs hidden".
		stashScheduledJobsHiddenCount(scheduledJobsHiddenCountOf(crewSettingsTiers));
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
		// RR-021 WI-1.5: reconcile is async (mapConcurrent bound 4) — keep this
		// session_start callback synchronous; notify when the result lands.
		void reconcileAllStaleRuns(extensionCtx.cwd, ctx.getManifestCache(extensionCtx.cwd), Date.now(), currentSessionId)
			.then((staleResults) => {
				// NEW-2 (SDD-4 follow-up): honest notify — only actual repairs are
				// reported, each repaired runId at most once per process. Non-repaired
				// verdicts (blocked_awaiting_approval / waiting_answer /
				// result_exists) must NEVER be claimed as "repaired".
				const plan = decideStaleReconcileNotification(staleResults ?? []);
				if (plan) {
					ctx.notifyOperator({
						id: "stale_reconcile",
						severity: "info",
						source: "crash-recovery",
						title: plan.title,
						body: plan.body,
					});
				}
			})
			.catch((error) => {
				logInternalError("register.sessionStart.reconcileStale", error);
			});
	} catch (error) {
		logInternalError("register.sessionStart.reconcileStale", error);
	}

	// Auto-prune finished project-level run directories
	try {
		// DP-01: keep + age-floor are env-driven; the age floor means a run
		// finished <24h ago survives a session restart even beyond top-keep.
		const { removed } = pruneFinishedRuns(extensionCtx.cwd, resolveAutoPruneKeep(), {
			ageFloorMs: resolveAutoPruneAgeFloorMs(),
			intent: "session-start-auto",
		});
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
		const { removed } = pruneUserLevelRuns(resolveAutoPruneKeep(), {
			ageFloorMs: resolveAutoPruneAgeFloorMs(),
			intent: "session-start-auto",
		});
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
	// Tier D (schedules UI): scheduler events → terminal-status toasts. Bounded
	// (hung-notice pattern): at most one notice per event; headless sessions
	// no-op inside the bridge (hasUI probed defensively) instead of crashing.
	const notifyScheduleEvent = createScheduleEventNotifier({
		hasUI: () => extensionCtx.hasUI,
		ui: extensionCtx.ui,
	});
	crewScheduler.start({
		emit: (event) => {
			if (ctx.cleanedUp) return;
			notifyScheduleEvent(event);
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
					// T3/R5 (ADR-5 §10): governed-nesting capability gate — default-on
					// since D8 (loadConfig layers DEFAULT_NESTING.enabled=true; sensitive
					// flag, so only USER config may flip it). Nested-slot sizing +
					// admission-time model catalog (ADR-5 §7 — the production wiring
					// MUST supply it) + workspace gate mirror.
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
		// maxDepth=4 a delegate-spawned depth-4 grandchild gets NO credentials
		// (env containment: no PI_CREW_BROKER_SOCKET/TOKEN at the cap depth; identity
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

	// MuxSurface A1 (spec §7 D3 step 2): publish the revoker alongside the
	// issuer — team-runner's degrade controller calls it when a pane is lost.
	// Best-effort and self-gated: no broker bound (never started / session
	// switched) means nothing to revoke; re-issue after respawn mints fresh (T10).
	const revokeForTask = (taskId: string): void => {
		if (!taskId || typeof taskId !== "string") return;
		if (!isRootSession(process.env)) return;
		if (!broker || brokerSessionId !== cachedSessionId) return;
		try {
			broker.revokeTaskToken(taskId);
		} catch (error) {
			logInternalError(
				"broker.revoke-for-task",
				error instanceof Error ? error : new Error(String(error)),
				`taskId=${taskId}`,
				"warn",
			);
		}
	};
	setActiveBrokerRevoker(revokeForTask);

	// Publish this issuer as the process-local active issuer so runChildPi can
	// default `brokerIssuer` without the registration context being threaded
	// through every runner call site. The issuer self-gates (root + flag), so
	// publishing it unconditionally is safe even when the broker is disabled.
	setActiveBrokerIssuer(issueForChild);

	return {
		issueForChild,
		stop: async () => {
			setActiveBrokerIssuer(undefined);
			setActiveBrokerRevoker(undefined);
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
