/**
 * broker-respond.ts — HƯỚNG A (ADR Option 3, 2026-11-01): the broker's
 * `respond.challenge` / `respond.append` / `respond.force` handlers.
 *
 * Extracted from crew-broker.ts on the wait-resolve.ts / msg-inbox.ts
 * pattern (wc-gate ≤2000): top-level handler functions; the class keeps thin
 * delegations and owns the heap state (threaded via BrokerRespondDeps).
 *
 * WHY these methods are reachable PRE-hello (see CrewBroker.dispatchFrame):
 * their auth is NEVER a hello token —
 *  - `respond.append`: challenge-response. The broker binds the DISPATCHER's
 *    public verify key HEAP-ONLY at construct time (CrewBrokerOptions.
 *    dispatcherVerifyKey ← dispatcher-key-registry.ts ← detached-runner
 *    stdin start options; root dispatcher hosts bind their own key). The
 *    client proves possession of the dispatcher PRIVATE key by signing
 *    nonce ∥ canonical params (respondAppendSignInput — the frozen contract
 *    shared with the client seam). A worker holds only public material, so
 *    it can never pass; a same-uid forger without the key cannot either.
 *  - `respond.force`: no credential — the human-responsibility one-shot for
 *    a LIVE park (ADR residual iii: a same-uid process CAN force-answer
 *    exactly one live park; the row is tagged `forced` + audited).
 *
 * The appended row is written by THIS broker process's mailbox append
 * (appendMailboxMessageIdempotentAsync signs with the broker host's
 * keypair), so it verifies in every worker's delivery gate (w1a) regardless
 * of which process requested the append.
 */

import { createPublicKey, verify as ed25519Verify, randomBytes } from "node:crypto";
import { appendMailboxMessageIdempotentAsync } from "../../../state/coordination/mailbox.ts";
import { appendEventAsync } from "../../../state/event-log/event-log.ts";
import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../state/types.ts";
import { logInternalError } from "../../../utils/internal-error.ts";
import type { ServerConnection } from "./connection-state.ts";
import type { LockBusyOutcome } from "./lock-busy.ts";
import {
	parseRespondAppendParams,
	parseRespondChallengeParams,
	parseRespondForceParams,
	type RespondAppendParams,
	type RespondCommonParams,
	respondAppendSignInput,
} from "./request-parsers.ts";

/** Nominal single-use nonce lifetime. The EFFECTIVE lifetime is also bounded
 *  by the connection: an un-authed connection still dies at the 1s hello
 *  deadline, and the challenge/append round trip is a local Ed25519 sign
 *  (~µs) plus two socket writes, so the TTL below is an upper bound, never a
 *  deadline extension (no re-arm path exists — nothing can keep a connection
 *  alive by looping respond.challenge). */
export const RESPOND_CHALLENGE_TTL_MS = 30_000;
/** Challenge issuance bound per connection (nonce-flood defense). */
export const RESPOND_CHALLENGE_MAX_PER_CONN = 16;

/** Outstanding respond.append challenge: single-use nonce bound to
 *  (connection, runId). HEAP ONLY — dies with the connection (WeakMap). */
export interface RespondChallengeRecord {
	nonce: string;
	runId: string;
	expiresAt: number;
}

/** Heap state + IO seams the handlers run against (owned by CrewBroker). */
export interface BrokerRespondDeps {
	sendError(conn: ServerConnection, id: string, code: string, message: string): void;
	sendResult(conn: ServerConnection, id: string, result: unknown): void;
	/** Broker cwd (run state root). Undefined → no-manifest error. */
	cwd?: string;
	/** Construct-time bound dispatcher public verify key (base64 SPKI DER). */
	dispatcherVerifyKey: string | undefined;
	respondChallenges: WeakMap<ServerConnection, RespondChallengeRecord>;
	respondChallengeCounts: WeakMap<ServerConnection, number>;
	/** Broker-answered `${runId}:${questionId}` fast-fail set. */
	respondedQuestionIds: Set<string>;
	runLockBusyRetry<T>(manifest: TeamRunManifest, fn: () => T): Promise<LockBusyOutcome<T>>;
	/** Broker socket path (audit identity on the forced path). */
	socketPath: string;
}

