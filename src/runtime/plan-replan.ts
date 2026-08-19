/**
 * T2/R4 (ADR-4 §4) — re-plan sweep: dropped-item soft-cancel.
 *
 * Every scheduler tick (selectDispatchBatch, after the ask-deadline sweep)
 * checks the CURRENT plan revision for `dropped` items and reconciles their
 * tasks:
 *  - QUEUED tasks are cancelled outright (never dispatched — the re-plan
 *    removed their reason to exist).
 *  - RUNNING / WAITING / NEEDS_ATTENTION tasks get a SOFT cancel: a wrap-up
 *    advisory appended to the worker's steering file (the same JSONL contract
 *    as `team steer` and the ChildPiSteeringController soft limit — advisory
 *    first, the existing maxTurns+grace machinery stays the hard enforcement).
 *    `task.replanDroppedAt` stamps the advisory as issued (exactly-once across
 *    ticks) and doubles as the terminal marker "cancelled-by-replan".
 *  - A `plan.item.dropped` event is appended per affected task.
 *
 * Reload+persist discipline mirrors sweepExpiredWaitingTasks: best-effort
 * reload, all mutations under withRunLockSync with a fresh in-lock reload,
 * save only when something changed. Never throws into the scheduler tick —
 * failures are logged and the sweep returns undefined (next tick retries).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { withRunLockSync } from "../state/coordination/locks.ts";
import { appendEvent } from "../state/event-log/event-log.ts";
import { getCurrentPlanRecord } from "../state/stores/plan-store.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";

export interface DroppedPlanSweepResult {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	cancelledTaskIds: string[];
	advisedTaskIds: string[];
}

const WRAP_UP_ADVISORY =
	"Plan item dropped by a newer plan revision (re-plan). Wrap up immediately — provide your best final answer now; this task will not be continued.";

function appendSteeringAdvisory(manifest: TeamRunManifest, taskId: string): boolean {
	try {
		const steeringDir = path.join(manifest.artifactsRoot, "steering");
		fs.mkdirSync(steeringDir, { recursive: true });
		const safePath = resolveRealContainedPath(steeringDir, `${taskId}.jsonl`);
		// Same 256KB growth cap as the steer tool (subagent-tools.ts) — refuse
		// loudly rather than poisoning the next incarnation's first poll.
		try {
			if (fs.statSync(safePath).size > 256 * 1024) {
				logInternalError("plan-replan.steer-refused-too-large", new Error("steering file over cap"), `taskId=${taskId}`);
				return false;
			}
		} catch {
			/* no file yet — fine */
		}
		fs.appendFileSync(
			safePath,
			`${JSON.stringify({ type: "steer", message: WRAP_UP_ADVISORY, ts: new Date().toISOString() })}\n`,
			"utf-8",
		);
		return true;
	} catch (error) {
		logInternalError("plan-replan.steer-write-failed", error instanceof Error ? error : new Error(String(error)), `taskId=${taskId}`);
		return false;
	}
}

/**
 * Takes the scheduler's IN-MEMORY manifest+tasks (selectDispatchBatch already
 * holds both) — NO disk load on the no-op path. The per-tick cost for runs
 * without plan-linked tasks is one array scan; plans.json is only read when a
 * task carries planItem, and the reload+persist below only runs when an
 * affected task actually exists.
 */
export function sweepDroppedPlanItems(initialManifest: TeamRunManifest, initialTasks: TeamTaskState[]): DroppedPlanSweepResult | undefined {
	// Cheap exits FIRST (no I/O): no plan-linked tasks at all.
	if (!initialTasks.some((t) => t.planItem)) return undefined;
	const record = getCurrentPlanRecord(initialManifest);
	if (!record) return undefined;
	const dropped = new Set(record.items.filter((i) => i.status === "dropped").map((i) => i.id));
	if (dropped.size === 0) return undefined;
	if (!initialTasks.some((t) => t.planItem && dropped.has(t.planItem))) return undefined;

	const cwd = initialManifest.cwd;
	const runId = initialManifest.runId;
	const cancelledTaskIds: string[] = [];
	const advisedTaskIds: string[] = [];
	try {
		const outcome = withRunLockSync(initialManifest, () => {
			const fresh = loadRunManifestById(cwd, runId); // in-lock consistent read
			if (!fresh) return null;
			const freshRecord = getCurrentPlanRecord(fresh.manifest);
			if (!freshRecord) return null;
			const freshDropped = new Set(freshRecord.items.filter((i) => i.status === "dropped").map((i) => i.id));
			if (freshDropped.size === 0) return null;
			let tasks = fresh.tasks;
			let changed = false;
			for (const task of fresh.tasks) {
				if (!task.planItem || !freshDropped.has(task.planItem)) continue;
				if (task.status === "queued") {
					// Never dispatched — cancel outright.
					tasks = tasks.map((t) =>
						t.id === task.id
							? {
									...t,
									status: "cancelled" as const,
									finishedAt: new Date().toISOString(),
									error: "Plan item dropped by re-plan.",
								}
							: t,
					);
					cancelledTaskIds.push(task.id);
					appendEvent(fresh.manifest.eventsPath, {
						type: "plan.item.dropped",
						runId,
						taskId: task.id,
						message: `Task ${task.id} cancelled: plan item '${task.planItem}' dropped by re-plan v${freshRecord.version}.`,
						data: { itemId: task.planItem, planId: freshRecord.id, planVersion: freshRecord.version },
					});
					changed = true;
				} else if (
					(task.status === "running" || task.status === "waiting" || task.status === "needs_attention") &&
					!task.replanDroppedAt
				) {
					// In flight — advisory once; maxTurns+grace stays the hard stop.
					if (!appendSteeringAdvisory(fresh.manifest, task.id)) continue;
					tasks = tasks.map((t) => (t.id === task.id ? { ...t, replanDroppedAt: new Date().toISOString() } : t));
					advisedTaskIds.push(task.id);
					appendEvent(fresh.manifest.eventsPath, {
						type: "plan.item.dropped",
						runId,
						taskId: task.id,
						message: `Wrap-up advisory delivered to ${task.id}: plan item '${task.planItem}' dropped by re-plan v${freshRecord.version}.`,
						data: { itemId: task.planItem, planId: freshRecord.id, planVersion: freshRecord.version, softCancel: true },
					});
					changed = true;
				}
			}
			if (!changed) return { manifest: fresh.manifest, tasks: fresh.tasks, cancelledTaskIds, advisedTaskIds };
			saveRunTasks(fresh.manifest, tasks);
			const manifest = { ...fresh.manifest, updatedAt: new Date().toISOString() };
			saveRunManifest(manifest);
			return { manifest, tasks, cancelledTaskIds, advisedTaskIds };
		});
		return outcome ?? undefined;
	} catch (error) {
		logInternalError("plan-replan.sweep-failed", error instanceof Error ? error : new Error(String(error)), `runId=${runId}`);
		return undefined;
	}
}
