/**
 * RegistrationContext builder.
 *
 * Pure construction of the mutable state bag passed to every install*
 * helper under `./registration/`. Kept in its own file because the
 * initialization is verbose (every field of the orchestrator's state
 * is initialized here) and bundling it into `register.ts` would push
 * that file past its size budget.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { initI18n } from "../../i18n.ts";
import { BatchBarrier } from "../../runtime/batch-barrier.ts";
import { createManifestCache } from "../../runtime/manifest-cache.ts";
import { createRunSnapshotCache } from "../../ui/run-snapshot-cache.ts";
import { type CrewWidgetState } from "../../ui/widget/index.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { type AsyncNotifierState } from "../async-notifier.ts";
import { type NotificationDescriptor } from "../notification-router.ts";
import { type LifecycleState } from "./lifecycle.ts";
import { type ObservabilityState } from "./observability.ts";
import { type RegistrationContext } from "./registration-types.ts";
import { sendFollowUp } from "./subagent-helpers.ts";
import { type UiState } from "./ui.ts";

/** Module-level slot for `disposeI18n` so the cleanup helpers can find it. */
const RUNTIME_CLEANUP_STORE_KEY = Symbol("__piCrewRuntimeCleanup");

/**
 * Build the mutable RegistrationContext. All state + bound closures
 * that the extracted modules need are hung off this object.
 *
 * The shape is built once with placeholder closures for fields that the
 * install* helpers under registration/ will rebind. Two of them
 * (`notifyOperator`, `getManifestCache`/`getRunSnapshotCache`) are
 * constructed inline because they only depend on the ctx itself, not
 * on later install steps.
 */
export function buildRegistrationContext(pi: ExtensionAPI): RegistrationContext {
	const ctx: RegistrationContext = {
		pi,
		currentCtx: undefined,
		sessionGeneration: 0,
		cleanedUp: false,
		rpcHandle: undefined,
		manifestCache: createManifestCache(process.cwd()),
		runSnapshotCache: createRunSnapshotCache(process.cwd()),
		cacheCwd: process.cwd(),
		getManifestCache: undefined as never,
		getRunSnapshotCache: undefined as never,
		widgetState: { frame: 0 } as CrewWidgetState,
		uiState: { liveSidebarRunId: undefined, dashboardOpened: false } as UiState,
		observabilityState: {
			metricRegistry: undefined,
			eventMetricSub: undefined,
			metricSink: undefined,
			heartbeatWatcher: undefined,
			autoRepairTimer: undefined,
			tempReconcileTimer: undefined,
			otlpExporter: undefined,
		} as ObservabilityState,
		lifecycleState: {
			notifierStarted: false,
			notificationSink: undefined,
			notificationRouter: undefined,
			deliveryCoordinator: undefined,
			overflowTracker: undefined,
		} as LifecycleState,
		notifierState: { seenFinishedRunIds: new Set() } as AsyncNotifierState,
		foregroundControllers: new Map(),
		foregroundTeamRunControllers: new Map(),
		renderScheduler: undefined,
		renderSchedulerUnsubscribers: [],
		terminalStatus: undefined,
		terminalStatusActive: false,
		crewScheduler: undefined,
		preloadTimer: undefined,
		crewRunWatchers: undefined,
		userCrewWatchers: undefined,
		subagentManager: undefined as never,
		batchBarrier: new BatchBarrier(),
		crewAutocompleteRegistered: false,
		autoRecoveryLast: new Map(),
		AUTO_RECOVERY_LAST_MAX_ENTRIES: 1000,
		disposeI18n: initI18n(pi),
		globalStore: globalThis as Record<string | symbol, unknown>,
		runtimeCleanupStoreKey: RUNTIME_CLEANUP_STORE_KEY,
		captureSessionGeneration: () => ctx.sessionGeneration,
		isOwnerSessionCurrent: (gen) => !ctx.cleanedUp && (gen === undefined || gen === ctx.sessionGeneration),
		isContextCurrent: (c, gen) => !ctx.cleanedUp && ctx.currentCtx === c && ctx.sessionGeneration === gen,
		telemetryEnabled: () =>
			loadConfig(ctx.currentCtx?.cwd ?? process.cwd()).config.telemetry?.enabled !== false,
		notifyOperator: undefined as never,
		cleanupSessionResourcesOnly: () => {},
		cleanupRuntime: () => {},
		disposeRenderSchedulerSubscriptions: () => {},
		stopSessionBoundSubagents: () => {},
		configureNotifications: () => {},
		configureObservability: () => {},
		configureDeliveryCoordinator: () => {},
		importCrashRecovery: undefined as never,
		purgeStaleActiveRunIndexSyncIfLoaded: () => {},
		startForegroundRun: undefined as never,
		abortForegroundRun: () => false,
		openLiveSidebar: () => {},
	};

	ctx.notifyOperator = (notification: NotificationDescriptor): void => {
		try {
			ctx.lifecycleState.notificationRouter?.enqueue(notification);
		} catch (error) {
			logInternalError("register.notification", error);
			void sendFollowUp(
				pi,
				[notification.title, notification.body]
					.filter((line): line is string => Boolean(line))
					.join("\n"),
			);
		}
	};

	ctx.getManifestCache = (cwd: string) => {
		if (ctx.manifestCache && ctx.cacheCwd === cwd) return ctx.manifestCache;
		if (ctx.manifestCache) ctx.manifestCache.dispose();
		if (ctx.runSnapshotCache) ctx.runSnapshotCache.dispose?.();
		ctx.cacheCwd = cwd;
		ctx.manifestCache = createManifestCache(cwd);
		ctx.runSnapshotCache = createRunSnapshotCache(cwd);
		return ctx.manifestCache;
	};
	ctx.getRunSnapshotCache = (cwd: string) => {
		if (ctx.cacheCwd !== cwd) ctx.getManifestCache(cwd);
		return ctx.runSnapshotCache;
	};

	return ctx;
}
