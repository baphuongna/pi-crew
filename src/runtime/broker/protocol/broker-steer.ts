/**
 * broker-steer.ts — HƯỚNG A follow-up sibling (2026-11-01, probe19): the
 * steer.dead-end. A RESTARTED/foreign session's `team steer` writes a
 * pendingSteers entry + a steering-file row signed with ITS OWN keypair — but
 * the live worker's pollSteering only accepts rows signed by a key in its
 * PI_CREW_MAILBOX_VERIFY_KEYS set (dispatcher + spawner/runner), so the row is
 * dropped as unauthenticated noise and the in-context injection NEVER happens
 * (probe19: file row present, worker conversation received NOTHING). The
 * pendingSteers entry only delivers at the NEXT spawn — useless for a live
 * worker. respond.force closed the same class for asks; steer.force closes it
 * for steering.
 *
 * `steer.force` is a PRE-hello, token-less broker method (mirrors
 * respond.force's lane): the RUN's broker — hosted by the detached runner,
 * whose keypair IS in every worker's verify set — performs the delivery
 * itself: a mailbox row (kind:"steer", deliveryMode:"interrupt") + a
 * BROKER-SIGNED steering-file line the live worker accepts.
 *
 * Trust: same-uid domain (the socket dir is 0700; any local process could
 * already write the fs rows — this surface only adds VERIFIED delivery, never
 * new authority). Gates: worker-role connections rejected (defense-in-depth),
 * task must exist and be live (running|waiting), requestId dedup mirrors
 * steer.push (R2-L-A4), audit event steer.broker_force lands in events.jsonl.
 */

import { isTerminalTaskStatus } from "../../../state/contracts.ts";
import { appendEventAsync } from "../../../state/event-log/event-log.ts";
import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../state/types.ts";
import { logInternalError } from "../../../utils/internal-error.ts";
import type { ServerConnection } from "./connection-state.ts";

export interface SteerForceParams {
	runId: string;
	taskId: string;
	body: string;
	/** Optional idempotency key — resend-after-ack-loss dedupes (R2-L-A4). */
	requestId?: string;
}

export function parseSteerForceParams(value: unknown): SteerForceParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	const runId = typeof v.runId === "string" ? v.runId : undefined;
	const taskId = typeof v.taskId === "string" ? v.taskId : undefined;
	const body = typeof v.body === "string" ? v.body : undefined;
	if (!runId || !taskId || body === undefined) return undefined;
	const requestId = typeof v.requestId === "string" && v.requestId.length > 0 ? v.requestId.slice(0, 128) : undefined;
	return requestId === undefined ? { runId, taskId, body } : { runId, taskId, body, requestId };
}

export interface SteerForceDeps {
	sendError: (conn: ServerConnection, id: string, code: string, message: string) => void;
	sendResult: (conn: ServerConnection, id: string, result: unknown) => void;
	/** Mailbox append (idempotent when requestId supplied). */
	appendSteerRow: (manifest: TeamRunManifest, params: SteerForceParams, messageId: string) => Promise<{ deduped: boolean }>;
	/** Signed steering-file append (the delivery the live worker accepts). */
	appendSignedSteeringLine: (manifest: TeamRunManifest, taskId: string, body: string, messageId: string) => Promise<void>;
}

/** handleSteerForce — see module header. Never throws (typed errors only). */
export async function handleSteerForce(
	deps: SteerForceDeps,
	conn: ServerConnection,
	id: string,
	params: unknown,
	options: { cwd?: string },
): Promise<void> {
	// Defense-in-depth (mirrors respond.force): a worker-token connection must
	// not steer a sibling through this lane.
	if (conn.role === "worker") {
		deps.sendError(conn, id, "forbidden", "steer.force is not available to worker tokens");
		return;
	}
	const parsed = parseSteerForceParams(params);
	if (!parsed) {
		deps.sendError(conn, id, "bad-params", "steer.force: runId, taskId and body are required");
		return;
	}
	if (conn.authed && conn.runId !== undefined && conn.runId !== parsed.runId) {
		deps.sendError(conn, id, "forbidden", "steer.force: runId does not match the authenticated run");
		return;
	}
	if (!options.cwd) {
		deps.sendError(conn, id, "no-manifest", "broker has no cwd configured");
		return;
	}
	let loaded: NonNullable<ReturnType<typeof loadRunManifestById>>;
	try {
		const l = loadRunManifestById(options.cwd, parsed.runId);
		if (!l) {
			deps.sendError(conn, id, "no-manifest", `run '${parsed.runId}' not found`);
			return;
		}
		loaded = l;
	} catch (err) {
		deps.sendError(conn, id, "no-manifest", (err as Error).message);
		return;
	}
	const task = loaded.tasks.find((t) => t.id === parsed.taskId);
	if (!task) {
		deps.sendError(conn, id, "no-task", `steer.force: task '${parsed.taskId}' not found`);
		return;
	}
	if (isTerminalTaskStatus(task.status)) {
		deps.sendError(conn, id, "no-task", `steer.force: task '${parsed.taskId}' is ${task.status}`);
		return;
	}
	const messageId = `steerf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	let deduped = false;
	try {
		const outcome = await deps.appendSteerRow(loaded.manifest, parsed, messageId);
		deduped = outcome.deduped;
	} catch (err) {
		logInternalError(
			"crew-broker.steer.force-mailbox",
			err instanceof Error ? err : new Error(String(err)),
			`runId=${parsed.runId} taskId=${parsed.taskId}`,
		);
		deps.sendError(conn, id, "append-failed", "steer.force: mailbox append failed");
		return;
	}
	// Best-effort signed steering line — a failure here must NOT fail the call
	// (the mailbox row's live fanout already delivered); mirrors handleSteerPush
	// write-2 discipline. Skip on dedup (R2-L-A4).
	if (!deduped) {
		try {
			await deps.appendSignedSteeringLine(loaded.manifest, parsed.taskId, parsed.body, messageId);
		} catch (err) {
			logInternalError(
				"crew-broker.steer.force-file",
				err instanceof Error ? err : new Error(String(err)),
				`runId=${parsed.runId} taskId=${parsed.taskId}`,
			);
		}
	}
	void appendEventAsync(loaded.manifest.eventsPath, {
		type: "steer.broker_force",
		runId: parsed.runId,
		taskId: parsed.taskId,
		message: `Foreign/restarted session steer delivered via broker (auth:forced).`,
		data: { taskId: parsed.taskId, auth: "forced" },
	}).catch((err) =>
		logInternalError(
			"crew-broker.steer.force-event",
			err instanceof Error ? err : new Error(String(err)),
			`runId=${parsed.runId} taskId=${parsed.taskId}`,
		),
	);
	deps.sendResult(conn, id, { ok: true, taskId: parsed.taskId, messageId, deduped, auth: "forced" });
}
