/**
 * Lifecycle installer (H3 + L2 — Phase 4 of cleanup plan).
 *
 * Owns the run-lifecycle subscriptions that should fire ONLY when a run is
 * active. This is the "lazy" half of H3 — the heavy heartbeat/auto-repair
 * graph stays out of cold start until a run actually starts.
 *
 * Extracted from src/extension/register.ts. State holder is `LifecycleState`;
 * installer is `startLifecycleWatchers(ctx, state, deps)` which fires on
 * session_start (when the first run becomes possible) and is no-op when
 * `activeRunCount === 0`.
 *
 * Also owns DeliveryCoordinator + OverflowRecoveryTracker + NotificationRouter
 * wiring since these are all "delivery lifecycle" services that share the
 * same per-session install/dispose pattern.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { DEFAULT_NOTIFICATIONS, DEFAULT_UI } from "../../config/defaults.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { projectCrewRoot } from "../../utils/paths.ts";
import type { AsyncNotifierState } from "../async-notifier.ts";
import type { NotificationDescriptor, NotificationRouter } from "../notification-router.ts";
import type { NotificationSink } from "../notification-sink.ts";
import { createWebhookNotifier } from "../webhook-notify.ts";

/**
 * Mutable state owned by register.ts and read/written by this module.
 * Tracks whether the async notifier is currently running so we can
 * safely no-op duplicate calls.
 */
export interface LifecycleState {
	notifierStarted: boolean;
	notificationSink: NotificationSink | undefined;
	notificationRouter: NotificationRouter | undefined;
	deliveryCoordinator: import("../../runtime/delivery-coordinator.ts").DeliveryCoordinator | undefined;
	overflowTracker: import("../../runtime/recovery/overflow-recovery.ts").OverflowRecoveryTracker | undefined;
}

/** Dependencies passed in by register.ts so this module stays decoupled. */
export interface LifecycleDeps {
	pi: ExtensionAPI;
	notifierState: AsyncNotifierState;
	isCleanedUp: () => boolean;
	isContextCurrent: (ctx: ExtensionContext, ownerGeneration: number) => boolean;
	ownerGeneration: number;
}

/**
 * Start the async-run notifier. Idempotent — repeated calls while running
 * are no-ops. Returns true if started now, false if already running or
 * skipped due to config gate.
 *
 * NOTE: This module does NOT start heartbeat watchers or auto-repair timers.
 * Those live in `observability.ts` (configurable + resource-heavy). This
 * module only manages the lightweight async-run poller.
 */
export function startLifecycleWatchers(ctx: ExtensionContext, state: LifecycleState, deps: LifecycleDeps): boolean {
	if (state.notifierStarted) return false;
	const loadedConfig = loadConfig(ctx.cwd);
	state.notifierStarted = true;
	try {
		// US-030 (docs/specs/US-030.md): outbound webhook sink built from config.
		// Gated on the notifications master switch (`notifications.enabled !== false`,
		// same gate as configureNotifications), opt-in per `webhook.url`, and
		// SSRF-guarded inside the factory. Inactive config → shared no-op
		// singleton (zero network calls, zero hot-path allocation).
		const notificationsConfig = loadedConfig.config.notifications;
		const webhookNotifier =
			notificationsConfig?.enabled === false
				? undefined
				: createWebhookNotifier(
						{ webhook: notificationsConfig?.webhook, quietHours: notificationsConfig?.quietHours },
						{
							onFailure: (failure) => {
								// Spec: failures surface as a `webhook.failed` event (crew.*-prefixed
								// pi event, mirroring crew.run.completed / crew.task.overflow).
								// logInternalError already fired inside the notifier.
								deps.pi.events?.emit?.("crew.webhook.failed", {
									runId: failure.runId,
									attempts: failure.attempts,
									error: failure.error,
								});
							},
						},
					);
		// LAZY: async-notifier pulls in debounce + cron helpers — defer
		// until the first lifecycle install (deferred import within module).
		void import("../async-notifier.ts").then(({ startAsyncRunNotifier }) => {
			if (deps.isCleanedUp()) return;
			startAsyncRunNotifier(ctx, deps.notifierState, loadedConfig.config.notifierIntervalMs ?? DEFAULT_UI.notifierIntervalMs, {
				generation: deps.ownerGeneration,
				isCurrent: (generation) => generation === deps.ownerGeneration && deps.isContextCurrent(ctx, deps.ownerGeneration),
				webhookNotifier,
			});
		});
		return true;
	} catch (error) {
		state.notifierStarted = false;
		logInternalError("register.startLifecycleWatchers", error);
		return false;
	}
}

/**
 * Stop the async-run notifier. Safe to call when not started.
 */
export function stopLifecycleWatchers(state: LifecycleState, deps: LifecycleDeps): void {
	if (!state.notifierStarted) return;
	state.notifierStarted = false;
	try {
		void import("../async-notifier.ts").then(({ stopAsyncRunNotifier }) => {
			stopAsyncRunNotifier(deps.notifierState);
		});
	} catch (error) {
		logInternalError("register.stopLifecycleWatchers", error);
	}
}

