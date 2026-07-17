/**
 * Observability installer (H3 + L2 — Phase 4 of cleanup plan).
 *
 * Owns the observability lifecycle for the pi-crew extension:
 *   - MetricRegistry + EventToMetricSubscription (wireEventToMetrics)
 *   - Metric file sink (JSONL writer)
 *   - OTLPExporter (lazy-imported when otlp.enabled=true)
 *   - HeartbeatWatcher (per-session, polling)
 *   - Auto-repair timers (stale-reconcile + orphan-temp-dirs cleanup)
 *
 * Extracted from src/extension/register.ts so the orchestrator stays thin.
 * The module exports `ObservabilityState` (mutable state holder) and
 * `configureObservability(ctx, state, deps)` (the install function). The
 * orchestrator keeps ownership of `state` so cleanupRuntime can dispose
 * via `disposeObservability(state, isCleanedUp)`.
 *
 * This file is a TARGET for lazy loading (H3 follow-up): on systems where
 * observability.enabled === false, `installObservability()` is never
 * imported — the heavy observability module graph stays out of cold start.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import type { EventToMetricSubscription } from "../../observability/event-to-metric.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import type { MetricSink } from "../../observability/metric-sink.ts";
import type { HeartbeatWatcher } from "../../runtime/heartbeat-watcher.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { projectCrewRoot } from "../../utils/paths.ts";
import type { NotificationDescriptor } from "../notification-router.ts";

/** Type-only alias for the lazy-loaded OTLPExporter (avoid static import). */
type OTLPExporterInstance = import("../../observability/exporters/otlp-exporter.ts").OTLPExporter;
type OTLPExporterCtor = new (
	opts: import("../../observability/exporters/otlp-exporter.ts").OTLPExporterOptions,
	registry: import("../../observability/metric-registry.ts").MetricRegistry,
) => OTLPExporterInstance;

/**
 * Mutable state owned by register.ts and read/written by this module.
 * Pass this same object to `configureObservability` and `disposeObservability`
 * so they can mutate the fields in-place.
 */
export interface ObservabilityState {
	metricRegistry: MetricRegistry | undefined;
	eventMetricSub: EventToMetricSubscription | undefined;
	metricSink: MetricSink | undefined;
	heartbeatWatcher: HeartbeatWatcher | undefined;
	autoRepairTimer: ReturnType<typeof setInterval> | undefined;
	tempReconcileTimer: ReturnType<typeof setInterval> | undefined;
	otlpExporter: OTLPExporterInstance | undefined;
}

/** Dependencies passed in by register.ts so this module stays decoupled. */
export interface ObservabilityDeps {
	pi: ExtensionAPI;
	getManifestCache: (cwd: string) => ReturnType<typeof import("../../runtime/manifest-cache.ts").createManifestCache>;
	notifyOperator: (notification: NotificationDescriptor) => void;
	isCleanedUp: () => boolean;
	reconcileStaleRuns: (cwd: string, cache: ReturnType<ObservabilityDeps["getManifestCache"]>) => unknown[];
	reconcileOrphanedTempWorkspaces: (now: number, opts: { cleanupOrphanedTempDirs?: boolean }) => unknown;
	cleanupOrphanTempDirs: () => { cleaned: number; scanned: number; failed: number };
	cleanupLegacyOrphanTempDirs: () => { cleaned: number; scanned: number; failed: number };
	appendDeadletter: (
		manifest: import("../../state/types.ts").TeamRunManifest,
		entry: { taskId: string; runId: string; reason: string; attempts: number; timestamp: string },
	) => void;
	importCrashRecovery: () => Promise<{
		detectInterruptedRuns: (
			cwd: string,
			cache: ReturnType<ObservabilityDeps["getManifestCache"]>,
		) => Iterable<{ runId: string; resumableTasks: unknown[] }>;
	}>;
}

let _cachedOTLPExporter: OTLPExporterCtor | undefined;
async function importOTLPExporter(): Promise<OTLPExporterCtor> {
	if (!_cachedOTLPExporter) {
		// LAZY: opt-in OTLP metric export — load only when otlp.enabled=true.
		const mod = await import("../../observability/exporters/otlp-exporter.ts");
		_cachedOTLPExporter = mod.OTLPExporter as unknown as OTLPExporterCtor;
	}
	return _cachedOTLPExporter;
}

/**
 * Configure the observability stack for the current session. Idempotent
 * (caller should call `disposeObservability` first on each session_start
 * cycle to avoid stacking watchers).
 *
 * Gates:
 *  - `config.observability?.enabled === false` → no-op (skips all init).
 *  - `config.telemetry?.enabled !== false` → installs metric file sink.
 *  - `config.otlp?.enabled === true` → lazy-loads OTLPExporter.
 *  - `config.reliability?.autoRepairIntervalMs > 0` → starts reconcile timers.
 *  - `config.reliability?.autoRecover === true` → lazy-imports crash-recovery
 *    on a deferred setTimeout to avoid blocking session_start.
 */