/** Method router for the respond.* surface (pre- and post-hello). */
export async function handleRespondMethod(
	deps: BrokerRespondDeps,
	conn: ServerConnection,
	id: string,
	method: string,
	params: unknown,
): Promise<void> {
	switch (method) {
		case "respond.challenge":
			handleRespondChallenge(deps, conn, id, params);
			return;
		case "respond.append":
			await handleRespondAppend(deps, conn, id, params);
			return;
		case "respond.force":
			await handleRespondForce(deps, conn, id, params);
			return;
	}
}

/** CR step 1 — issue a single-use nonce bound to (connection, runId).
 *  Issuing a nonce grants NOTHING by itself (the append gate needs a valid
 *  signature over it); the connection stays un-authed and still dies at the
 *  1s hello deadline. Rate-bounded per connection. */
function handleRespondChallenge(deps: BrokerRespondDeps, conn: ServerConnection, id: string, params: unknown): void {
	const parsed = parseRespondChallengeParams(params);
	if (!parsed) {
		deps.sendError(conn, id, "bad-params", "respond.challenge: invalid params");
		return;
	}
	const issued = (deps.respondChallengeCounts.get(conn) ?? 0) + 1;
	deps.respondChallengeCounts.set(conn, issued);
	if (issued > RESPOND_CHALLENGE_MAX_PER_CONN) {
		deps.sendError(conn, id, "rate-limited", "respond.challenge: too many challenges on this connection");
		return;
	}
	const nonce = randomBytes(32).toString("base64url");
	deps.respondChallenges.set(conn, { nonce, runId: parsed.runId, expiresAt: Date.now() + RESPOND_CHALLENGE_TTL_MS });
	deps.sendResult(conn, id, { nonce, expiresInMs: RESPOND_CHALLENGE_TTL_MS, runId: parsed.runId });
}

/** CR step 2 — verify dispatcher possession of the private key over
 *  `${nonce}${canonical}` (respondAppendSignInput — frozen contract shared
 *  with the client seam) against the bound public key. Never throws. */
function verifyDispatcherSignature(deps: BrokerRespondDeps, parsed: RespondAppendParams): boolean {
	if (!deps.dispatcherVerifyKey) return false;
	try {
		const pub = createPublicKey({ key: Buffer.from(deps.dispatcherVerifyKey, "base64"), format: "der", type: "spki" });
		const sigBuf = Buffer.from(parsed.sig, "base64");
		return ed25519Verify(null, Buffer.from(respondAppendSignInput(parsed.nonce, parsed), "utf-8"), pub, sigBuf);
	} catch {
		return false;
	}
}

/** Shared durable write for BOTH respond paths: idempotent append
 *  (requestId = client requestId ?? questionId → exactly-one response row
 *  per question across append+force on the broker surface) + the
 *  `respond.broker_append` audit event (registered in state/contracts.ts
 *  TEAM_EVENT_TYPES). Row shape mirrors respond.ts's alive-path response row
 *  (from "leader"/"leader-forced", kind "response", questionId-tagged). */
