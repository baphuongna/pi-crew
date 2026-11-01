/**
 * respond-delivery.ts — Broker-first delivery for `respond` answer rows.
 *
 * HƯỚNG A (ADR Option 3, run team_20261101000805, 2026-11-01): the remaining
 * hướng C (0.11.55) gaps are responders that are NOT the dispatch process —
 * a restarted leader, a foreign session, a scheduler host. Their locally
 * signed rows fail the w1a Ed25519 verify in the worker (the worker's key set
 * only carries its spawner + the manifest-threaded dispatcher key) and drop
 * as noise. Hướng A closes that by having the BROKER process append the row:
 * the embedded broker's keypair IS the worker's spawner keypair
 * (lifecycle-handlers.ts), so a broker-appended row verifies in the worker
 * with NO additional key distribution.
 *
 * WIRE CONTRACT — pinned by the broker-side slice (src/runtime/broker/):
 *  - `respond.challenge` / `respond.append` are PRE-hello methods on
 *    un-authed connections (no token — the callers this path exists for hold
 *    none). The connection still dies at the broker's 1s hello deadline, so
 *    the whole challenge→append exchange rides ONE short-lived connection
 *    (the nonce is bound per-connection) and any failure falls back locally.
 *  - Challenge: `{ runId }` → `{ nonce, expiresInMs, runId }`.
 *  - Auth signature: the dispatcher proves possession of its heap-only
 *    coordination private key over `respondAppendSignInput(nonce, params)`
 *    — the request-parsers.ts EXPORT (contract: plain `${nonce}${canonical}`
 *    concatenation, NO separator, runId NOT part of the signed payload;
 *    the doc there mandates client signers use the export, never
 *    re-implement) via mailbox.ts's `signCoordinationChallenge`. The broker
 *    verifies against its construct-time heap-only dispatcher key binding.
 *  - Append: common params + `nonce` + `sig` →
 *    `{ messageId, requestId, deduped, auth }` — the id of the BROKER-SIGNED
 *    row appended with requestId = questionId idempotency. Worker-token
 *    connections are rejected server-side (defense-in-depth).
 *  - Not CrewBrokerClient: hello there hard-requires a per-run token the
 *    responder does not hold, and its connect path cannot skip hello — this
 *    is a minimal NDJSON connector following the same framing
 *    (encodeBrokerFrame / NdjsonDecoder / 256 KiB cap).
 *
 * Failure semantics: `deliverResponseRow` NEVER lets a broker failure escape
 * — it falls back to the local signed idempotent append (hướng C behavior)
 * and logs a warn. Only the local append's own failure propagates, exactly
 * like the pre-hướng-A inline append did. The requestId = questionId key
 * makes the fallback exactly-once even when the broker appended but the ack
 * frame was lost — CONDITIONED on the responder and the broker sharing the
 * same run state root (same-host same-dir, true for every current topology:
 * the responder's local fallback dedup-scan sees the broker's row in the
 * shared inbox file and reuses its id; a future remote-broker topology
 * would lose this guarantee).
 */

import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { type RespondCommonParams, respondAppendSignInput } from "../../runtime/broker/protocol/request-parsers.ts";
import {
	appendMailboxMessageIdempotentAsync,
	getMailboxVerifyKeyPublic,
	type MailboxDeliveryMode,
	type MailboxMessagePriority,
	signCoordinationChallenge,
} from "../../state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../utils/ndjson.ts";
import { getBrokerSocketPath } from "../../utils/socket-path.ts";

/** Connect deadline. Short: respond is interactive and the local fallback is
 *  cheap + correct, so a dead socket must fail fast (ECONNREFUSED/ENOENT on
 *  a missing endpoint is usually immediate anyway). The broker's own 1s
 *  hello deadline for un-authed connections bounds the exchange regardless. */
const BROKER_CONNECT_TIMEOUT_MS = 2_500;

/** Per-request deadline (challenge, append). Mirrors the client seam's
 *  bounded-request discipline (F5) — a half-dead socket must not stall the
 *  respond caller past this. */
const BROKER_REQUEST_TIMEOUT_MS = 5_000;

