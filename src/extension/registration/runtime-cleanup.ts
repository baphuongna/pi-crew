/**
 * Runtime cleanup installer for pi-crew.
 *
 * Owns the two cleanup functions used at session boundaries:
 *   • `cleanupRuntime` — full shutdown. Aborts foreground team runs,
 *     stops scheduler, disposes all caches, disposes notifier, etc.
 *   • `cleanupSessionResourcesOnly` — session switch (resume/new/fork).
 *     Same as above but does NOT abort foreground team runs — they share
 *     the process with the session and clean up naturally when the
 *     ExtensionContext tears down.
 *
 * Both also handle the global-runtime-handoff symbol: if a previous
 * pi-crew instance left a cleanup handler in `globalStore[runtimeCleanupStoreKey]`,
 * it is fired-and-forgotten before we install our own.
 *
 * Other bounded helpers used by these functions (stopSessionBoundSubagents,
 * disposeRenderSchedulerSubscriptions) are co-located here because they
 * belong to the same lifecycle phase.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { clearHooksScoped } from "../../hooks/registry.ts";
import { stopAsyncRunNotifier } from "../async-notifier.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import {
	clearPiCrewPowerbar,
	disposePowerbarCoalescer,
} from "../../ui/powerbar-publisher.ts";
import { stopCrewWidget } from "../../ui/widget/index.ts";
import { clearProjectRootCache } from "../../utils/paths.ts";
import { uninstallCrewGlobalRegistry } from "../team-tool.ts";
import { terminateActiveChildPiProcesses } from "../../subagents/spawn.ts";
import { disposeNotifications } from "./lifecycle.ts";
import { disposeObservability } from "./observability.ts";
import type { RegistrationContext } from "./registration-types.ts";

/**
 * Install both cleanup functions into the registration context AND wire
 * the global handoff symbol so a previous instance's cleanup runs first.
 */
export function installRuntimeCleanup(_pi: ExtensionAPI, ctx: RegistrationContext): void {
	// Best-effort cleanup of the previous runtime instance. Errors are logged but
	// do not halt new registration — a failing cleanup from a prior instance is
	// preferable to leaving pi-crew unregistered, and any stale state from the
	// previous instance will be reconciled when the new instance initializes.
	const previousRuntimeCleanup = ctx.globalStore[ctx.runtimeCleanupStoreKey];
	if (typeof previousRuntimeCleanup === "function") {
		try {
			previousRuntimeCleanup();
		} catch (error) {
			logInternalError("register.prev-cleanup", error);
		}
	}

	ctx.cleanupSessionResourcesOnly = buildCleanupSessionResourcesOnly(ctx);
	ctx.cleanupRuntime = buildCleanupRuntime(ctx);
	ctx.disposeRenderSchedulerSubscriptions = buildDisposeRenderSchedulerSubscriptions(ctx);
	ctx.stopSessionBoundSubagents = buildStopSessionBoundSubagents(ctx);

	ctx.globalStore[ctx.runtimeCleanupStoreKey] = ctx.cleanupRuntime;
}

/**
 * Build a cleanup function for session-switch events. Same teardown as
 * cleanupRuntime except foreground team-run controllers are NOT aborted.
 */
function buildCleanupSessionResourcesOnly(ctx: RegistrationContext): () => void {
	return (): void => {
		if (ctx.cleanedUp) return;
		ctx.cleanedUp = true;
		if (ctx.preloadTimer) {
			clearTimeout(ctx.preloadTimer);
			ctx.preloadTimer = undefined;
		}
		ctx.crewRunWatchers?.closeAll();
		ctx.crewRunWatchers = undefined;
		ctx.userCrewWatchers?.closeAll();
		ctx.userCrewWatchers = undefined;
		ctx.stopSessionBoundSubagents();
		// P0 fix: Do NOT abort foreground team runs on session switch.
		// Foreground team runs run in the same process as the session; they naturally clean up
		// when the session context is torn down. Only subagents need explicit abort on switch.
		// Foreground runs will be aborted by cleanupRuntime() during actual session shutdown.
		ctx.crewScheduler?.stop();
		stopAsyncRunNotifier(ctx.notifierState);

		// P0: Purge all stale active-run-index entries on session cleanup.
		ctx.purgeStaleActiveRunIndexSyncIfLoaded();

		stopCrewWidget(
			ctx.currentCtx,
			ctx.widgetState,
			ctx.currentCtx ? loadConfig(ctx.currentCtx.cwd).config.ui : undefined,
		);
		clearPiCrewPowerbar(ctx.pi.events);
		disposePowerbarCoalescer();
		void disposeObservability(ctx.observabilityState, ctx.cleanedUp);
		ctx.lifecycleState.deliveryCoordinator?.dispose();
		clearHooksScoped();
		uninstallCrewGlobalRegistry();
		ctx.lifecycleState.overflowTracker?.dispose();
		ctx.lifecycleState.deliveryCoordinator = undefined;
		ctx.lifecycleState.overflowTracker = undefined;
		ctx.manifestCache.dispose();
		ctx.runSnapshotCache.dispose?.();
		clearProjectRootCache();
		ctx.renderScheduler?.dispose();
		ctx.renderScheduler = undefined;
		ctx.autoRecoveryLast.clear();
		disposeNotifications(ctx.lifecycleState);
		ctx.rpcHandle?.unsubscribe();
		ctx.rpcHandle = undefined;
		ctx.disposeI18n();
		ctx.sessionGeneration += 1;
		ctx.currentCtx = undefined;
		if (ctx.globalStore[ctx.runtimeCleanupStoreKey] === ctx.cleanupSessionResourcesOnly) {
			delete ctx.globalStore[ctx.runtimeCleanupStoreKey];
		}
	};
}

