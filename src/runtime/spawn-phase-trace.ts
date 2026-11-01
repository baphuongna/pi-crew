/**
 * spawn-phase-trace.ts — Observability for pre-worker-spawn hangs.
 *
 * LIVE INCIDENT (2026-11-01, run team_20261101074334, probe19): 02_execute's
 * first worker spawn hung ~7 MINUTES between task.started (07:50:05) and the
 * retry respawn (07:57:05) with ZERO trace — no worker.spawned, no
 * checkpoint childPid, no background.log line in the window. The candidate
 * blocking spans are all log-silent today: the worker-slot semaphore wait
 * (runWorker → withWorkerSlot — waits unboundedly on a full pool), the
 * model-registry resolution chain, and the child spawn env build. The
 * heartbeat watcher correctly flagged "stuck worker" 5 minutes in, but
 * forensics could not bisect WHERE it hung.
 *
 * This tracer closes that gap: a 30s unref'd interval that prints one line
 * per interval to the runner's background.log naming the CURRENT phase and
 * elapsed time. A healthy spawn (<30s) logs NOTHING — zero noise; a hang
 * leaves a breadcrumb every 30s until it resolves.
 *
 * Ticks print via console.error (the background runner's stderr →
 * background.log — same channel pi-spawn ENOENT warnings already use).
 */

export interface SpawnPhaseTracer {
	/** Advance to the next phase label (idempotent end() clears the timer). */
	phase(label: string): void;
	/** Stop ticking (call when the worker spawned / the attempt settled). */
	end(): void;
}

const TICK_MS = 30_000;

export function createSpawnPhaseTracer(taskId: string, attempt: number, tickMs: number = TICK_MS): SpawnPhaseTracer {
	const startedAt = Date.now();
	let currentPhase = "init";
	let timer: NodeJS.Timeout | undefined;
	const tick = (): void => {
		console.error(`[spawn.trace] task=${taskId} attempt=${attempt} phase=${currentPhase} elapsedMs=${Date.now() - startedAt}`);
	};
	// First tick fires only after tickMs — sub-tick spawns stay silent.
	timer = setInterval(tick, tickMs);
	timer.unref?.();
	return {
		phase(label: string): void {
			currentPhase = label;
		},
		end(): void {
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
		},
	};
}
