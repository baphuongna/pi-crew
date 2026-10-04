/**
 * setupRenderLoop — the per-session render pipeline (RenderScheduler +
 * preload loop + bounded run watchers + health-notification gates) plus the
 * pure frame helpers it shares. Extracted verbatim from
 * lifecycle-handlers.ts (QW#2, deep review 2026-10-01) so the lifecycle
 * module stays focused on session_start/shutdown/before_switch wiring.
 *
 * The loop itself is driven end-to-end through
 * `installSessionLifecycleHandlers` (see preload-idle-render.test.ts); the
 * exported pure helpers are pinned directly by
 * test/unit/extension/registration/lifecycle-health-filter.test.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { DEFAULT_UI } from "../../config/defaults.ts";
import { forgetDetachedRun, hasDetachedRuns, peekFinishedDetachedRunResults } from "../../runtime/detached-run-results.ts";
import { listLiveAgents } from "../../runtime/live-session/live-agent-manager.ts";
import type { createManifestCache } from "../../runtime/manifest-cache.ts";
import { loadTasksWithRecovery } from "../../state/stores/manifest-io.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { overlayFreshTaskStatuses, summarizeHeartbeats } from "../../ui/heartbeat-aggregator.ts";
import { requestRender, setExtensionWidget, toPiWidgetPlacement } from "../../ui/pi-ui-compat.ts";
import { requestPowerbarUpdate } from "../../ui/powerbar-publisher.ts";
import { RenderScheduler } from "../../ui/render-scheduler.ts";
import { runEventBus } from "../../ui/run-event-bus.ts";
import type { createRunSnapshotCache } from "../../ui/run-snapshot-cache.ts";
import { updateCrewWidget } from "../../ui/widget/index.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../../utils/paths.ts";
import { RunWatcherRegistry } from "../../utils/run-watcher-registry.ts";
import { healthNotifyFingerprint, recordHealthNotifyDecision, resetHealthNotifyEntry } from "./health-notify-policy.ts";
import type { RegistrationContext } from "./registration-types.ts";
import { purgeQueuedAmbientNotifications } from "./subagent-helpers.ts";

/**
 * Hand over the outcome of runs detached by an agent-view switch.
 *
 * Delivered as a DISPLAYED session entry (not a follow-up queue item): an idle
 * session never flushes a follow-up, so the queued variant left the result
 * invisible. Each result is dropped from the registry only after its send
 * succeeded, and only while the owning session is current — a worker's view
 * session must never receive the parent run's report.
 */
