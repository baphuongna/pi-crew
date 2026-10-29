/**
 * wait-resolve.ts — WP-2/R2 `wait.resolve` broker handler.
 *
 * Moved from crew-broker.ts (wc-gate M4 §5, GH #61 release audit 2026-10-02)
 * — pure move, no behavior change. Terminal report of the parked `ask` tool:
 * flips the task waiting→running and clears the park coordination state.
 * Scoped to auth + state transition + ask.answered/task.resumed events +
 * the G5 respond_delivered ack ONLY (ADR item 6/8): answer DELIVERY is the
 * mailbox respond path (step 6), not this handler. A questionId mismatch
 * (or a task that is not parked) is rejected WITHOUT clearing anything —
 * fail-closed.
 *
 * Top-level function so the class method is a 1-line delegation
 * (same pattern as msg-inbox.ts).
 */

import { withRunLockSync } from "../../../state/coordination/locks.ts";
import { appendEventAsync } from "../../../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../state/types.ts";
import { logInternalError } from "../../../utils/internal-error.ts";
import type { ServerConnection } from "./connection-state.ts";
import { parseWaitResolveParams } from "./request-parsers.ts";
import { recordWaitPolicyRejection, waitAuthError } from "./wait-auth.ts";

/**
 * M3-6 (R21-M1, fix-wave 6): resolve ONE park without un-shielding the others.
 *
 * `manifest.waitState` is a single run-level slot, but more than one task can
 * be parked at the same time (concurrent `ask` calls / goal-loop + a worker).
 * `isWaitAnswerPending(manifest)` reads ONLY this slot, and it is what keeps the
 * stale-reconciler / crash-recovery from repairing (killing) a live worker that
 * stopped heartbeating while parked. The pre-fix resolve cleared the slot
 * whenever it pointed at the resolved park — so once the SECOND park resolved,
 * the FIRST (still parked) task lost its shield entirely and could be
 * stale-reaped while awaiting a human answer.
 *
 * Fix (single-slot contract preserved, no schema change): when the slot points at
 * the park we just ended, RE-POINT it at the still-parked task whose shield must
 * survive instead of blindly clearing it. The latest deadline wins so the run
 * shield never expires while ANY park is still live (expiring early would
 * re-open the same window; living slightly long only delays repair — the
 * fail-safe direction the rest of this module already takes). A slot that
 * belongs to a DIFFERENT (newer) park is left untouched, exactly as before.
 *
 * M4-R1(b) (fix-wave 6 residual, same class as M3-6): the identical
 * clear-not-repoint bug lived in the SIBLING slot writers — respond.ts's
 * requeue path (respond.ts:250-251) and dispatch-batch.ts's ask-timeout
 * requeue (:198-199). Both scoped the CLEAR by taskId (WP-2 round-1 P3), but
 * when the ended park owned the slot and a THIRD task was still parked they
 * dropped the slot, re-opening the un-shielded window M3-6 had closed for
 * wait.resolve. The helper is exported (predicate form, so the sibling writers
 * can pass their requeued-id SET) and reused verbatim there.
 */
export function repointWaitState(
	tasks: TeamTaskState[],
	current: TeamRunManifest["waitState"],
	isEnded: (taskId: string, questionId: string) => boolean,
): TeamRunManifest["waitState"] {
	if (current === undefined) return undefined;
	if (!isEnded(current.taskId, current.questionId)) return current;
	let next: TeamTaskState | undefined;
	for (const task of tasks) {
		if (task.status !== "waiting" || task.waiting === undefined) continue;
		if (isEnded(task.id, task.waiting.questionId)) continue;
		if (next === undefined || task.waiting.deadline > (next.waiting?.deadline ?? 0)) next = task;
	}
	if (next?.waiting === undefined) return undefined;
	return {
		taskId: next.id,
		questionId: next.waiting.questionId,
		askedAt: next.waiting.askedAt,
		deadline: next.waiting.deadline,
	};
}

/** wait.resolve's single-park view of {@link repointWaitState}. */
function repointedWaitState(
	tasks: TeamTaskState[],
	current: TeamRunManifest["waitState"],
	endedTaskId: string,
	endedQuestionId: string,
): TeamRunManifest["waitState"] {
	return repointWaitState(tasks, current, (taskId, questionId) => taskId === endedTaskId && questionId === endedQuestionId);
}

/** @internal M3-6 test export — exercise the scoped-clear repoint directly. */
export const __test__repointedWaitState = repointedWaitState;

export interface WaitResolveHelpers {
	sendError(conn: ServerConnection, id: string, code: string, message: string): void;
	sendResult(conn: ServerConnection, id: string, result: unknown): void;
}

export interface WaitResolveOptions {
	/** Broker cwd (run state root). Undefined → no-manifest error. */
	cwd?: string;
	/** Fail-closed gate: wait.* methods disabled unless explicitly true. */
	waitMethodsEnabled?: boolean;
}

