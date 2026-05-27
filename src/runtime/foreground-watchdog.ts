/**
 * Foreground run watchdog — periodically checks that active foreground runs
 * are making progress and auto-notifies the assistant if a run appears hung.
 *
 * Problem: foreground runs run in background via startForegroundRun(). The Pi
 * assistant has no way to know when a run completes or gets stuck without
 * manual polling. This watchdog monitors active runs and:
 *
 * 1. Detects hung runs (active status, no heartbeat update for >10 min)
 * 2. Injects a followUp message via pi.sendUserMessage() so the assistant
 *    is automatically notified — no manual sleep+check needed.
 * 3. Cleans up after itself when the run completes or the session ends.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRunManifestById } from "../state/state-store.ts";
import { readCrewAgents } from "./crew-agent-records.ts";
import { isActiveRunStatus, isLikelyOrphanedActiveRun } from "./process-status.ts";

export interface WatchdogOptions {
	pi: ExtensionAPI;
	cwd: string;
	runId: string;
	/** Check interval in ms. Default: 5 minutes. */
	checkIntervalMs?: number;
	/** Maximum time to monitor in ms. Default: 2 hours. */
	maxMonitorMs?: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 300_000; // 5 minutes
const DEFAULT_MAX_MONITOR_MS = 7_200_000; // 2 hours

/** Active watchdog timers — keyed by runId for cleanup. */
const activeWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

/** Stop a specific watchdog by runId. */
export function stopWatchdog(runId: string): void {
	const timer = activeWatchdogs.get(runId);
	if (timer) {
		clearTimeout(timer);
		activeWatchdogs.delete(runId);
	}
}

/** Stop all active watchdogs. Called on session shutdown. */
export function stopAllWatchdogs(): void {
	for (const [runId, timer] of activeWatchdogs) {
		clearTimeout(timer);
	}
	activeWatchdogs.clear();
}

/**
 * Start a periodic watchdog for a foreground run.
 * Checks at regular intervals whether the run is still progressing.
 * If the run appears hung (no update for >10 min with no active agents),
 * injects a followUp message into the Pi conversation.
 *
 * Automatically stops when:
 * - The run reaches a terminal status (completed/failed/cancelled)
 * - The max monitor time is exceeded
 * - Explicitly stopped via stopWatchdog()
 */
export function startForegroundWatchdog(opts: WatchdogOptions): void {
	const { pi, cwd, runId } = opts;
	const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
	const maxMonitorMs = opts.maxMonitorMs ?? DEFAULT_MAX_MONITOR_MS;
	const startTime = Date.now();

	// Don't stack watchdogs for the same run
	if (activeWatchdogs.has(runId)) return;

	const check = (): void => {
		// Check if max monitor time exceeded
		if (Date.now() - startTime > maxMonitorMs) {
			activeWatchdogs.delete(runId);
			return;
		}

		try {
			const loaded = loadRunManifestById(cwd, runId);
			if (!loaded) {
				// Run not found — stop watchdog
				activeWatchdogs.delete(runId);
				return;
			}

			const { manifest } = loaded;

			// Terminal status — send completion notification and stop
			if (!isActiveRunStatus(manifest.status)) {
				const teamName = manifest.team ?? "unknown";
				try {
					pi.sendUserMessage(
						`pi-crew run ${manifest.status}: ${runId} (${teamName}/${manifest.workflow ?? "default"})`,
						{ deliverAs: "followUp" },
					);
				} catch { /* non-critical */ }
				activeWatchdogs.delete(runId);
				return;
			}

			// Check if run appears hung
			const agents = readCrewAgents(manifest);
			const now = Date.now();
			if (isLikelyOrphanedActiveRun(manifest, agents, now)) {
				const detail = `status=${manifest.status}, updatedAt=${manifest.updatedAt}, agents=${agents.length}`;
				try {
					pi.sendUserMessage(
						`pi-crew watchdog: run ${runId} appears hung (${detail}). Consider running team action='cancel' runId='${runId}' or team action='doctor'.`,
						{ deliverAs: "followUp" },
					);
				} catch { /* non-critical */ }
				// Don't stop — keep monitoring. The assistant or user may intervene.
			}
		} catch {
			// Non-critical — skip this check
		}

		// Schedule next check
		const timer = setTimeout(check, checkIntervalMs);
		timer.unref(); // Don't prevent process exit
		activeWatchdogs.set(runId, timer);
	};

	// First check after initial interval
	const timer = setTimeout(check, checkIntervalMs);
	timer.unref();
	activeWatchdogs.set(runId, timer);
}
