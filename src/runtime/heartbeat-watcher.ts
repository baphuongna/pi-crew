import * as fs from "node:fs";
import type { NotificationDescriptor } from "../extension/notification-router.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { appendEvent } from "../state/event-log.ts";
import { loadRunManifestById } from "../state/state-store.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { ManifestCache } from "./manifest-cache.ts";
import { DEFAULT_GRADIENT_THRESHOLDS, heartbeatAgeMs, type GradientThresholds, type HeartbeatLevel } from "./heartbeat-gradient.ts";

export interface HeartbeatWatcherRouter {
	enqueue(notification: NotificationDescriptor): boolean;
}

export interface HeartbeatWatcherOptions {
	cwd: string;
	pollIntervalMs?: number;
	thresholds?: GradientThresholds;
	manifestCache: ManifestCache;
	registry: MetricRegistry;
	router: HeartbeatWatcherRouter;
	deadletterTickThreshold?: number;
	/**
	 * 3.6 — minimum interval between repeated deadletter triggers for the same
	 * runId+taskId. Without this, a flaky worker (dead → alive → dead) can
	 * fire deadletter entries faster than the operator can respond. Default
	 * 60_000 ms.
	 */
	deadletterCooldownMs?: number;
	onDead?: (runId: string, taskId: string, elapsed: number) => void;
	onDeadletterTrigger?: (manifest: TeamRunManifest, taskId: string) => void;
}

/**
 * Polls running runs for heartbeat staleness.
 *
 * Uses recursive setTimeout to avoid timer storms.
 * Cleanup is done in the same pass — no second scan over manifests.
 * Keys for runs that disappear from the cache are cleaned via staleness-age policy
 * rather than being leaked forever.
 */
export class HeartbeatWatcher {
	private timer?: ReturnType<typeof setTimeout>;
	private lastLevel = new Map<string, HeartbeatLevel>();
	private consecutiveDead = new Map<string, number>();
	private lastSeen = new Map<string, number>(); // key → last time it was active
	private lastDeadletterTriggerAt = new Map<string, number>(); // 3.6 cooldown gate
	/** Max age (ms) to retain a stale key before garbage-collecting it. */
	private readonly maxKeyAgeMs = 600_000; // 10 minutes
	private readonly opts: HeartbeatWatcherOptions;

	constructor(opts: HeartbeatWatcherOptions) {
		this.opts = opts;
	}

	start(): void {
		this.dispose();
		this.scheduleTick();
	}

	private scheduleTick(): void {
		// 3.2 — when at least one run has a dead-streak in progress, poll faster
		// (1s) so operators get notified quickly. Healthy state stays at the
		// configured interval (default 5s) to keep idle CPU near zero.
		const baseInterval = this.opts.pollIntervalMs ?? 5000;
		const interval = this.consecutiveDead.size > 0 ? Math.min(1000, baseInterval) : baseInterval;
		this.timer = setTimeout(() => this.tick(), interval);
		this.timer.unref();
	}

	tick(now = Date.now()): void {
		try {
			this.tickUnsafe(now);
		} catch (error) {
			logInternalError("heartbeat-watcher.tick", error);
		} finally {
			this.scheduleTick();
		}
	}