export async function configureObservability(ctx: ExtensionContext, state: ObservabilityState, deps: ObservabilityDeps): Promise<void> {
	// Always start from a clean slate: dispose any prior-session state first.
	await disposeObservability(state, deps.isCleanedUp());

	const config = loadConfig(ctx.cwd).config;
	if (config.observability?.enabled === false) return;

	// LAZY: observability stack — only paid for when observability is actually enabled
	const { createMetricRegistry } = await import("../../observability/metric-registry.ts");
	// LAZY: event→metric bridge
	const { wireEventToMetrics } = await import("../../observability/event-to-metric.ts");
	// LAZY: file-backed metric sink
	const { createMetricFileSink } = await import("../../observability/metric-sink.ts");

	state.metricRegistry = createMetricRegistry();
	if (deps.pi.events) {
		state.eventMetricSub = wireEventToMetrics(deps.pi.events, state.metricRegistry);
	}
	if (config.telemetry?.enabled !== false) {
		state.metricSink = createMetricFileSink({
			crewRoot: projectCrewRoot(ctx.cwd),
			registry: state.metricRegistry,
			retentionDays: config.observability?.metricRetentionDays ?? 7,
		});
	}

	// OTLP export is opt-in. Lazy-loaded via dynamic import.
	if (config.otlp?.enabled === true && config.otlp.endpoint) {
		const otlpEndpoint = config.otlp.endpoint;
		const otlpHeaders = config.otlp.headers;
		const otlpInterval = config.otlp.intervalMs;
		const owningRegistry = state.metricRegistry;
		// LAZY: opt-in OTLP export — load the exporter module on first enable.
		void importOTLPExporter()
			.then((Ctor) => {
				if (deps.isCleanedUp() || state.metricRegistry !== owningRegistry || !owningRegistry) return;
				state.otlpExporter = new Ctor(
					{
						endpoint: otlpEndpoint,
						headers: otlpHeaders,
						intervalMs: otlpInterval,
					},
					owningRegistry,
				);
				state.otlpExporter?.start();
			})
			.catch((error: unknown) => logInternalError("register.otlp-lazy-import", error));
	}

	// LAZY: heartbeat watcher — polled per-session, wires deadletter + metric events.
	const { HeartbeatWatcher } = await import("../../runtime/heartbeat-watcher.ts");
	state.heartbeatWatcher = new HeartbeatWatcher({
		cwd: ctx.cwd,
		pollIntervalMs: config.observability?.pollIntervalMs ?? 5000,
		manifestCache: deps.getManifestCache(ctx.cwd),
		registry: state.metricRegistry,
		router: {
			enqueue: (notification) => {
				deps.notifyOperator(notification);
				return true;
			},
		},
		deadletterTickThreshold: config.reliability?.deadletterThreshold ?? 3,
		onDeadletterTrigger: (manifest, taskId) => {
			deps.appendDeadletter(manifest, {
				taskId,
				runId: manifest.runId,
				reason: "heartbeat-dead",
				attempts: 0,
				timestamp: new Date().toISOString(),
			});
			state.metricRegistry?.counter("crew.task.deadletter_total", "Deadletter triggers by reason").inc({ reason: "heartbeat-dead" });
			deps.pi.events?.emit?.("crew.task.deadletter", {
				runId: manifest.runId,
				taskId,
				reason: "heartbeat-dead",
			});
		},
	});
	state.heartbeatWatcher.start();

	// RT-F2: opportunistic stale-run reconcile hook.
	// The .unref()'d setInterval below never fires while the event loop is idle
	// (e.g. user has the editor open but hasn't sent a turn in an hour). Pair it
	// with a before_agent_start hook so reconcileAllStaleRuns also fires when
	// the user actually drives the session — bounded by user activity.
	try {
		deps.pi.on?.("before_agent_start", () => {
			if (deps.isCleanedUp()) return;
			try {
				deps.reconcileStaleRuns(ctx.cwd, deps.getManifestCache(ctx.cwd));
			} catch (error) {
				logInternalError("register.autoRepair.turnHook", error);
			}
		});
	} catch {
		/* older Pi without before_agent_start — rely on the interval alone */
	}

	// Auto-repair timers: stale-run reconcile + orphan-temp cleanup.
	// RT-F2: default raised from 60_000ms to 5 minutes (300_000ms). The previous
	// 60s default was wasted work for idle sessions (Pi never had a UI to render
	// between user turns), and .unref() meant it never fired at all when the
	// event loop was idle. 5min balances "catch up after idle gap" against
	// "don't waste cycles on sessions that aren't doing anything". The
	// before_agent_start hook above covers the user-active case.
	const autoRepairIntervalMs = config.reliability?.autoRepairIntervalMs ?? 300_000;
	if (autoRepairIntervalMs > 0) {
		state.autoRepairTimer = setInterval(() => {
			if (deps.isCleanedUp()) return;
			try {
				const staleResults = deps.reconcileStaleRuns(ctx.cwd, deps.getManifestCache(ctx.cwd));
				if (Array.isArray(staleResults) && staleResults.length > 0) {
					for (const result of staleResults) {
						const repaired = (result as { repaired?: boolean }).repaired;
						if (repaired) {
							deps.notifyOperator({
								id: `auto_repair_${(result as { runId: string }).runId}`,
								severity: "info",
								source: "auto-repair",
								runId: (result as { runId: string }).runId,
								title: `Auto-repaired stale run`,
								body: (result as { detail?: string }).detail ?? "",
							});
						}
					}
				}
			} catch (error) {
				logInternalError("register.autoRepair", error);
			}
		}, autoRepairIntervalMs);
		state.autoRepairTimer.unref();

		// Less frequent (5x interval) — clean orphan temp dirs.
		state.tempReconcileTimer = setInterval(() => {
			if (deps.isCleanedUp()) return;
			try {
				deps.reconcileOrphanedTempWorkspaces(Date.now(), {
					cleanupOrphanedTempDirs:
						typeof config.reliability?.cleanupOrphanedTempDirs === "boolean"
							? config.reliability.cleanupOrphanedTempDirs
							: undefined,
				});
				const orphanResult = deps.cleanupOrphanTempDirs();
				if (orphanResult.cleaned > 0) {
					deps.notifyOperator({
						id: `layer4_temp_cleanup_${Date.now()}`,
						severity: "info",
						source: "temp-cleanup",
						title: `Layer 4: cleaned ${orphanResult.cleaned} orphan temp dir(s)`,
						body: `~/.pi/agent/pi-crew/tmp/ orphans older than 24h removed (scanned ${orphanResult.scanned}, failed ${orphanResult.failed}).`,
					});
				}
				const legacyResult = deps.cleanupLegacyOrphanTempDirs();
				if (legacyResult.cleaned > 0) {
					deps.notifyOperator({
						id: `layer5_legacy_temp_cleanup_${Date.now()}`,
						severity: "info",
						source: "temp-cleanup",
						title: `Layer 5: cleaned ${legacyResult.cleaned} legacy /tmp/pi-crew-* orphan(s)`,
						body: `Pre-fix /tmp/pi-crew-* prompt/task orphans (no .crew/state/runs/, >24h) removed (scanned ${legacyResult.scanned}, failed ${legacyResult.failed}).`,
					});
				}
			} catch (error) {
				logInternalError("register.tempAutoRepair", error);
			}
		}, autoRepairIntervalMs * 5);
		state.tempReconcileTimer.unref();
	}

	// autoRecover → on session_start, lazy-import crash-recovery and prompt the
	// operator about interrupted runs. Defers to a microtask so it never blocks
	// session_start.
	if (config.reliability?.autoRecover === true) {
		const cwdSnapshot = ctx.cwd;
		const cacheSnapshot = deps.getManifestCache(cwdSnapshot);
		void deps
			.importCrashRecovery()
			.then(({ detectInterruptedRuns }) => {
				if (deps.isCleanedUp()) return;
				for (const plan of detectInterruptedRuns(cwdSnapshot, cacheSnapshot)) {
					deps.notifyOperator({
						id: `recovery_prompt_${plan.runId}`,
						severity: "warning",
						source: "crash-recovery",
						runId: plan.runId,
						title: `Run ${plan.runId} was interrupted`,
						body: `${plan.resumableTasks.length} tasks pending recovery. Open dashboard to inspect before resuming.`,
					});
				}
			})
			.catch((error: unknown) => logInternalError("register.crash-recovery-lazy-import", error));
	}
}

