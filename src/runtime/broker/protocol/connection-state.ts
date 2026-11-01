/**
 * connection-state.ts — Type definitions for crew-broker connection state
 * and broker options.
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * These are pure types/interfaces used by the CrewBroker class but they
 * contribute ~80 lines to the file's line count. Splitting them out
 * contributes to the ≤2000-line gate (spec §5 M4 acceptance).
 */

import type * as net from "node:net";
import { logInternalError } from "../../../utils/internal-error.ts";
import { encodeBrokerFrame, type NdjsonDecoder } from "../../../utils/ndjson.ts";
import type { GrandchildSpawnInput, GrandchildSpawnResult } from "../../delegate-spawn.ts";
import type { WaitStatusCache } from "../wait-status-cache.ts";

export interface CrewBrokerOptions {
	/** Root session ID used to derive the socket path. */
	sessionId: string;
	/** Pre-resolved socket path (skips re-derivation; useful for tests). */
	socketPath?: string;
	/** Frame cap in UTF-8 bytes. Default 256 KiB. */
	maxFrameBytes?: number;
	/** Per-connection outbound queue cap. Default 256. */
	outboundQueueCap?: number;
	/** R8-M1: per-connection queued-BYTES cap (frames can be up to
	 *  MAX_BROKER_FRAME_BYTES each, so the frame cap alone bounds the queue
	 *  at cap × 256 KiB ≈ 64 MiB in-app). Default 4 MiB. */
	outboundQueueBytesCap?: number;
	/** Required: when false, start() is a no-op and the server never binds.
	 *  Lets the lifecycle controller install the broker unconditionally and
	 *  have a single kill switch. */
	enabled: boolean;
	/** CWD for `loadRunManifestById` (Phase 1 msg.send / msg.inbox resolution).
	 *  When omitted, manifest-touching methods return no-manifest errors. */
	cwd?: string;
	/** Optional test seam: override the `net` module (allows fake-server tests). */
	netModule?: typeof net;
	/** Optional test seam: inject a pre-configured WaitStatusCache (e.g. one
	 *  wrapping a loader spy). Production uses a plain cache — see
	 *  wait-status-cache.ts (R10-3). */
	waitStatusCache?: WaitStatusCache;
	/** WP-2/R2 (ADR-0 2026-08-17-waiting-producer-ask item 7): capability
	 *  gate for the `wait.*` methods. DEFAULT FALSE — fail-closed. When not
	 *  explicitly true, wait.request/wait.resolve are rejected with a
	 *  `policy-disabled` error AND a `policy.action` event is appended to the
	 *  run's events.jsonl (never silent). The production wiring threads
	 *  `config.broker.waitMethodsEnabled` here; tests pass it explicitly. */
	waitMethodsEnabled?: boolean;
	/** T3/R5 (ADR-5 §10): capability gate for the `delegate` surface. DEFAULT
	 *  TRUE since D8 (spec v0.7) — nested spawning is open out of the box; the
	 *  broker still fail-closes when the flag is anything but true. The
	 *  production wiring threads `config.nesting.enabled` (loadConfig layers
	 *  DEFAULT_NESTING.enabled=true; a user `false` closes the surface); tests
	 *  pass it explicitly. Rejections are NEVER silent (delegate.rejected). */
	nestingEnabled?: boolean;
	/** Optional override for the nested-slot budget size (config nesting.maxSlots). */
	nestingMaxSlots?: number;
	nestingMaxDepth?: number;
	nestingTrustedEscalation?: boolean;
	/** Global worker semaphore size, used to size the nested-slot budget. */
	globalWorkerSemaphore?: number;
	/** RR-023 F4 (2026-09-29 battery, finding #4): bounded retry schedule
	 *  (ms) for run.lock contention in the wait.request / delegate.request
	 *  handlers. A live cross-process holder (e.g. the detached runner
	 *  persisting task state) makes acquireLockWithRetry throw; instead of
	 *  letting that escape handleData → closeConnection, the handler retries
	 *  on this schedule and then answers a typed `busy` error frame with the
	 *  connection SURVIVING (plus a delegate.rejected event on the delegate
	 *  path — never silent). Default DEFAULT_LOCK_BUSY_RETRY_DELAYS_MS
	 *  (50/100/200/400/800). See protocol/lock-busy.ts. */
	lockBusyRetryDelaysMs?: readonly number[];
	/** Test seam / alternative spawner for delegate grandchildren. Production
	 *  uses spawnDelegateGrandchild (direct runChildPi call-site, ADR-5 §2). */
	grandchildSpawner?: (input: GrandchildSpawnInput) => Promise<GrandchildSpawnResult>;
	/** Resolved model catalog (canonical provider/id strings) for admission-time
	 *  model validation (ADR-5 §7). When omitted, model validation is skipped
	 *  (documented gap — the production wiring must always supply it). */
	modelCatalog?: () => string[] | undefined;
	/** ADR-5 §9: mirrors config limits.serializeOnPathOverlap for the workspace
	 *  admission gate. Default false. */
	serializeOnPathOverlap?: boolean;
	/** HƯỚNG A (ADR Option 3, 2026-11-01): the DISPATCHER's public coordination
	 *  verify key (base64 SPKI DER Ed25519) bound HEAP-ONLY at construct time —
	 *  the trust anchor for `respond.append` challenge-response auth. Sourced by
	 *  the lifecycle controller from the stdin-threaded dispatcher-key-registry
	 *  (detached-runner start options) or, absent that, from THIS process's own
	 *  keypair (broker host == dispatcher). NEVER from the manifest file
	 *  (unauthenticated, worker-writable — w1a NO-GO). Invalid material fails
	 *  closed to undefined: respond.append answers "no binding" instead of
	 *  trusting a malformed key. */
	dispatcherVerifyKey?: string;
}