/** Dependencies for configureNotifications (UI-facing delivery wiring). */
export interface NotificationsDeps {
	pi: ExtensionAPI;
	widgetState: { notificationCount?: number };
	getCurrentCtx: () => ExtensionContext | undefined;
	getManifestCache: (cwd: string) => ReturnType<typeof import("../../runtime/manifest-cache.ts").createManifestCache>;
	getRunSnapshotCache: (cwd: string) => ReturnType<typeof import("../../ui/run-snapshot-cache.ts").createRunSnapshotCache>;
	requestPowerbarUpdate: (
		events: Parameters<typeof import("../../ui/powerbar-publisher.ts").requestPowerbarUpdate>[0],
		cwd: string,
		uiConfig: Parameters<typeof import("../../ui/powerbar-publisher.ts").requestPowerbarUpdate>[2],
		manifestCache: Parameters<typeof import("../../ui/powerbar-publisher.ts").requestPowerbarUpdate>[3],
		snapshotCache: Parameters<typeof import("../../ui/powerbar-publisher.ts").requestPowerbarUpdate>[4],
		ctx: ExtensionContext,
		notificationCount: number,
	) => void;
	/**
	 * F11 (RR-018): ownership predicate — true only while the session that
	 * started this configure is still current. Checked after every lazy-import
	 * await boundary before publishing into shared state. Optional for older
	 * hand-built deps; defaults to "still owner".
	 */
	isOwnerSession?: () => boolean;
}

/**
 * Configure the notification router + JSONL sink. Idempotent — caller should
 * dispose prior state first. Pulled out of register.ts as part of H3-L2.
 *
 * Gates:
 *  - `config.notifications?.enabled === false` → no-op.
 */
export async function configureNotifications(ctx: ExtensionContext, state: LifecycleState, deps: NotificationsDeps): Promise<void> {
	// F11 (RR-018): ownership predicate — re-verified after every await below.
	// A continuation whose session was cleaned up or superseded must not
	// publish resources into shared state. Optional so hand-built deps from
	// older call sites keep working (defaults to "still owner").
	const stillOwns = deps.isOwnerSession ?? (() => true);
	state.notificationRouter?.dispose();
	state.notificationSink?.dispose();
	state.notificationRouter = undefined;
	state.notificationSink = undefined;
	const config = loadConfig(ctx.cwd).config;
	if (config.notifications?.enabled === false) return;

	// LAZY: notification router — wires events to sinks
	const { NotificationRouter } = await import("../notification-router.ts");
	if (!stillOwns()) return;
	// LAZY: JSONL sink — file-backed notification storage
	const { createJsonlSink } = await import("../notification-sink.ts");
	if (!stillOwns()) return;
	// LAZY: follow-up helpers — shared with subagent handoff
	const { sendFollowUp } = await import("./subagent-helpers.ts");
	if (!stillOwns()) return;
	// LAZY: widget updater — refreshes the TUI status widget
	const { updateCrewWidget } = await import("../../ui/widget/index.ts");
	if (!stillOwns()) return;

	// F11: create into locals — publish only while ownership still holds.
	const notificationSink =
		config.telemetry?.enabled !== false
			? createJsonlSink(projectCrewRoot(ctx.cwd), config.notifications?.sinkRetentionDays ?? DEFAULT_NOTIFICATIONS.sinkRetentionDays)
			: undefined;
	const notificationRouter = new NotificationRouter(
		{
			dedupWindowMs: config.notifications?.dedupWindowMs ?? DEFAULT_NOTIFICATIONS.dedupWindowMs,
			batchWindowMs: config.notifications?.batchWindowMs ?? DEFAULT_NOTIFICATIONS.batchWindowMs,
			quietHours: config.notifications?.quietHours,
			severityFilter: config.notifications?.severityFilter ?? [...DEFAULT_NOTIFICATIONS.severityFilter],
			sink: (notification) => notificationSink?.write(notification),
		},
		(notification: NotificationDescriptor) => {
			if (notification.clear) {
				// Clear/dismiss: decrement the counter (floor 0) and skip the
				// follow-up message — this is a dismissal, not a new alert.
				deps.widgetState.notificationCount = Math.max(0, (deps.widgetState.notificationCount ?? 0) - 1);
			} else {
				deps.widgetState.notificationCount = (deps.widgetState.notificationCount ?? 0) + 1;
				sendFollowUp(
					deps.pi,
					[notification.title, notification.body, notification.runId ? `Run: ${notification.runId}` : undefined]
						.filter((line): line is string => Boolean(line))
						.join("\n"),
				);
			}
			const currentCtx = deps.getCurrentCtx();
			if (currentCtx) {
				const uiConfig = loadConfig(currentCtx.cwd).config.ui;
				updateCrewWidget(
					currentCtx,
					deps.widgetState as Parameters<typeof updateCrewWidget>[1],
					uiConfig,
					deps.getManifestCache(currentCtx.cwd),
					deps.getRunSnapshotCache(currentCtx.cwd),
				);
				deps.requestPowerbarUpdate(
					deps.pi.events,
					currentCtx.cwd,
					uiConfig,
					deps.getManifestCache(currentCtx.cwd),
					deps.getRunSnapshotCache(currentCtx.cwd),
					currentCtx,
					deps.widgetState.notificationCount ?? 0,
				);
			}
		},
	);
	if (!stillOwns()) {
		// F11: ownership lost while suspended — dispose what was just created
		// instead of publishing (no orphans).
		notificationRouter.dispose();
		notificationSink?.dispose();
		return;
	}
	state.notificationSink = notificationSink;
	state.notificationRouter = notificationRouter;
}

