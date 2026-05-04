import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { appendEvent, scanSequence } from "../state/event-log.ts";
import { loadRunManifestById, saveRunTasks, updateRunStatus } from "../state/state-store.ts";
import type { TeamTaskState } from "../state/types.ts";
import { isWorkerHeartbeatStale } from "./worker-heartbeat.ts";
import type { ManifestCache } from "./manifest-cache.ts";
import { checkProcessLiveness } from "./process-status.ts";
import { reconcileStaleRun, type ReconcileResult } from "./stale-reconciler.ts";

export interface RecoveryPlan {
	runId: string;
	resumableTasks: string[];
	preservedTasks: string[];
	lastEventSeq: number;
}

function isTerminalTask(task: TeamTaskState): boolean {
	return task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "skipped";
}

function shouldRecoverTask(task: TeamTaskState, deadMs: number): boolean {
	if (task.status !== "running") return false;
	if (!task.heartbeat) return true;
	return task.heartbeat.alive === false || isWorkerHeartbeatStale(task.heartbeat, deadMs);
}

export function detectInterruptedRuns(cwd: string, manifestCache: ManifestCache, deadMs = 300_000): RecoveryPlan[] {
	const plans: RecoveryPlan[] = [];
	for (const manifest of manifestCache.list(50)) {
		if (manifest.status !== "running") continue;
		if (manifest.async?.pid !== undefined && checkProcessLiveness(manifest.async.pid).alive) continue;
		const loaded = loadRunManifestById(cwd, manifest.runId);
		if (!loaded) continue;
		const resumableTasks = loaded.tasks.filter((task) => shouldRecoverTask(task, deadMs)).map((task) => task.id);
		if (!resumableTasks.length) continue;
		plans.push({ runId: manifest.runId, resumableTasks, preservedTasks: loaded.tasks.filter(isTerminalTask).map((task) => task.id), lastEventSeq: scanSequence(loaded.manifest.eventsPath) });
	}
	return plans;
}

export async function applyRecoveryPlan(plan: RecoveryPlan, ctx: Pick<ExtensionContext, "cwd">, registry?: MetricRegistry): Promise<void> {
	const loaded = loadRunManifestById(ctx.cwd, plan.runId);
	if (!loaded) throw new Error(`Run '${plan.runId}' not found.`);
	const reset = new Set(plan.resumableTasks);
	const tasks = loaded.tasks.map((task) => reset.has(task.id) ? { ...task, status: "queued" as const, startedAt: undefined, finishedAt: undefined, error: undefined, heartbeat: undefined } : task);
	saveRunTasks(loaded.manifest, tasks);
	appendEvent(loaded.manifest.eventsPath, { type: "crew.run.resumed", runId: plan.runId, message: `Recovered ${plan.resumableTasks.length} interrupted task(s).`, data: { recoveredFromSeq: plan.lastEventSeq, resumableTasks: plan.resumableTasks } });
	registry?.counter("crew.run.count", "Total runs by status").inc({ status: "resumed" });
}

export function declineRecoveryPlan(plan: RecoveryPlan, ctx: Pick<ExtensionContext, "cwd">): void {
	const loaded = loadRunManifestById(ctx.cwd, plan.runId);
	if (!loaded) throw new Error(`Run '${plan.runId}' not found.`);
	// Log the event first — if appendEvent fails, state remains consistent.
	appendEvent(loaded.manifest.eventsPath, { type: "crew.run.recovery_declined", runId: plan.runId, message: "Interrupted run was not resumed.", data: { recoveredFromSeq: plan.lastEventSeq } });
	updateRunStatus(loaded.manifest, "cancelled", "interrupted-not-resumed");
}

/**
 * Run 3-phase stale reconciliation on all active runs.
 * Returns results for each reconciled run.
 */
export function reconcileAllStaleRuns(cwd: string, manifestCache: ManifestCache, now = Date.now()): ReconcileResult[] {
	const results: ReconcileResult[] = [];
	for (const manifest of manifestCache.list(50)) {
		if (manifest.status !== "running") continue;
		const loaded = loadRunManifestById(cwd, manifest.runId);
		if (!loaded) continue;
		const result = reconcileStaleRun(loaded.manifest, loaded.tasks, now);
		if (result.repaired) {
			updateRunStatus(loaded.manifest, "failed", `Stale run reconciled: ${result.detail}`);
			appendEvent(loaded.manifest.eventsPath, { type: "crew.run.reconciled_stale", runId: manifest.runId, message: result.detail, data: { verdict: result.verdict } });
		}
		if (result.verdict !== "healthy") {
			results.push(result);
		}
	}
	return results;
}
