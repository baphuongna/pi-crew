import type { NotificationDescriptor } from "../extension/notification-router.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { appendEvent } from "../state/event-log.ts";
import { loadRunManifestById } from "../state/state-store.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { ManifestCache } from "./manifest-cache.ts";
import { classifyHeartbeat, DEFAULT_GRADIENT_THRESHOLDS, heartbeatAgeMs, type GradientThresholds, type HeartbeatLevel } from "./heartbeat-gradient.ts";

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
	onDead?: (runId: string, taskId: string, elapsed: number) => void;
	onDeadletterTrigger?: (manifest: TeamRunManifest, taskId: string) => void;
}

export class HeartbeatWatcher {
	private timer?: ReturnType<typeof setInterval>;
	private lastLevel = new Map<string, HeartbeatLevel>();
	private consecutiveDead = new Map<string, number>();
	private readonly opts: HeartbeatWatcherOptions;

	constructor(opts: HeartbeatWatcherOptions) {
		this.opts = opts;
	}

	start(): void {
		this.dispose();
		this.timer = setInterval(() => this.tick(), this.opts.pollIntervalMs ?? 5000);
		this.timer.unref?.();
	}

	tick(now = Date.now()): void {
		const thresholds = this.opts.thresholds ?? DEFAULT_GRADIENT_THRESHOLDS;
		const tickThreshold = this.opts.deadletterTickThreshold ?? 3;
		for (const run of this.opts.manifestCache.list(50)) {
			if (run.status !== "running") continue;
			const loaded = loadRunManifestById(this.opts.cwd, run.runId);
			if (!loaded) continue;
			for (const task of loaded.tasks) {
				if (task.status !== "running") continue;
				const key = `${run.runId}:${task.id}`;
				const elapsed = heartbeatAgeMs(task.heartbeat, now);
				const level = classifyHeartbeat(task.heartbeat, thresholds, now);
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
					if (count === tickThreshold) this.opts.onDeadletterTrigger?.(loaded.manifest, task.id);
				} else {
					this.consecutiveDead.delete(key);
				}
			}
		}
		// Remove stale entries for tasks that are no longer running.
		const activeKeys = new Set<string>();
		for (const run of this.opts.manifestCache.list(50)) {
			const loaded = loadRunManifestById(this.opts.cwd, run.runId);
			if (!loaded) continue;
			for (const task of loaded.tasks) {
				if (task.status === "running") activeKeys.add(`${run.runId}:${task.id}`);
			}
		}
		for (const key of this.lastLevel.keys()) if (!activeKeys.has(key)) this.lastLevel.delete(key);
		for (const key of this.consecutiveDead.keys()) if (!activeKeys.has(key)) this.consecutiveDead.delete(key);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.lastLevel.clear();
		this.consecutiveDead.clear();
	}
}