/** Dispose notification router + sink. */
export function disposeNotifications(state: LifecycleState): void {
	state.notificationRouter?.dispose();
	state.notificationRouter = undefined;
	state.notificationSink?.dispose();
	state.notificationSink = undefined;
}

/** Dependencies for configureDeliveryCoordinator. */
export interface DeliveryDeps {
	pi: ExtensionAPI;
	observabilityState: { metricRegistry?: import("../../observability/metric-registry.ts").MetricRegistry };
	notifyOperator: (notification: NotificationDescriptor) => void;
	sendFollowUp: (pi: ExtensionAPI, message: string) => void;
	sendAgentWakeUp: (pi: ExtensionAPI, message: string) => void;
	/** F11 (RR-018): same ownership predicate as NotificationsDeps.isOwnerSession. */
	isOwnerSession?: () => boolean;
}

/**
 * Configure the delivery coordinator + overflow tracker. Extracted from
 * register.ts as part of H3-L2 (delivery lifecycle service).
 */
export async function configureDeliveryCoordinator(state: LifecycleState, deps: DeliveryDeps): Promise<void> {
	// F11: ownership predicate — re-verified after the lazy imports below.
	const stillOwns = deps.isOwnerSession ?? (() => true);
	state.deliveryCoordinator?.dispose();
	state.deliveryCoordinator = undefined;
	state.overflowTracker?.dispose();
	state.overflowTracker = undefined;
	// LAZY: delivery coordinator — batches notification fan-out
	const { DeliveryCoordinator } = await import("../../runtime/delivery-coordinator.ts");
	if (!stillOwns()) return;
	// LAZY: overflow tracker — recovers from backlog overflow
	const { OverflowRecoveryTracker } = await import("../../runtime/recovery/overflow-recovery.ts");
	if (!stillOwns()) return;
	const deliveryCoordinator = new DeliveryCoordinator({
		emit: (event, data) => {
			deps.pi.events?.emit?.(event, data);
		},
		sendFollowUp: (title, body) => {
			deps.sendFollowUp(deps.pi, [title, body].filter((line): line is string => Boolean(line)).join("\n"));
		},
		sendWakeUp: (message) => {
			deps.sendAgentWakeUp(deps.pi, message);
		},
	});
	const overflowTracker = new OverflowRecoveryTracker({
		onPhaseChange: (phaseState, previousPhase) => {
			if (deps.observabilityState.metricRegistry) {
				deps.observabilityState.metricRegistry
					.counter("crew.task.overflow_recovery_total", "Overflow recovery phase transitions")
					.inc({
						phase: phaseState.phase,
						previous_phase: previousPhase,
					});
			}
			deps.pi.events?.emit?.("crew.task.overflow", {
				runId: phaseState.runId,
				taskId: phaseState.taskId,
				phase: phaseState.phase,
				previousPhase,
			});
		},
		onTimeout: (phaseState) => {
			deps.notifyOperator({
				id: `overflow_timeout_${phaseState.taskId}`,
				severity: "warning",
				source: "overflow-recovery",
				runId: phaseState.runId,
				title: `Task ${phaseState.taskId} overflow recovery timed out`,
				body: `Phase: ${phaseState.phase}, compaction_count: ${phaseState.compactionCount}, retry_count: ${phaseState.retryCount}. The task may be stuck.`,
			});
		},
	});
	if (!stillOwns()) {
		// F11: ownership lost while suspended — dispose what was just created
		// instead of publishing (no orphans).
		deliveryCoordinator.dispose();
		overflowTracker.dispose();
		return;
	}
	state.deliveryCoordinator = deliveryCoordinator;
	state.overflowTracker = overflowTracker;
}

/** Dispose delivery coordinator + overflow tracker. */
export function disposeDeliveryCoordinator(state: LifecycleState): void {
	state.deliveryCoordinator?.dispose();
	state.deliveryCoordinator = undefined;
	state.overflowTracker?.dispose();
	state.overflowTracker = undefined;
}