export function deliverDetachedRunResults(pi: ExtensionAPI, extensionCtx: ExtensionContext): void {
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
 * F14 (RR-019): cheap signature of the preloaded-manifest frame. Only a
 * CHANGED signature lets `backgroundPreload` count as render activity
 * (`schedule()`); an identical signature means "nothing the widget would
 * paint differently" and must NOT reset the render scheduler's idle
 * counters (that defeated the R1 idle stop — see setupRenderLoop). Covers
 * run identity, status transitions, and updatedAt bumps. Exported for tests.
 */
export function manifestsFrameSignature(manifests: TeamRunManifest[]): string {
	return manifests.map((m) => `${m.runId}:${m.status}:${m.updatedAt}`).join("|");
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
export function setupRenderLoop(
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
	// F14: signature of the last frame backgroundPreload saw — only a change
	// here counts as render activity.
	let lastFrameSignature: string | undefined;

	const ownerGeneration = ctx.sessionGeneration;

	const buildFrame = async (): Promise<{ ok: boolean; changed: boolean }> => {
		if (!ctx.currentCtx) return { ok: false, changed: false };
		lastPreloadedConfig = loadConfig(ctx.currentCtx.cwd);
		lastFrameManifestCache = ctx.getManifestCache(ctx.currentCtx.cwd);
		lastFrameSnapshotCache = ctx.getRunSnapshotCache(ctx.currentCtx.cwd);
		const manifests = lastFrameManifestCache.list(20);
		lastPreloadedManifests = manifests;
		// F14 (RR-019): compute the frame signature BEFORE the preload await so
		// `changed` reflects what this tick saw, not a mid-preload mutation.
		const frameSignature = manifestsFrameSignature(manifests);
		const frameChanged = frameSignature !== lastFrameSignature;
		lastFrameSignature = frameSignature;
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
		return { ok: true, changed: frameChanged };
	};

	const backgroundPreload = (): void => {
		if (!ctx.currentCtx || preloading) return;
		preloading = true;
		buildFrame()
			.then(({ ok, changed }) => {
				preloading = false;
				// F14 (RR-019): preload completion is maintenance, NOT user activity.
				// Only a genuinely CHANGED frame may call schedule() — an unchanged
				// frame calling schedule() reset `lastEventAt`/`idleFallbackRenders`
				// and re-armed the fallback loop that fallbackLoop() had just
				// deliberately stopped (R1), rendering forever while idle. Real
				// work still animates: runEventBus + fs.watch subscriptions call
				// schedule() directly on genuine events.
				if (ok && changed) ctx.renderScheduler?.schedule();
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
				// FINDING 6: reset the fire budget (a genuine recurrence after
				// this clear re-notifies) AND opportunistically purge
				// still-QUEUED host follow-up copies of the original warning —
				// the host drains the queue one message per turn boundary, so
				// stale copies otherwise drip in for hours after the clear
				// (live: 5h of "missing heartbeat" replays after the 2026-09-23
				// zombie cleanup). The purge is feature-detected: hosts without
				// clearQueuedUserMessagesMatching (e.g. 0.87.0) no-op here; the
				// fire-cap policy bounds the backlog on every host.
				resetHealthNotifyEntry({ entries: ctx.autoRecoveryLast, maxEntries: ctx.AUTO_RECOVERY_LAST_MAX_ENTRIES }, key);
				ctx.notifyOperator({
					id: key,
					clear: true,
					severity: "info",
					source: "health",
					runId,
					title: `Cleared ${kind} for ${runId}`,
				});
				purgeQueuedAmbientNotifications(
					pi,
					(text) => text.includes(runId) && (text.includes("dead worker") || text.includes("missing heartbeat")),
				);
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
				// GATE 3 (FINDING 5) — task-status truth lives on DISK, not in the
				// snapshot cache. A worker parked on `ask` writes running → waiting
				// to tasks.json immediately, but the cached snapshot can lag that
				// transition; in the window a parked (alive, silent-by-design)
				// worker counted as active-without-heartbeat and fired a false
				// "dead worker" (live: team_20260923100114, 01_explore parked on
				// ask). Overlay FRESH statuses before summarizing; divergence also
				// invalidates the stale cache entry so the next tick rebuilds it.
				const freshTasks = loadTasksWithRecovery(freshManifest.tasksPath, freshManifest.eventsPath, run.runId);
				const overlaid = overlayFreshTaskStatuses(snapshot, freshTasks);
				if (overlaid !== snapshot) snapshotCache.invalidate(run.runId);
				const summary = summarizeHeartbeats(overlaid, { now });
				const fingerprint = healthNotifyFingerprint(summary, overlaid.tasks.length);
				const maybeNotifyHealth = (kind: string, count: number, title: string, body: string): void => {
					if (count <= 0) return;
					const key = `${kind}_${run.runId}`;
					// FINDING 6: bounded re-fire — ≤ MAX_HEALTH_NOTIFY_FIRES per
					// UNCHANGED fingerprint (5-min cooldown between fires). The
					// old forever-re-arming cooldown fed the host follow-up queue
					// duplicates that drained one-per-turn-boundary for hours.
					// Policy detail + LRU eviction: health-notify-policy.ts.
					const state = { entries: ctx.autoRecoveryLast, maxEntries: ctx.AUTO_RECOVERY_LAST_MAX_ENTRIES };
					if (!recordHealthNotifyDecision(state, key, fingerprint, now)) return;
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