/** Per-connection server-side state. */
export interface ServerConnection {
	socket: net.Socket;
	decoder: NdjsonDecoder;
	/** Whether the connection has completed `hello` successfully. */
	authed: boolean;
	/** Run id bound by hello. */
	runId?: string;
	/** Task id bound by hello. */
	taskId?: string;
	/** Role bound by hello: orchestrator can steer/msg-send; workers default. */
	role?: "orchestrator" | "worker";
	/** How the hello token matched the registry (ADR-0 item 6). Derived,
	 *  non-secret metadata recorded at hello time so `wait.*` can reject a
	 *  legacy bare-runId fallback match WITHOUT keeping the raw token on the
	 *  connection (tokens stay confined to the heap-only registry). */
	authMatchKind?: "compound" | "runId-fallback";
	/** Task 10 fix round 2 (BUG #3): sha256 of the secret this connection
	 *  authenticated with. Derived, one-way — never the plaintext token. The
	 *  post-hello revocation check evaluates THIS digest so a revoke →
	 *  re-issue window cannot let an old connection ride the freshly issued
	 *  token for the same key. */
	authedSecretHash?: string;
	/** Outbound queue of encoded frames awaiting drain. */
	outbound: Buffer[];
	/** R8-M1: sum of `outbound[i].length` — maintained by writeOrQueue/
	 *  drainOutbound so the queued-BYTES cap does not rescan the queue. */
	queuedBytes: number;
	/** Set when the queue has hit the cap and a frame was dropped. */
	needsResync: boolean;
	/** Set when the connection is closing (idempotent). */
	closed: boolean;
	/** Timer for the hello deadline. */
	helloTimer: NodeJS.Timeout | null;
	/** Monotonic seq counter for outbound events (diagnostic). */
	outboundSeq: number;
}

// ---------------------------------------------------------------------------
// Outbound queue management (moved from crew-broker.ts — M4 wc-gate ≤2000;
// pure move, no behavior change). The broker keeps thin delegating methods.
// ---------------------------------------------------------------------------

/** Default per-connection outbound queue cap (events). */
export const DEFAULT_OUTBOUND_QUEUE_CAP = 256;

/** R8-M1 (2026-10-17): default per-connection queued-BYTES cap. The frame cap
 *  alone lets a subscribed-but-never-reading client buffer 256 × 256 KiB ≈
 *  64 MiB in-app before the R6-5 typed close engages (kernel backpressure
 *  shifts frames off the queue, so the count rarely grows — the BYTES the
 *  process holds do). ~4 MiB bounds a stuck connection's memory while a
 *  healthy LAN client drains comfortably inside it. */
export const DEFAULT_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024;

/** R6-5 (2026-10-16): typed protocol close-reason sent as a best-effort
 *  `protocol.close` event frame (direct write, jumps the saturated queue)
 *  before the connection is closed after a fanout/event frame was dropped
 *  at the queue cap. Clients observe the reason, reconnect, and replay via
 *  `events.since` (Phase 1.5). */
export const OUTBOUND_OVERFLOW_RESYNC_CLOSE_REASON = "outbound-overflow-resync";

/** R6-5: admission class for an outbound frame.
 *  - `false`  — fanout/event class: drop-newest at cap → resync close.
 *  - `true`   — close-reason class: bypass the cap, attempt an immediate
 *    direct write (existing `sendErrorAndClose` behavior).
 *  - `"response"` — request-response class (sendResult/sendError acks):
 *    bypass the drop-newest cap but stay IN the queue (ordering preserved,
 *    backpressure honored). Bounded by the client's in-flight request count
 *    — one response frame per request — so it can never storm the way a
 *    fanout burst can. Kept a `boolean | "response"` union (not a fresh
 *  enum) so the external FanoutWriters interface (mailbox-fanout.ts) keeps
 *  its `(conn, buf, force: boolean)` shape. */