/**
 * Dispose all observability resources. Safe to call when state is already
 * partially or fully disposed. Caller passes `isCleanedUp` so timers can be
 * gated by the orchestrator's overall cleanup state.
 */
export async function disposeObservability(state: ObservabilityState, _isCleanedUp: boolean): Promise<void> {
	state.heartbeatWatcher?.dispose();
	state.heartbeatWatcher = undefined;
	if (state.autoRepairTimer) {
		clearInterval(state.autoRepairTimer);
		state.autoRepairTimer = undefined;
	}
	if (state.tempReconcileTimer) {
		clearInterval(state.tempReconcileTimer);
		state.tempReconcileTimer = undefined;
	}
	state.metricSink?.dispose();
	state.metricSink = undefined;
	state.eventMetricSub?.dispose();
	state.eventMetricSub = undefined;
	// OBS-3: await OTLPExporter.dispose() so an in-flight HTTP push isn't cut short on
	// shutdown (interface contract changed to Promise<void>; OTLPExporter awaits its
	// in-flight push). The async work still completes even when callers discard the
	// returned promise (fire-and-forget cleanup), because Node keeps the event loop
	// alive for pending I/O.
	await state.otlpExporter?.dispose();
	state.otlpExporter = undefined;
	state.metricRegistry?.dispose();
	state.metricRegistry = undefined;
}