/** The response row deliverResponseRow accepts — the exact shape the ALIVE
 *  branch of handleRespond builds (plus the mandatory requestId = questionId
 *  idempotency key). Structurally compatible with the mailbox append input
 *  (MailboxAppendInput is module-private in mailbox.ts; both append paths
 *  accept this shape). replyFrom/replyDeadline ride the LOCAL fallback row
 *  (they are not part of the broker wire contract's common params — the
 *  broker parser drops them; informational fields only). */
export interface RespondDeliveryRow {
	direction: "inbox";
	from: "leader";
	to: string;
	taskId: string;
	body: string;
	kind: "response";
	priority: MailboxMessagePriority;
	deliveryMode: MailboxDeliveryMode;
	/** Park correlation id — must match task.waiting.questionId exactly. */
	questionId: string;
	/** Durable idempotency key (= questionId) — makes the out-of-lock append
	 *  exactly-once against both the broker path and concurrent responds. */
	requestId: string;
	data?: Record<string, unknown>;
	replyTo?: string;
	replyFrom?: string;
	replyDeadline?: number;
}

/** Where the delivered row landed — surfaced for events/observability. */
export interface RespondDeliveryOutcome {
	messageId: string;
	via: "broker" | "forced" | "local";
	/** Local path only: true when an existing (direction, requestId) row was
	 *  reused instead of appending a new one (exactly-once re-entry). */
	deduped: boolean;
}

/** Typed transport failure — always funnels into the local fallback. */
class RespondBrokerDeliveryError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "RespondBrokerDeliveryError";
	}
}

interface BrokerResponseFrame {
	id?: unknown;
	result?: unknown;
	error?: { code?: unknown; message?: unknown };
}

interface RespondBrokerStep {
	method: string;
	params: unknown;
}

/** Sequential NDJSON round-trips over ONE short-lived pre-hello connection
 *  (the respond.append nonce is bound to the connection object server-side,
 *  so challenge + append MUST share a socket). `nextStep` receives the
 *  previous step's result (undefined for the first call) and returns the next
 *  request, or undefined when the exchange is complete; it may throw to abort
 *  (e.g. malformed challenge result). Resolves with each step's `result`;
 *  rejects with a typed RespondBrokerDeliveryError on any transport /
 *  protocol / error-frame failure. No retries: the local fallback IS the
 *  retry strategy. */
function brokerRoundTrip(socketPath: string, nextStep: (previousResult: unknown) => RespondBrokerStep | undefined): Promise<unknown[]> {
	return new Promise<unknown[]>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		const decoder = new NdjsonDecoder();
		const results: unknown[] = [];
		let settled = false;
		let currentId: string | null = null;
		let timer: NodeJS.Timeout | null = null;

		const finishOk = (): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			socket.removeAllListeners();
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
			resolve(results);
		};
		const fail = (code: string, message: string): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			socket.removeAllListeners();
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
			reject(new RespondBrokerDeliveryError(code, message));
		};
		const armTimer = (): void => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(
				() => fail("request-timeout", `no broker response within ${BROKER_REQUEST_TIMEOUT_MS}ms`),
				BROKER_REQUEST_TIMEOUT_MS,
			);
			timer.unref?.();
		};
		const sendStep = (): void => {
			let step: RespondBrokerStep | undefined;
			try {
				step = nextStep(results.length > 0 ? results[results.length - 1] : undefined);
			} catch (error) {
				fail("bad-step", error instanceof Error ? error.message : String(error));
				return;
			}
			if (step === undefined) {
				finishOk();
				return;
			}
			currentId = `respond-${randomUUID()}`;
			armTimer();
			try {
				socket.write(encodeBrokerFrame({ id: currentId, method: step.method, params: step.params }));
			} catch (error) {
				fail("encode-failed", error instanceof Error ? error.message : String(error));
			}
		};

		// Connect deadline — cleared the moment the endpoint answers.
		timer = setTimeout(
			() => fail("connect-timeout", `broker socket ${socketPath} did not accept within ${BROKER_CONNECT_TIMEOUT_MS}ms`),
			BROKER_CONNECT_TIMEOUT_MS,
		);
		timer.unref?.();

		socket.once("connect", () => {
			if (settled) return;
			sendStep();
		});
		socket.on("data", (chunk: Buffer | string) => {
			if (settled) return;
			const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			let frames: unknown[];
			try {
				frames = decoder.push(buf);
			} catch (error) {
				fail("protocol", error instanceof Error ? error.message : String(error));
				return;
			}
			for (const frame of frames) {
				if (frame === null || typeof frame !== "object") {
					fail("protocol", "non-object broker frame");
					return;
				}
				const f = frame as BrokerResponseFrame;
				// Unsolicited event frames (no id) — ignored, never fail the
				// exchange on a push.
				if (typeof f.id !== "string") continue;
				if (f.id !== currentId) continue;
				if (f.error) {
					const code = typeof f.error.code === "string" ? f.error.code : "request-failed";
					const message = typeof f.error.message === "string" ? f.error.message : "broker rejected respond request";
					fail(code, message);
					return;
				}
				results.push(f.result);
				sendStep();
				return;
			}
		});
		socket.once("error", (error: Error & { code?: string }) => {
			fail(error.code ?? "connect-failed", error.message);
		});
		socket.once("close", () => {
			fail("close", "broker connection closed before the respond append completed");
		});
	});
}

