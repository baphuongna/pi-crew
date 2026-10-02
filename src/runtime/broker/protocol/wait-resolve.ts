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
import { logInternalError } from "../../../utils/internal-error.ts";
import type { ServerConnection } from "./connection-state.ts";
import { parseWaitResolveParams } from "./request-parsers.ts";
import { recordWaitPolicyRejection } from "./wait-auth.ts";

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
		// waitState is a single run-level slot: clear it ONLY when it points
		// at this exact question — never clobber another task's newer park.
		const waitState = fresh.manifest.waitState;
		const clearWaitState = waitState !== undefined && waitState.taskId === taskId && waitState.questionId === parsed.questionId;
		const updatedManifest = {
			...fresh.manifest,
			...(clearWaitState ? { waitState: undefined } : {}),
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