export async function handleWaitResolve(
	conn: ServerConnection,
	id: string,
	params: unknown,
	helpers: WaitResolveHelpers,
	options: WaitResolveOptions,
): Promise<void> {
	if (!conn.runId || !conn.taskId) {
		helpers.sendError(conn, id, "auth", "not authed");
		return;
	}
	// w1a (broker-bare-run-token-forged-task-identity): enforce the compound-token
	// rule on wait.resolve — the SAME rule its wait.request sibling applies at
	// crew-broker.ts:1488 (and delegate.request inline). Without this, a legacy
	// bare-runId-token connection that forged a victim taskId at hello could
	// resolve the victim's parked ask (waiting→running flip + false
	// respond_delivered recorded under the victim's taskId). runId-fallback
	// matches are rejected with the migrate hint; orchestrator connections are
	// rejected by role. Placement mirrors handleWaitRequest: presence check →
	// auth kind → params parse.
	const authErr = waitAuthError(conn);
	if (authErr) {
		helpers.sendError(conn, id, authErr.code, authErr.message);
		return;
	}
	const parsed = parseWaitResolveParams(params);
	if (!parsed) {
		helpers.sendError(conn, id, "bad-params", "wait.resolve: invalid params");
		return;
	}
	// Server-side identity enforcement (same rule as wait.request).
	if (parsed.to !== conn.taskId) {
		helpers.sendError(conn, id, "forbidden", "wait.resolve: 'to' must match the authenticated task");
		return;
	}
	if (!options.cwd) {
		helpers.sendError(conn, id, "no-manifest", "broker has no cwd configured");
		return;
	}
	let loaded: NonNullable<ReturnType<typeof loadRunManifestById>>;
	try {
		const l = loadRunManifestById(options.cwd, conn.runId);
		if (!l) {
			helpers.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
			return;
		}
		loaded = l;
	} catch (err) {
		helpers.sendError(conn, id, "no-manifest", (err as Error).message);
		return;
	}
	if (options.waitMethodsEnabled !== true) {
		recordWaitPolicyRejection(loaded.manifest, conn.taskId, "wait.resolve");
		helpers.sendError(
			conn,
			id,
			"policy-disabled",
			"wait.resolve is disabled: broker.waitMethodsEnabled=false (fail-closed; policy.action recorded in events.jsonl)",
		);
		return;
	}
	const runId = conn.runId;
	const taskId = conn.taskId;
	const outcome = withRunLockSync(loaded.manifest, () => {
		const fresh = loadRunManifestById(loaded.manifest.cwd, runId);
		if (!fresh) return { code: "no-manifest" as const, message: `run '${runId}' not found` };
		const task = fresh.tasks.find((t) => t.id === taskId);
		if (!task) return { code: "no-task" as const, message: `task '${taskId}' not found` };
		if (task.status !== "waiting" || task.waiting?.questionId !== parsed.questionId) {
			return {
				code: "bad-params" as const,
				message: `wait.resolve: no parked question '${parsed.questionId}' on task '${taskId}'`,
			};
		}
		const updatedTasks = fresh.tasks.map((t) => (t.id === taskId ? { ...t, status: "running" as const, waiting: undefined } : t));
		// G5 (deep-review 2026-10-01): capture the liveness pid (heartbeat-first,
		// checkpoint-fallback — the same source stale-reconciler uses) before
		// the flip, so respond_delivered records the same worker-pid evidence
		// its respond_missed twin does root-side.
		const workerPid = task.heartbeat?.pid ?? task.checkpoint?.childPid;
		// waitState is a single run-level slot: never clobber another task's newer
		// park. M3-6 (R21-M1): and never un-shield a task that is STILL parked —
		// when the slot pointed at the park we are ending, re-point it at the
		// surviving park (repointedWaitState) instead of clearing it.
		const waitState = repointedWaitState(fresh.tasks, fresh.manifest.waitState, taskId, parsed.questionId);
		const updatedManifest = {
			...fresh.manifest,
			waitState,
			updatedAt: new Date().toISOString(),
		};
		saveRunTasks(updatedManifest, updatedTasks);
		saveRunManifest(updatedManifest);
		return { code: "ok" as const, message: "", workerPid };
	});
	if (outcome.code !== "ok") {
		helpers.sendError(conn, id, outcome.code, outcome.message);
		return;
	}
	const eventsPath = loaded.manifest.eventsPath;
	void appendEventAsync(eventsPath, {
		type: "ask.answered",
		runId,
		taskId,
		message: `Question ${parsed.questionId} answered; task resumed.`,
		data: { questionId: parsed.questionId },
	}).catch((err) =>
		logInternalError("crew-broker.wait.ask-answered-event", err instanceof Error ? err : new Error(String(err)), `runId=${runId}`),
	);
	void appendEventAsync(eventsPath, {
		type: "task.resumed",
		runId,
		taskId,
		message: `Task resumed after ask answer (question ${parsed.questionId}).`,
		data: { questionId: parsed.questionId },
	}).catch((err) =>
		logInternalError("crew-broker.wait.task-resumed-event", err instanceof Error ? err : new Error(String(err)), `runId=${runId}`),
	);
	// G5 (deep-review 2026-10-01): respond-delivery ack. wait.resolve fires on
	// EVERY terminal path (answered/timed-out/aborted) — only the worker-claimed
	// outcome "answered" is a DELIVERY: the parked ask tool found the
	// questionId-tagged mailbox response and is resolving the park WITH the
	// answer in hand (its findAskResponse exact-equality match). A
	// timed-out/aborted resolve — or a legacy worker that sends no outcome —
	// never claims a delivery: fail-closed, no event. This ack is the leader's
	// only confirmation that a mailbox respond reached a live worker instead
	// of falling into the void; the root-side respond_missed twin covers the
	// dead-worker branch at write time (extension/team-tool/respond.ts).
	if (parsed.outcome === "answered") {
		void appendEventAsync(eventsPath, {
			type: "task.respond_delivered",
			runId,
			taskId,
			message: `Leader respond delivered: worker acknowledged the mailbox response for question ${parsed.questionId}.`,
			data: {
				questionId: parsed.questionId,
				...(outcome.workerPid !== undefined ? { workerPid: outcome.workerPid } : {}),
			},
		}).catch((err) =>
			logInternalError(
				"crew-broker.wait.respond-delivered-event",
				err instanceof Error ? err : new Error(String(err)),
				`runId=${runId}`,
			),
		);
	}
	helpers.sendResult(conn, id, { ok: true, taskId, questionId: parsed.questionId });
}
