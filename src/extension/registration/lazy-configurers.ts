/**
 * Lazy lifecycle/observability configurers for pi-crew.
 *
 * These three small functions wire up the heavy runtime subsystems on
 * the first session_start. They are kept as LAZY dynamic imports because:
 *   • `./registration/lifecycle.ts` pulls in notification-router + sink
 *     (~10 KB + heavy deps),
 *   • `./registration/observability.ts` pulls in HeartbeatWatcher +
 *     metric stack (~12 KB + heavy deps).
 *
 * Pre-loading them at register-time would force every cold start of
 * pi-crew to pay the cost even if the user never opens a session.
 *
 * The orchestrator (`register.ts`) installs these via
 * `installLazyConfigurers`, which binds them as `ctx.configureNotifications`,
 * `ctx.configureObservability`, `ctx.configureDeliveryCoordinator`. The
 * session_start handler invokes them via the context — see
 * `lifecycle-handlers.ts`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendDeadletter } from "../../runtime/deadletter.ts";
import { cleanupLegacyOrphanTempDirs, cleanupOrphanTempDirs } from "../../runtime/model/pi-args.ts";
import { reconcileAllStaleRuns } from "../../runtime/recovery/crash-recovery.ts";
import { reconcileOrphanedTempWorkspaces } from "../../runtime/stale-reconciler.ts";
import { requestPowerbarUpdate } from "../../ui/powerbar-publisher.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { extractSessionId } from "../../utils/session-utils.ts";
import type { RegistrationContext } from "./registration-types.ts";
import { sendAgentWakeUp, sendFollowUp } from "./subagent-helpers.ts";

/**
 * Bind the three lazy configurers onto the registration context. After
 * this call:
 *   • `ctx.configureNotifications(ctx)` fires the registration/lifecycle
 *     install with the bound deps bag.
 *   • `ctx.configureObservability(ctx)` fires the registration/observability
 *     install (metric registry, OTLP exporter, heartbeat watcher).
 *   • `ctx.configureDeliveryCoordinator()` wires the delivery coordinator
 *     + overflow tracker (no dynamic import — already loaded by the
 *     registration/lifecycle module).
 */
export function installLazyConfigurers(pi: ExtensionAPI, ctx: RegistrationContext): void {
	ctx.configureNotifications = (extCtx: ExtensionContext): void => {
		void configureNotificationsImpl(pi, ctx, extCtx);
	};
	ctx.configureObservability = (extCtx: ExtensionContext): void => {
		void configureObservabilityImpl(pi, ctx, extCtx);
	};
	ctx.configureDeliveryCoordinator = (): void => {
		void configureDeliveryCoordinatorImpl(pi, ctx);
	};
	installTurnReconcileHook(pi, ctx);
}

/**
 * F12 (RR-018): register the before_agent_start reconcile hook EXACTLY ONCE
 * for the extension lifetime. The callback resolves the CURRENT session
 * (`ctx.currentCtx`) at fire time instead of capturing the configuring
 * session's ExtensionContext, so a stale session's hook can never re-activate,
 * double-reconcile a turn, or flip the shared manifest-cache cwd back to an
 * old session's directory. (There is no pi.off unregister surface, so the old
 * per-session registration accumulated one dead hook per session switch.)
 */
function installTurnReconcileHook(pi: ExtensionAPI, ctx: RegistrationContext): void {
	try {
		pi.on?.("before_agent_start", () => {
			const current = ctx.currentCtx;
			if (!current || ctx.cleanedUp) return;
			try {
				reconcileAllStaleRuns(current.cwd, ctx.getManifestCache(current.cwd), undefined, extractSessionId(current));
			} catch (error) {
				logInternalError("register.autoRepair.turnHook", error);
			}
		});
	} catch {
		/* older Pi without before_agent_start — rely on the interval alone */
	}
}