/**
 * Build the full shutdown cleanup. Aborts both subagent controllers AND
 * foreground team-run controllers.
 */
function buildCleanupRuntime(ctx: RegistrationContext): () => void {
	return (): void => {
		if (ctx.cleanedUp) return;
		ctx.cleanedUp = true;
		if (ctx.preloadTimer) {
			clearTimeout(ctx.preloadTimer);
			ctx.preloadTimer = undefined;
		}
		ctx.crewRunWatchers?.closeAll();
		ctx.crewRunWatchers = undefined;
		ctx.userCrewWatchers?.closeAll();
		ctx.userCrewWatchers = undefined;
		ctx.stopSessionBoundSubagents();
		// P0 fix: also abort foreground team runs on session shutdown (not on session switch).
		// This is the only place where foreground team run controllers should be aborted.
		for (const controller of ctx.foregroundTeamRunControllers.values()) controller.abort();
		ctx.foregroundTeamRunControllers.clear();
		ctx.crewScheduler?.stop();
		stopAsyncRunNotifier(ctx.notifierState);

		// Best-effort: kill any async background runners that are still alive.
		// NOTE: Background runners are designed to outlive the Pi session.
		// Do NOT kill them on session_shutdown — they manage their own lifecycle.
		// Only kill foreground child processes (handled above via abort controllers).
		// See Bug #17: killing async runners on session_shutdown was the root cause
		// of the "background runner dies at ~35s" bug.
		// (kill-async block intentionally omitted — see history.)

		// P0: Purge all stale active-run-index entries on session cleanup.
		// This handles: normal exit, SIGTERM, Ctrl+C — any case where cleanupRuntime fires.
		// For SIGKILL / crash / SIGHUP (where cleanupRuntime does NOT fire),
		// purgeStaleActiveRunIndex() runs at next session_start instead.
		// 2.7: only purge if crash-recovery has been loaded already; otherwise
		// the next session_start will fire the lazy import + purge.
		ctx.purgeStaleActiveRunIndexSyncIfLoaded();

		stopCrewWidget(
			ctx.currentCtx,
			ctx.widgetState,
			ctx.currentCtx ? loadConfig(ctx.currentCtx.cwd).config.ui : undefined,
		);
		clearPiCrewPowerbar(ctx.pi.events);
		disposePowerbarCoalescer();
		// H3-L2 split: observability disposal delegated to registration/observability.ts.
		void disposeObservability(ctx.observabilityState, ctx.cleanedUp);
		ctx.lifecycleState.deliveryCoordinator?.dispose();
		clearHooksScoped();
		uninstallCrewGlobalRegistry();
		ctx.lifecycleState.overflowTracker?.dispose();
		ctx.lifecycleState.deliveryCoordinator = undefined;
		ctx.lifecycleState.overflowTracker = undefined;
		ctx.manifestCache.dispose();
		ctx.runSnapshotCache.dispose?.();
		// 2.10: drop cached findRepoRoot results when the extension reloads.
		clearProjectRootCache();
		ctx.renderScheduler?.dispose();
		ctx.renderScheduler = undefined;
		ctx.autoRecoveryLast.clear();
		// H3-L2 split: notification disposal delegated to registration/lifecycle.ts.
		disposeNotifications(ctx.lifecycleState);
		ctx.rpcHandle?.unsubscribe();
		ctx.rpcHandle = undefined;
		ctx.disposeI18n();
		ctx.sessionGeneration += 1;
		ctx.currentCtx = undefined;
		if (ctx.globalStore[ctx.runtimeCleanupStoreKey] === ctx.cleanupRuntime) {
			delete ctx.globalStore[ctx.runtimeCleanupStoreKey];
		}
	};
}

/**
 * Build the dispose-render-scheduler-subscriptions helper. Unsubscribes
 * every entry in `ctx.renderSchedulerUnsubscribers`, then clears the list.
 * Errors per-entry are logged but don't abort the loop.
 */
function buildDisposeRenderSchedulerSubscriptions(ctx: RegistrationContext): () => void {
	return (): void => {
		for (const unsub of ctx.renderSchedulerUnsubscribers.splice(0)) {
			try {
				unsub();
			} catch (error) {
				logInternalError("register.renderScheduler.unsubscribe", error);
			}
		}
	};
}

/**
 * Build the stop-session-bound-subagents helper. Aborts every foreground
 * subagent controller (NOT foreground team runs — those are owned by the
 * team-tool, not the subagent manager). Disposes render scheduler,
 * terminal status, live sidebar, and clears the powerbar.
 */
function buildStopSessionBoundSubagents(ctx: RegistrationContext): () => void {
	return (): void => {
		// Only abort subagent controllers — NOT foreground team runs.
		// Foreground team runs are bound to the session lifecycle; they will be aborted
		// by cleanupRuntime during session_shutdown.
		for (const controller of ctx.foregroundControllers.values()) controller.abort();
		ctx.foregroundControllers.clear();
		ctx.subagentManager.abortAll("Session switching — foreground subagents cancelled.");
		terminateActiveChildPiProcesses();
		ctx.disposeRenderSchedulerSubscriptions();
		ctx.renderScheduler?.dispose();
		ctx.renderScheduler = undefined;
		ctx.terminalStatus?.dispose();
		ctx.terminalStatus = undefined;
		ctx.terminalStatusActive = false;
		ctx.uiState.liveSidebarRunId = undefined;
		if (ctx.currentCtx) {
			stopCrewWidget(ctx.currentCtx, ctx.widgetState, loadConfig(ctx.currentCtx.cwd).config.ui);
		}
		clearPiCrewPowerbar(ctx.pi.events);
	};
}