export type OutboundAdmission = boolean | "response";

export interface OutboundQueueOpts {
	outboundQueueCap?: number;
	outboundQueueBytesCap?: number;
	sessionId: string;
}
export interface OutboundQueueHooks {
	onOverflow(conn: ServerConnection): void;
	onClose(conn: ServerConnection): void;
}

export function writeOrQueueFrame(
	conn: ServerConnection,
	buf: Buffer,
	force: OutboundAdmission,
	opts: OutboundQueueOpts,
	hooks: OutboundQueueHooks,
): void {
	if (conn.closed) return;
	const cap = opts.outboundQueueCap ?? DEFAULT_OUTBOUND_QUEUE_CAP;
	// R8-M1: queued-BYTES cap alongside the frame cap. Few-but-large frames
	// (a slow reader behind a 256 KiB fanout) never trip a 256-frame cap;
	// without this the process buffers up to ~64 MiB per stuck connection.
	// Overflow takes the same typed-close path as the frame cap (resync +
	// reconnect + replay) — applied to ALL admission classes because the
	// connection is about to close anyway and the alternative is unbounded
	// memory, not a delivered response.
	const bytesCap = opts.outboundQueueBytesCap ?? DEFAULT_OUTBOUND_QUEUE_BYTES;
	if (conn.queuedBytes + buf.length > bytesCap) {
		hooks.onOverflow(conn);
		return;
	}
	if (conn.outbound.length >= cap) {
		if (force === "response") {
			// R6-5(a): response frames queue PAST the cap instead of being
			// drop-newest'd. Bounded: at most one response per in-flight
			// request, and the client's request pipeline is serial — this can
			// never grow unbounded the way a fanout burst can. Ordering is
			// preserved (pushed at the tail; drainOutbound honors backpressure).
			conn.outbound.push(buf);
			conn.queuedBytes += buf.length;
			drainOutboundFrames(conn, hooks);
			return;
		}
		if (force) {
			// Forced sends (e.g. close-reason) bypass the cap and attempt
			// to flush directly; if the socket is busy they may still drop.
			try {
				conn.socket.write(buf);
			} catch {
				/* socket may have closed; the close handler will sweep. */
			}
			return;
		}
		// R6-5(b): fanout/event frame dropped at cap (drop-newest). The old
		// `needsResync` marker was write-only (set, never read) — the claimed
		// "pause + client notices" recovery did not exist, so live frames
		// were silently dropped for the connection's remaining lifetime.
		// Now the drop CLOSES the connection with a typed close-reason so
		// the client reconnects and replays (events.since / msg.inbox).
		hooks.onOverflow(conn);
		return;
	}
	conn.outbound.push(buf);
	conn.queuedBytes += buf.length;
	drainOutboundFrames(conn, hooks);
}

export function drainOutboundFrames(conn: ServerConnection, hooks: OutboundQueueHooks): void {
	while (conn.outbound.length > 0) {
		const buf = conn.outbound[0];
		if (buf === undefined) break;
		// Try the write; if it returns false, wait for drain before pushing more.
		try {
			const ok = conn.socket.write(buf);
			if (!ok) {
				// Backpressure — re-arm on drain event.
				conn.socket.once("drain", () => {
					if (!conn.closed) drainOutboundFrames(conn, hooks);
				});
				return;
			}
		} catch {
			// Write failed — close the connection (we already had it open).
			hooks.onClose(conn);
			return;
		}
		conn.outbound.shift();
		conn.queuedBytes -= buf.length;
		conn.outboundSeq += 1;
	}
}

export function handleOutboundOverflowFrame(conn: ServerConnection, opts: OutboundQueueOpts, hooks: OutboundQueueHooks): void {
	// Single-flight: fanoutMailboxMessage iterates a snapshot of the run's
	// connections, so one burst can re-enter here for an already-overflowing
	// conn before `closeConnection`'s `closed` guard becomes visible. The
	// flag is the "close already initiated" bit (its only read).
	if (conn.needsResync) return;
	conn.needsResync = true;
	logInternalError(
		"crew-broker.outbound.overflow",
		new Error("outbound queue overflow — closing connection for resync"),
		`sessionId=${opts.sessionId}
runId=${conn.runId ?? "?"} queued=${conn.outbound.length} seq=${conn.outboundSeq}`,
	);
	try {
		const buf = encodeBrokerFrame({ event: "protocol.close", data: { reason: OUTBOUND_OVERFLOW_RESYNC_CLOSE_REASON } });
		conn.socket.write(buf);
	} catch {
		/* socket may be dead; closeConnection below sweeps regardless */
	}
	hooks.onClose(conn);
}