async function appendBrokerResponseRow(
	deps: BrokerRespondDeps,
	manifest: TeamRunManifest,
	params: RespondCommonParams & { auth: "challenge-response" | "forced" },
): Promise<{ ok: true; messageId: string; requestId: string; deduped: boolean } | { ok: false; message: string }> {
	const requestId = params.requestId ?? params.questionId;
	const forced = params.auth === "forced";
	const messageId = `${forced ? "respf" : "resp"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	try {
		const outcome = await appendMailboxMessageIdempotentAsync(manifest, {
			id: messageId,
			direction: "inbox",
			from: forced ? "leader-forced" : "leader",
			to: params.taskId,
			taskId: params.taskId,
			body: params.body,
			kind: "response",
			priority: params.priority ?? "normal",
			deliveryMode: params.deliveryMode ?? "next_turn",
			questionId: params.questionId,
			...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
			data: {
				action: "respond",
				kind: "response",
				questionId: params.questionId,
				via: "broker",
				...(forced ? { tag: "forced" } : {}),
			},
			requestId,
		});
		// Heap-side one-shot mark (the durable guarantee is the requestId dedup).
		deps.respondedQuestionIds.add(`${manifest.runId}:${params.questionId}`);
		try {
			await appendEventAsync(manifest.eventsPath, {
				type: "respond.broker_append",
				runId: manifest.runId,
				taskId: params.taskId,
				message: `Broker appended ${forced ? "FORCED " : ""}leader response for question ${params.questionId}.`,
				data: {
					taskId: params.taskId,
					questionId: params.questionId,
					auth: params.auth,
					requestId,
					messageId: outcome.message.id,
					deduped: outcome.deduped,
					...(forced ? { tag: "forced", brokerSocket: deps.socketPath } : {}),
				},
			});
		} catch (err) {
			logInternalError(
				"crew-broker.respond.append-event",
				err instanceof Error ? err : new Error(String(err)),
				`runId=${manifest.runId}`,
			);
		}
		return { ok: true, messageId: outcome.message.id, requestId, deduped: outcome.deduped };
	} catch (err) {
		return { ok: false, message: (err as Error).message };
	}
}

/** CR — dispatcher-authenticated respond append. Auth order: worker-role
 *  reject → parse → binding → single-use nonce (burned on FIRST attempt: a
 *  failed verify also consumes it, one guess per challenge) → Ed25519 verify
 *  → run/task resolution → durable append. */
async function handleRespondAppend(deps: BrokerRespondDeps, conn: ServerConnection, id: string, params: unknown): Promise<void> {
	// Defense-in-depth: role derives from token TYPE (F-06) — a worker
	// connection is never the dispatcher, reject before touching challenge
	// state (same gate as force).
	if (conn.role === "worker") {
		deps.sendError(conn, id, "forbidden", "respond.append requires the dispatcher identity, not a worker token");
		return;
	}
	const parsed = parseRespondAppendParams(params);
	if (!parsed) {
		deps.sendError(conn, id, "bad-params", "respond.append: invalid params");
		return;
	}
	// Hello'd orchestrator connections must target their authenticated run.
	if (conn.authed && conn.runId !== undefined && conn.runId !== parsed.runId) {
		deps.sendError(conn, id, "forbidden", "respond.append: runId does not match the authenticated run");
		return;
	}
	if (!deps.dispatcherVerifyKey) {
		deps.sendError(conn, id, "auth", "respond.append: no dispatcher key bound on this broker");
		return;
	}
	const record = deps.respondChallenges.get(conn);
	if (!record) {
		deps.sendError(conn, id, "auth", "respond.append: no active challenge (call respond.challenge first)");
		return;
	}
	// Single-use: burn on attempt regardless of outcome (anti-brute-force).
	deps.respondChallenges.delete(conn);
	if (record.expiresAt < Date.now()) {
		deps.sendError(conn, id, "auth", "respond.append: challenge expired");
		return;
	}
	if (record.nonce !== parsed.nonce || record.runId !== parsed.runId) {
		deps.sendError(conn, id, "auth", "respond.append: challenge mismatch");
		return;
	}
	if (!verifyDispatcherSignature(deps, parsed)) {
		deps.sendError(conn, id, "auth", "respond.append: signature verification failed");
		return;
	}
	const loaded = loadRunForRespond(deps, conn, id, parsed.runId);
	if (!loaded) return;
	if (!(loaded.tasks ?? []).some((t) => t.id === parsed.taskId)) {
		deps.sendError(conn, id, "no-task", `respond.append: task '${parsed.taskId}' not found`);
		return;
	}
	const outcome = await appendBrokerResponseRow(deps, loaded.manifest, { ...parsed, auth: "challenge-response" });
	if (!outcome.ok) {
		deps.sendError(conn, id, "respond-failed", outcome.message);
		return;
	}
	deps.sendResult(conn, id, {
		messageId: outcome.messageId,
		requestId: outcome.requestId,
		deduped: outcome.deduped,
		auth: "challenge-response",
	});
}

/** Force — token-less, human-responsibility one-shot per live park. Gates:
 *  (a) questionId MUST match a park that is live RIGHT NOW (fresh reload
 *  under the bounded busy-retry run lock — RR-023 F4: a cross-process holder,
 *  e.g. the respond caller, yields a typed `busy`, never a deadlock);
 *  (b) one-shot (heap fast-fail + durable requestId dedup); (c) worker-token
 *  connections rejected (defense-in-depth). The append runs OUTSIDE the run
 *  lock — an async mailbox append under withRunLockSync would re-order the
 *  lock families; exactly-one is guaranteed by the idempotent append, not by
 *  holding the lock. */
async function handleRespondForce(deps: BrokerRespondDeps, conn: ServerConnection, id: string, params: unknown): Promise<void> {
	if (conn.role === "worker") {
		deps.sendError(conn, id, "forbidden", "respond.force is not available to worker tokens");
		return;
	}
	const parsed = parseRespondForceParams(params);
	if (!parsed) {
		deps.sendError(conn, id, "bad-params", "respond.force: invalid params");
		return;
	}
	if (conn.authed && conn.runId !== undefined && conn.runId !== parsed.runId) {
		deps.sendError(conn, id, "forbidden", "respond.force: runId does not match the authenticated run");
		return;
	}
	if (deps.respondedQuestionIds.has(`${parsed.runId}:${parsed.questionId}`)) {
		deps.sendError(conn, id, "already-answered", `respond.force: question '${parsed.questionId}' already has a broker response`);
		return;
	}
	const loaded = loadRunForRespond(deps, conn, id, parsed.runId);
	if (!loaded) return;
	const runId = parsed.runId;
	const taskId = parsed.taskId;
	const questionId = parsed.questionId;
	const gate = await deps.runLockBusyRetry(loaded.manifest, () => {
		// Fresh reload INSIDE the lock (respond.ts:42-43 discipline).
		const fresh = loadRunManifestById(loaded.manifest.cwd, runId);
		if (!fresh) return { code: "no-manifest" as const, message: `run '${runId}' not found`, workerPid: undefined };
		const task = fresh.tasks.find((t) => t.id === taskId);
		if (!task) {
			return { code: "no-task" as const, message: `respond.force: task '${taskId}' not found`, workerPid: undefined };
		}
		if (task.status !== "waiting" || task.waiting?.questionId !== questionId) {
			return {
				code: "no-park" as const,
				message: `respond.force: no live park for question '${questionId}' on task '${taskId}'`,
				workerPid: undefined,
			};
		}
		return {
			code: "ok" as const,
			message: "",
			workerPid: task.heartbeat?.pid ?? task.checkpoint?.childPid,
		};
	});
	if (!gate.ok) {
		deps.sendError(conn, id, "busy", gate.message);
		return;
	}
	if (gate.value.code !== "ok") {
		deps.sendError(conn, id, gate.value.code, gate.value.message);
		return;
	}
	const outcome = await appendBrokerResponseRow(deps, loaded.manifest, { ...parsed, auth: "forced" });
	if (!outcome.ok) {
		deps.sendError(conn, id, "respond-failed", outcome.message);
		return;
	}
	deps.sendResult(conn, id, {
		messageId: outcome.messageId,
		requestId: outcome.requestId,
		deduped: outcome.deduped,
		auth: "forced",
		...(gate.value.workerPid !== undefined ? { workerPid: gate.value.workerPid } : {}),
	});
}

/** Shared cwd + manifest resolution (typed error frames on failure). */
function loadRunForRespond(
	deps: BrokerRespondDeps,
	conn: ServerConnection,
	id: string,
	runId: string,
): NonNullable<ReturnType<typeof loadRunManifestById>> | undefined {
	if (!deps.cwd) {
		deps.sendError(conn, id, "no-manifest", "broker has no cwd configured");
		return undefined;
	}
	try {
		const l = loadRunManifestById(deps.cwd, runId);
		if (!l) {
			deps.sendError(conn, id, "no-manifest", `run '${runId}' not found`);
			return undefined;
		}
		return l;
	} catch (err) {
		deps.sendError(conn, id, "no-manifest", (err as Error).message);
		return undefined;
	}
}