/** Extract a non-empty string field from a broker result object. */
function stringField(value: unknown, field: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const raw = (value as Record<string, unknown>)[field];
	return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** Broker CR path: challenge → nonce → dispatcher-key signature → append,
 *  all on ONE connection (see header). Throws RespondBrokerDeliveryError on
 *  ANY failure — the caller falls back toward respond.force / local. */
async function appendResponseRowViaBroker(
	manifest: TeamRunManifest,
	row: RespondDeliveryRow,
	socketPath: string,
): Promise<{ messageId: string; deduped: boolean }> {
	// Common params — the EXACT object both the append frame and the auth
	// signature are derived from (respondAppendSignInput covers it whole).
	const appendParams: RespondCommonParams = {
		runId: manifest.runId,
		taskId: row.taskId,
		questionId: row.questionId,
		body: row.body,
		...(row.replyTo !== undefined ? { replyTo: row.replyTo } : {}),
		priority: row.priority,
		deliveryMode: row.deliveryMode,
		requestId: row.requestId,
	};
	let nonce: string | undefined;
	let appended = false;
	const results = await brokerRoundTrip(socketPath, (previous) => {
		if (appended) return undefined; // append ack received — exchange done
		if (nonce === undefined) {
			if (previous !== undefined) {
				const candidate = stringField(previous, "nonce");
				if (candidate === undefined) {
					throw new RespondBrokerDeliveryError("protocol", "respond.challenge result missing nonce");
				}
				nonce = candidate;
			} else {
				return { method: "respond.challenge", params: { runId: manifest.runId } };
			}
		}
		appended = true;
		return {
			method: "respond.append",
			params: {
				...appendParams,
				nonce,
				sig: signCoordinationChallenge(respondAppendSignInput(nonce, appendParams)),
			},
		};
	});
	const appendResult = results.length > 1 ? results[results.length - 1] : undefined;
	const messageId = stringField(appendResult, "messageId");
	if (messageId === undefined) {
		throw new RespondBrokerDeliveryError("protocol", "respond.append result missing messageId");
	}
	// Broker contract: { messageId, requestId, deduped, auth } — `deduped`
	// reports an idempotent re-use of the existing (direction, requestId) row.
	const deduped = appendResult !== null && typeof appendResult === "object" && (appendResult as Record<string, unknown>).deduped === true;
	return { messageId, deduped };
}

/** HƯỚNG A follow-up (probes 14–17, 2026-11-01): token-less one-shot force
 *  append for a LIVE park — the designed lane for a responder that is NOT
 *  the dispatcher (restarted leader / foreign session: the heap-only
 *  dispatcher keypair died with the original process, so CR can never
 *  verify). The broker enforces live-park + one-shot-per-park + heap-side
 *  dedup and appends a BROKER-SIGNED row the worker verifies (probe13:
 *  auth:"forced" delivered end-to-end). Single frame, no challenge. */
async function forceResponseRowViaBroker(
	socketPath: string,
	manifest: TeamRunManifest,
	row: RespondDeliveryRow,
): Promise<{ messageId: string; deduped: boolean }> {
	const forceParams: RespondCommonParams = {
		runId: manifest.runId,
		taskId: row.taskId,
		questionId: row.questionId,
		body: row.body,
		...(row.replyTo !== undefined ? { replyTo: row.replyTo } : {}),
		priority: row.priority,
		deliveryMode: row.deliveryMode,
		requestId: row.requestId,
	};
	let sent = false;
	const results = await brokerRoundTrip(socketPath, () => {
		if (sent) return undefined; // force ack received — exchange done
		sent = true;
		return { method: "respond.force", params: forceParams };
	});
	const forceResult = results.length > 0 ? results[results.length - 1] : undefined;
	const messageId = stringField(forceResult, "messageId");
	if (messageId === undefined) {
		throw new RespondBrokerDeliveryError("protocol", "respond.force result missing messageId");
	}
	const deduped = forceResult !== null && typeof forceResult === "object" && (forceResult as Record<string, unknown>).deduped === true;
	return { messageId, deduped };
}

/**
 * Deliver one `kind:"response"` row for a LIVE park: broker-first, local
 * fallback — NEVER holds a run lock (the caller must have released
 * withRunLockSync before calling; the broker handler reads run state via
 * withRunLockBusyRetry, so an in-lock RPC window would surface as cross-
 * process `busy` churn even though it cannot deadlock).
 *
 * - Broker path pre-check: the socket is derivable (manifest.sessionId) AND
 *   this process holds the DISPATCHER keypair — CR can only prove against the
 *   broker's construct-time heap binding when the signer IS the dispatcher
 *   (`getMailboxVerifyKeyPublic() === manifest.dispatcherVerifyKey`; the
 *   get-or-create keypair is the exact seam the dispatcher stamped at run
 *   creation). A restarted/foreign responder skips straight to the fallback
 *   instead of burning an RPC that cannot verify (its keypair is unknown to
 *   the binding — that gap is respond.force's lane, not CR's).
 * - Any broker failure (socket absent, timeout, auth-reject, protocol drift)
 *   → warn log (`respond.broker-delivery-fallback`) + local signed idempotent
 *   append — hướng C behavior preserved.
 */
export async function deliverResponseRow(manifest: TeamRunManifest, row: RespondDeliveryRow): Promise<RespondDeliveryOutcome> {
	const sessionId = manifest.sessionId;
	const stamped = manifest.brokerSocketPath;
	const socketPath =
		typeof stamped === "string" && stamped.length > 0
			? stamped
			: typeof sessionId === "string" && sessionId.length > 0
				? getBrokerSocketPath(sessionId)
				: undefined;
	if (socketPath !== undefined) {
		const isDispatcher = manifest.dispatcherVerifyKey === getMailboxVerifyKeyPublic();
		if (isDispatcher) {
			try {
				const brokerOutcome = await appendResponseRowViaBroker(manifest, row, socketPath);
				return { messageId: brokerOutcome.messageId, via: "broker", deduped: brokerOutcome.deduped };
			} catch (error) {
				logInternalError(
					"respond.broker-delivery-fallback",
					error instanceof Error ? error : new Error(String(error)),
					`runId=${manifest.runId} taskId=${row.taskId} questionId=${row.questionId}`,
					"warn",
				);
			}
		}
		// HƯỚNG A follow-up (probes 14–17): a non-dispatcher responder (restarted
		// leader / foreign session — the heap-only dispatcher keypair is gone)
		// could previously only reach the LOCAL append, whose row is signed with
		// a key the worker does not hold → dropped as noise → the ask timed out
		// with NO product surface able to answer it. respond.force is the
		// designed lane: token-less, live-park-gated, one-shot, broker-SIGNED
		// (probe13 end-to-end). Same-uid trust domain unchanged — any local
		// process could already speak the protocol; this surfaces it through the
		// product respond tool. Failure (dead park / no broker) falls through to
		// the local append as the last-resort event trail.
		try {
			const forced = await forceResponseRowViaBroker(socketPath, manifest, row);
			return { messageId: forced.messageId, via: "forced", deduped: forced.deduped };
		} catch (error) {
			logInternalError(
				"respond.force-delivery-fallback",
				error instanceof Error ? error : new Error(String(error)),
				`runId=${manifest.runId} taskId=${row.taskId} questionId=${row.questionId}`,
				"warn",
			);
		}
	}
	const outcome = await appendMailboxMessageIdempotentAsync(manifest, row);
	return { messageId: outcome.message.id, via: "local", deduped: outcome.deduped };
}