/**
 * Lazy-load registration/lifecycle.ts and wire its notifications system.
 *
 * The deps bag is built once-per-call (cheap — just object literals) so
 * every session_start cycle gets a fresh closure that reads the latest
 * `ctx.currentCtx` and caches.
 */
async function configureNotificationsImpl(pi: ExtensionAPI, ctx: RegistrationContext, extCtx: ExtensionContext): Promise<void> {
	// F11: capture the owning generation BEFORE the first await — the deps
	// closure below re-checks it after lifecycle.ts's lazy imports resolve.
	const ownerGeneration = ctx.sessionGeneration;
	try {
		// LAZY: registration/lifecycle is heavy (notification-router + sink)
		const lifecycleModule = await import("./lifecycle.ts");
		await lifecycleModule.configureNotifications(extCtx, ctx.lifecycleState, {
			pi,
			widgetState: ctx.widgetState,
			getCurrentCtx: () => ctx.currentCtx,
			getManifestCache: ctx.getManifestCache,
			getRunSnapshotCache: ctx.getRunSnapshotCache,
			requestPowerbarUpdate,
			isOwnerSession: () => !ctx.cleanedUp && ctx.sessionGeneration === ownerGeneration,
		});
	} catch (error) {
		logInternalError("register.configureNotifications", error);
	}
}

/**
 * Lazy-load registration/observability.ts and wire its metric stack.
 *
 * In addition to the metric registry / OTLP exporter, this is where the
 * stale-reconcile and orphan-temp-dir timers are installed — see
 * registration/observability.ts for details.
 */
async function configureObservabilityImpl(pi: ExtensionAPI, ctx: RegistrationContext, extCtx: ExtensionContext): Promise<void> {
	try {
		// LAZY: registration/observability is heavy (HeartbeatWatcher + metric stack)
		const observabilityModule = await import("./observability.ts");
		await observabilityModule.configureObservability(extCtx, ctx.observabilityState, {
			pi,
			getManifestCache: ctx.getManifestCache,
			notifyOperator: ctx.notifyOperator,
			isCleanedUp: () => ctx.cleanedUp,
			// F11: reuse the existing sessionGeneration counter — never a parallel one.
			getSessionGeneration: () => ctx.sessionGeneration,
			reconcileStaleRuns: (cwd, cache, currentSessionId) => reconcileAllStaleRuns(cwd, cache, undefined, currentSessionId),
			reconcileOrphanedTempWorkspaces: (now, opts) => reconcileOrphanedTempWorkspaces(now, opts),
			cleanupOrphanTempDirs,
			cleanupLegacyOrphanTempDirs,
			appendDeadletter: (manifest, entry) => appendDeadletter(manifest, entry as Parameters<typeof appendDeadletter>[1]),
			importCrashRecovery: ctx.importCrashRecovery,
		});
	} catch (error) {
		logInternalError("register.configureObservability", error);
	}
}

/**
 * Wire delivery coordinator + overflow tracker. Uses the
 * registration/lifecycle module's configureDeliveryCoordinator helper.
 * No dynamic import needed — lifecycle is already loaded by configureNotifications.
 */
async function configureDeliveryCoordinatorImpl(pi: ExtensionAPI, ctx: RegistrationContext): Promise<void> {
	const ownerGeneration = ctx.sessionGeneration;
	try {
		// LAZY: lifecycle.ts may not be loaded yet if configureNotifications hasn't fired.
		const lifecycleModule = await import("./lifecycle.ts");
		await lifecycleModule.configureDeliveryCoordinator(ctx.lifecycleState, {
			pi,
			observabilityState: ctx.observabilityState,
			notifyOperator: ctx.notifyOperator,
			sendFollowUp,
			sendAgentWakeUp,
			isOwnerSession: () => !ctx.cleanedUp && ctx.sessionGeneration === ownerGeneration,
		});
	} catch (error) {
		logInternalError("register.configureDeliveryCoordinator", error);
	}
}