	private tickUnsafe(now: number): void {
		const thresholds = this.opts.thresholds ?? DEFAULT_GRADIENT_THRESHOLDS;
		const tickThreshold = this.opts.deadletterTickThreshold ?? 3;
		const activeKeys = new Set<string>();

		for (const run of this.opts.manifestCache.list(50)) {
			if (run.status !== "running") continue;
			// Bug #5 fix: if stateRoot doesn't exist, the run was pruned — skip it silently.
			// This prevents stale "heartbeat dead" notifications for runs that no longer exist.
			if (!fs.existsSync(run.stateRoot)) continue;
			const loaded = loadRunManifestById(this.opts.cwd, run.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
			if (!loaded) continue;
			for (const task of loaded.tasks) {
				if (task.status !== "running") continue;
				const key = `${run.runId}:${task.id}`;
				activeKeys.add(key);
				this.lastSeen.set(key, now);

				// Check heartbeat staleness with lastActivityAt fallback
				let elapsed = heartbeatAgeMs(task.heartbeat, now);
				// PR #6 partial: use lastActivityAt as fallback when heartbeat is stale
				// If heartbeat is stale but lastActivityAt is fresher, use activity age instead.
				// This prevents false-positive dead detection for live-session tasks during long operations.
				if (task.agentProgress?.lastActivityAt) {
					const activityAt = new Date(task.agentProgress.lastActivityAt).getTime();
					if (Number.isFinite(activityAt)) {
						const activityAge = now - activityAt;
						// Use activity age if it's fresher than heartbeat age
						// (no upper bound - if agent has recent activity, trust it even if old)
						if (activityAge < elapsed) {
							elapsed = activityAge;
						}
					}
				}
				// PID liveness gate: if the worker process is still alive, downgrade
				// "dead" to "stale". This prevents false positives when the LLM spends
				// a long time generating a response (>5 min) without tool calls.
				// A truly dead process will eventually be detected by exit handlers.
				let isProcessAlive = false;
				const workerPid = task.heartbeat?.pid ?? task.checkpoint?.childPid;
				if (workerPid && workerPid > 0) {
					try {
						process.kill(workerPid, 0);
						isProcessAlive = true;
					} catch {
						// Process is dead
					}
				}
				let level: HeartbeatLevel = elapsed > thresholds.deadMs ? "dead" : elapsed > thresholds.staleMs ? "stale" : elapsed > thresholds.warnMs ? "warn" : "healthy";
				if (level === "dead" && isProcessAlive) {
					level = "stale";
				}
				this.opts.registry.gauge("crew.heartbeat.staleness_ms", "Heartbeat elapsed since last seen, milliseconds").set({ runId: run.runId, taskId: task.id }, Number.isFinite(elapsed) ? elapsed : thresholds.deadMs);
				this.opts.registry.counter("crew.heartbeat.level_total", "Heartbeat classifications by level").inc({ runId: run.runId, level });
				const previous = this.lastLevel.get(key);
				this.lastLevel.set(key, level);
				if (level === "dead" && previous !== "dead") {
					this.opts.registry.counter("crew.heartbeat.dead_total", "Dead heartbeat detections").inc({ runId: run.runId });
					appendEvent(loaded.manifest.eventsPath, { type: "crew.task.heartbeat_dead", runId: run.runId, taskId: task.id, message: `Task ${task.id} heartbeat dead.`, data: { elapsedMs: Number.isFinite(elapsed) ? elapsed : undefined } });
					this.opts.router.enqueue({ id: `dead_${run.runId}_${task.id}`, severity: "warning", source: "heartbeat-watcher", runId: run.runId, title: `Task ${task.id} heartbeat dead`, body: "Background watcher detected a stuck worker." });
					this.opts.onDead?.(run.runId, task.id, Number.isFinite(elapsed) ? elapsed : thresholds.deadMs);
				}
				if (level === "dead") {
					const count = (this.consecutiveDead.get(key) ?? 0) + 1;
					this.consecutiveDead.set(key, count);
					if (count === tickThreshold) {
						// 3.6 cooldown gate
						const cooldown = this.opts.deadletterCooldownMs ?? 60_000;
						const lastTrigger = this.lastDeadletterTriggerAt.get(key) ?? 0;
						if (now - lastTrigger >= cooldown) {
							this.lastDeadletterTriggerAt.set(key, now);
							this.opts.onDeadletterTrigger?.(loaded.manifest, task.id);
						}
					}
				} else {
					this.consecutiveDead.delete(key);
				}
			}
		}

		// Cleanup: drop keys that were NOT in this tick's active set AND
		// haven't been seen for > maxKeyAgeMs.  This covers runs that
		// completed or fell out of the manifest cache's top-50 window.
		const cutoff = now - this.maxKeyAgeMs;
		for (const [key, ts] of this.lastSeen) {
			if (!activeKeys.has(key) && ts < cutoff) {
				this.lastLevel.delete(key);
				this.consecutiveDead.delete(key);
				this.lastSeen.delete(key);
			}
		}
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.lastLevel.clear();
		this.consecutiveDead.clear();
		this.lastSeen.clear();
	}
}
