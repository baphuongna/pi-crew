/**
 * crew-broker.ts — Root-only local socket server for cross-process pi-worker
 *                  message transport (grew out of the Phase 0 skeleton,
 *                  sub-task 0.4 — see history note below).
 *
 *  - Bound to a `node:net` Unix domain socket or Windows named pipe.
 *  - One broker per root session; per-run token auth on first `hello`.
 *  - NDJSON framing, 256 KiB UTF-8 cap, 1s hello deadline.
 *  - Per-connection outbound queue cap (default 256). Fanout/event frames
 *    are drop-newest at cap, and the drop now CLOSES the connection with a
 *    typed `protocol.close` reason ("outbound-overflow-resync") so the
 *    client reconnects and replays (R6-5). Request RESPONSE frames
 *    (sendResult/sendError acks) bypass the cap — bounded by in-flight
 *    request count, never the fanout storm.
 *  - Dispatches 12 methods post-hello: `ping`, `hello`, `msg.send`,
 *    `msg.inbox`, `events.since`, `events.subscribe`, `task.waitStatus`,
 *    `steer.push`, `escalate`, `wait.request`/`wait.resolve`
 *    (capability-gated via `options.waitMethodsEnabled`, fail-closed), and
 *    `delegate.request` (governed-nesting grandchild spawn through
 *    `delegate-spawn.ts`, capability-gated via `options.nestingEnabled`,
 *    fail-closed). Unknown methods return a typed `not-implemented`.
 *  - Mailbox/event persistence flows through the `src/state/` stores
 *    (`appendMailboxMessage*`, event-log) — the broker itself keeps no
 *    durable state of its own.
 *  - Token map is HEAP ONLY; cleared on `stop()`. Never serialized.
 *  - `stop()` is idempotent. Never calls `process.kill`.
 *  - All log/error scopes use `crew-broker.*` prefix; every diagnostic
 *    passes through `redactSecretString` from `src/utils/redaction.ts`.
 *
 *  NO outbound TCP. NO process killing.
 *
 *  History: the Phase 0 contract (hello/ping only, no persistence, no
 *  children) lives in `reports/inter-pi-broker-impl-plan-2026-07-21.md` §0.4;
 *  the 12-method surface above supersedes it. DR-01 (2026-10-14) rewrote
 *  this header after it had drifted ~1900 LOC past the skeleton it
 *  described.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import {
	appendMailboxMessageAsync,
	appendMailboxMessageIdempotentAsync,
	type MailboxMessage,
	registerMailboxAppendObserver,
	signSteeringEntry,
} from "../../state/coordination/mailbox.ts";
import { appendEventAsync } from "../../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../state/stores/state-store.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { runEventBus } from "../../ui/run-event-bus.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { BrokerError, encodeBrokerFrame, MAX_BROKER_FRAME_BYTES, NdjsonDecoder } from "../../utils/ndjson.ts";
import { redactSecretString } from "../../utils/redaction.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import { getBrokerSocketPath, prepareBrokerSocketDir, removeStaleBrokerSocket } from "../../utils/socket-path.ts";
import { NestedSlotBudget } from "../scheduling/nested-slots.ts";
import { handleDelegateRequest } from "./crew-broker-delegate-request.ts";
import { type BrokerToken, BrokerTokenRegistry } from "./crew-broker-tokens.ts";
import { DelegateAbortRegistry } from "./delegate/delegate-abort.ts";
import { type DelegateEventTarget, type DelegateEventType, recordDelegateEvent } from "./delegate/delegate-event.ts";
import { fanoutMailboxMessage } from "./mailbox-observer/mailbox-fanout.ts";
import type { CrewBrokerOptions, ServerConnection } from "./protocol/connection-state.ts";
// Outbound-queue management + caps (wc-gate move — bodies in protocol/connection-state.ts)
import {
	handleOutboundOverflowFrame,
	type OutboundAdmission,
	type OutboundQueueHooks,
	writeOrQueueFrame,
} from "./protocol/connection-state.ts";
import { handleEventsSince } from "./protocol/events-replay.ts";
import { DEFAULT_LOCK_BUSY_RETRY_DELAYS_MS, type LockBusyOutcome, withRunLockBusyRetry } from "./protocol/lock-busy.ts";
import { loadRunForHello } from "./protocol/manifest-loader.ts";
import { handleMsgInbox } from "./protocol/msg-inbox.ts";
import { resolveMsgSendTargets } from "./protocol/msg-send-targets.ts";
import {
	BROKER_PROTOCOL,
	isHelloParams,
	isRequestObject,
	parseMsgSendParams,
	parseWaitRequestParams,
	safeStringify,
	WAIT_REQUEST_TIMEOUT_SEC_DEFAULT,
	WAIT_REQUEST_TIMEOUT_SEC_MAX,
} from "./protocol/request-parsers.ts";
import { recordWaitPolicyRejection, waitAuthError } from "./protocol/wait-auth.ts";
import { handleWaitResolve } from "./protocol/wait-resolve.ts";
import { captureSocketIdentity, type SocketIdentity, stopServerAndRemoveSocket } from "./socket-stop.ts";
import { pushWaitingToForegroundWaiter } from "./wait-push.ts";
import { WaitStatusCache } from "./wait-status-cache.ts";

/** Protocol version negotiated at `hello` time. Bump on breaking change.
 * (Re-export removed 2026-09-10 — zero consumers; defined + exported in
 * request-parsers.ts.) */

/** Hard hello deadline (per spec). After 1s, the connection is closed with a
 *  generic auth/protocol code. (Unexported 2026-09-10 — zero consumers.) */
const HELLO_DEADLINE_MS = 1_000;

/** Per-connection server-side state.
 *  Moved to ./protocol/connection-state.ts (M4 / WI-4.1):
 *   - interface CrewBrokerOptions
 *   - interface ServerConnection
 *  Both re-exported from connection-state.ts; the class body is unchanged.
 */

/** Task 10 (mux-surface A1 §5.2): run statuses after which every hello token
 *  is by definition stale — the run will never issue work again, so the error
 *  is "stale-token" instead of generic auth. NARROWER than
 *  TEAM_TERMINAL_RUN_STATUSES on purpose: "blocked" is recoverable, so a
 *  blocked run still authenticates normally. */
const STALE_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export class CrewBroker {
	private readonly options: Required<Pick<CrewBrokerOptions, "sessionId" | "enabled" | "waitMethodsEnabled" | "nestingEnabled">> &
		Pick<
			CrewBrokerOptions,
			| "socketPath"
			| "maxFrameBytes"
			| "outboundQueueCap"
			| "outboundQueueBytesCap"
			| "cwd"
			| "netModule"
			| "waitStatusCache"
			| "nestingMaxSlots"
			| "nestingMaxDepth"
			| "nestingTrustedEscalation"
			| "globalWorkerSemaphore"
			| "grandchildSpawner"
			| "modelCatalog"
			| "serializeOnPathOverlap"
			| "lockBusyRetryDelaysMs"
		>;
	private readonly tokens = new BrokerTokenRegistry();
	/** Task 10 (mux-surface A1 §5.2): taskId → the compound token most
	 *  recently issued for it. revokeTaskToken(taskId) resolves the exact
	 *  secret through this map — no runId needed (the broker serves many
	 *  runs; a colliding taskId in another run revokes both, which is the
	 *  conservative direction). Heap-only like the registry. */
	private readonly taskTokens = new Map<string, BrokerToken>();
	private server: net.Server | null = null;
	private resolvedSocketPath: string | null = null;
	/** [3] stop-unlink race: dev+ino of the leaf we created, captured right
	 *  after listen() succeeded. stop() removes the path only while this
	 *  still matches (a rebound leaf is a new inode); see socket-stop.ts. */
	private socketIdentity: SocketIdentity | null = null;
	private stopped = false;
	private startingPromise: Promise<void> | null = null;
	private readonly connections = new Set<ServerConnection>();
	/** Connections indexed by runId for live message fanout (Phase 1.3). */
	private readonly connectionsByRun = new Map<string, Set<ServerConnection>>();
	/** Per-connection event subscription unsubscribers (Phase 2: events.subscribe). */
	private readonly subscriptionUnsubs = new WeakMap<ServerConnection, Set<() => void>>();
	/** Unsubscribe handle for the mailbox append observer (set on start, cleared on stop). */
	private mailboxObserverUnsub: (() => void) | null = null;
	/** T3/R5 (ADR-5 §2): nested-slot budget for delegate grandchildren — lazily
	 *  sized from options (max(1, floor(globalWorkerSemaphore/2)) or override). */
	private nestedSlots: NestedSlotBudget | undefined;
	/** M3-5/R43-N3: abort controllers for in-flight delegate grandchildren —
	 *  aborted on run terminalise (abortDelegatesForRun) and on stop(). */
	private readonly delegateAborts = new DelegateAbortRegistry();
	/** A single observable handshake counter (test/observability). */
	private handshakeCount = 0;
	/** R10-3: stat-gated manifest/tasks cache shared by all task.waitStatus
	 *  waiters on this broker (keyed by runId — the broker serves one cwd). */
	private readonly waitStatusCache: WaitStatusCache;

	constructor(options: CrewBrokerOptions) {
		if (!options || typeof options !== "object") {
			throw new Error("CrewBroker: options is required");
		}
		if (typeof options.sessionId !== "string" || options.sessionId.length === 0) {
			throw new Error("CrewBroker: sessionId must be a non-empty string");
		}
		this.options = {
			sessionId: options.sessionId,
			enabled: options.enabled === true,
			socketPath: options.socketPath,
			maxFrameBytes: options.maxFrameBytes,
			outboundQueueCap: options.outboundQueueCap,
			outboundQueueBytesCap: options.outboundQueueBytesCap,
			cwd: options.cwd,
			netModule: options.netModule,
			waitMethodsEnabled: options.waitMethodsEnabled === true,
			nestingEnabled: options.nestingEnabled === true,
			nestingMaxSlots: options.nestingMaxSlots,
			nestingMaxDepth: options.nestingMaxDepth,
			nestingTrustedEscalation: options.nestingTrustedEscalation === true,
			globalWorkerSemaphore: options.globalWorkerSemaphore,
			grandchildSpawner: options.grandchildSpawner,
			modelCatalog: options.modelCatalog,
			serializeOnPathOverlap: options.serializeOnPathOverlap === true,
		};
		this.waitStatusCache = options.waitStatusCache ?? new WaitStatusCache();
	}

	/** Read the resolved socket path. Available after start() resolves. */
	get socketPath(): string {
		return this.resolvedSocketPath ?? this.options.socketPath ?? getBrokerSocketPath(this.options.sessionId);
	}

	/** Diagnostic: number of connections currently registered. */
	get connectionCount(): number {
		return this.connections.size;
	}

	/** Diagnostic: number of completed handshakes since start(). */
	get handshakes(): number {
		return this.handshakeCount;
	}

	/** Diagnostic: number of registered tokens. */
	get tokenCount(): number {
		return this.tokens.size;
	}

	/** Issue a fresh token for `runId` (+optional `taskId` for per-task
	 *  isolation). The token is stored in the heap-only registry and is the
	 *  only way a child can complete `hello`. Never log the return value;
	 *  never write it to disk. taskId is optional — when absent, the legacy
	 *  per-run token model applies. */
	issueRunToken(runId: string, taskId?: string): string {
		if (typeof runId !== "string" || runId.length === 0) {
			throw new Error("CrewBroker.issueRunToken: runId must be a non-empty string");
		}
		const token = this.tokens.issue(runId, taskId);
		// Task 10: track the live secret per taskId so revokeTaskToken can
		// resolve it later. A re-issue overwrites the entry; the OLD token
		// keeps whatever revocation it already had (per-secret, not per-key).
		if (taskId !== undefined) this.taskTokens.set(taskId, token);
		return token;
	}

	/** Task 10 (mux-surface A1 §5.2): revoke the token issued for `taskId`.
	 *  The next hello presenting that token — and every subsequent frame on a
	 *  connection already authenticated with it — is rejected with code
	 *  "revoked". Open connections are NOT force-closed (A1 enforces at the
	 *  next frame boundary; re-issue is the A2 remedy). No-op when no token
	 *  was ever issued for the task. */
	revokeTaskToken(taskId: string): void {
		if (typeof taskId !== "string" || taskId.length === 0) {
			throw new Error("CrewBroker.revokeTaskToken: taskId must be a non-empty string");
		}
		const token = this.taskTokens.get(taskId);
		if (token !== undefined) {
			this.tokens.revokeToken(token);
			this.taskTokens.delete(taskId);
		}
	}

	/** M3-5 / R43-N3: cancel every in-flight DELEGATE GRANDCHILD of `runId`.
	 *  Called from the run-terminal paths (budget abort / cancellation via
	 *  budget-enforcement.ts → abortRunDelegates) and from stop(). Before this
	 *  existed the spawner was fire-and-forget: a budget abort left grandchildren
	 *  running to their own deadline (up to 24h), still spending and still
	 *  holding nested slots. Returns the number cancelled; idempotent. */
	abortDelegatesForRun(runId: string, reason = "run-terminal"): number {
		if (typeof runId !== "string" || runId.length === 0) return 0;
		const aborted = this.delegateAborts.abortRun(runId, { reason });
		if (aborted > 0) {
			logInternalError(
				"crew-broker.delegate.abort-run",
				new Error(`${aborted} delegate grandchild(ren) cancelled`),
				`runId=${runId} reason=${reason}`,
			);
		}
		return aborted;
	}

	/** Number of in-flight delegate grandchildren (diagnostics / tests). */
	get inFlightDelegateCount(): number {
		return this.delegateAborts.size;
	}

	/** Issue the orchestrator token for `runId` (F-06). Cryptographically
	 *  distinct from every per-task token — the ONLY token that grants
	 *  role:'orchestrator' (required for steer.push / msg.send). */
	issueOrchestratorToken(runId: string): string {
		if (typeof runId !== "string" || runId.length === 0) {
			throw new Error("CrewBroker.issueOrchestratorToken: runId must be a non-empty string");
		}
		return this.tokens.issueOrchestratorToken(runId);
	}

	/** Start the broker. Idempotent (subsequent calls return the same promise).
	 *  When `enabled=false`, this is a no-op and no socket is created. */
	start(): Promise<void> {
		if (!this.options.enabled) {
			// Disabled path: ensure the server is NOT bound. This is the
			// disabled-path proof — no socket created, no listener installed.
			logInternalError("crew-broker.start.disabled", new Error("broker disabled"), `sessionId=${this.options.sessionId}`);
			return Promise.resolve();
		}
		if (this.server) return Promise.resolve();
		if (this.startingPromise) return this.startingPromise;
		this.startingPromise = this.doStart().catch((err) => {
			this.startingPromise = null;
			throw err;
		});
		return this.startingPromise;
	}

	private async doStart(): Promise<void> {
		// 1. Resolve socket path.
		const sockPath = this.options.socketPath ?? getBrokerSocketPath(this.options.sessionId);
		this.resolvedSocketPath = sockPath;

		// 2. Ensure parent directory exists (mode 0700 on POSIX).
		await prepareBrokerSocketDir(sockPath);

		// 3. Connect-then-unlink any stale endpoint. A live listener MUST NOT
		//    be replaced (we let EADDRINUSE surface on bind).
		const staleResult = await removeStaleBrokerSocket(sockPath);
		if (staleResult === "refused") {
			// Symlink — refuse to proceed.
			throw new BrokerError("protocol", `refusing to follow symlinked broker socket: ${sockPath}`);
		}

		// 4. Bind the server. allowHalfOpen:false so the other side's FIN is
		//    the only end-of-stream signal; we won't keep reading from a
		//    half-closed socket.
		const netModule = this.options.netModule ?? net;
		const server = netModule.createServer({ allowHalfOpen: false }, (sock) => {
			this.handleConnection(sock).catch((err) => {
				logInternalError(
					"crew-broker.connection.crashed",
					err instanceof Error ? err : new Error(String(err)),
					`sessionId=${this.options.sessionId}`,
				);
			});
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				server.removeListener("listening", onListening);
				reject(err);
			};
			const onListening = () => {
				server.removeListener("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			try {
				server.listen(sockPath);
			} catch (err) {
				server.removeListener("error", onError);
				server.removeListener("listening", onListening);
				reject(err as Error);
			}
		});

		// 4.5 [3] stop-unlink race: pin the fresh leaf's identity so stop()
		//     can prove it still owns the path before removing it (win32
		//     named pipes have no fs leaf — nothing to pin).
		if (process.platform !== "win32") {
			this.socketIdentity = await captureSocketIdentity(sockPath);
		}

		// 5. Tighten socket permissions on POSIX. Node's net module has no
		//    `mode` option (unlike `fs`), so we chmod after listen() succeeds.
		if (process.platform !== "win32") {
			try {
				await fsp.chmod(sockPath, 0o600);
			} catch (err) {
				// chmod may fail on filesystems that don't support it; log and
				// continue — the directory mode (0700) is the outer defense.
				logInternalError(
					"crew-broker.start.chmod-failed",
					err instanceof Error ? err : new Error(String(err)),
					`path=${redactSecretString(sockPath)}`,
				);
			}
		}

		this.server = server;
		// Phase 1.3: register the mailbox append observer for live fanout.
		// When a durable mailbox append completes, push the message to any
		// connected recipient for that run. Best-effort — never blocks the
		// append path (the notifier uses queueMicrotask internally).
		this.mailboxObserverUnsub = registerMailboxAppendObserver((msg) => {
			this.fanoutMailboxMessage(msg);
		});
		// Server-level safety net: any uncaught server error must not crash
		// the parent. We log and let the close handler clean up.
		server.on("error", (err) => {
			logInternalError(
				"crew-broker.server.error",
				err instanceof Error ? err : new Error(String(err)),
				`sessionId=${this.options.sessionId}`,
			);
		});
	}

	/** Stop the broker. Idempotent. Closes every active connection, unlinks
	 *  ONLY the recorded socket path (never `process.kill`), and clears the
	 *  token registry. Safe to call twice. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		// M3-5/R43-N3: cancel every in-flight grandchild FIRST — broker teardown
		// must not leave delegate spawns running to their own 24h deadline.
		this.delegateAborts.abortAll({ reason: "broker-stop" });
		// Phase 1.3: unregister the mailbox observer before closing connections.
		if (this.mailboxObserverUnsub) {
			try {
				this.mailboxObserverUnsub();
			} catch {
				/* ignore */
			}
			this.mailboxObserverUnsub = null;
		}

		// 1. Close all live connections. We don't surface errors here — stop()
		//    must be idempotent and never throw on individual connection faults.
		for (const conn of [...this.connections]) {
			try {
				conn.closed = true;
				if (conn.helloTimer) {
					clearTimeout(conn.helloTimer);
					conn.helloTimer = null;
				}
				conn.socket.end();
				// Give Node a tick to flush; destroy after a short grace if not.
				setTimeout(() => {
					try {
						conn.socket.destroy();
					} catch {
						/* ignore */
					}
				}, 50).unref();
			} catch (err) {
				logInternalError(
					"crew-broker.stop.close-conn-failed",
					err instanceof Error ? err : new Error(String(err)),
					`sessionId=${this.options.sessionId}`,
				);
			}
		}
		this.connections.clear();

		// 2+4. Close the server AND remove the socket path in one
		//      ownership-gated step. [3] stop-unlink race: libuv unlinks the
		//      bind path BY NAME when the listening handle closes, so the
		//      unlink/shield decision must wrap the close itself — see
		//      broker/socket-stop.ts. We never touch any other path and
		//      never `process.kill` anything.
		const srv = this.server;
		this.server = null;
		const sockPath = this.resolvedSocketPath ?? this.options.socketPath;
		const closeServer = () =>
			new Promise<void>((resolve) => {
				if (!srv) return resolve();
				srv.close(() => resolve());
				// If the server is not currently listening, close() resolves
				// synchronously — guard with a hard timeout for safety.
				setTimeout(() => resolve(), 250).unref();
			});
		if (sockPath && process.platform !== "win32") {
			const outcome = await stopServerAndRemoveSocket(sockPath, this.socketIdentity, closeServer);
			if (outcome === "shielded-foreign" || outcome === "unshielded-foreign") {
				// Path exists but is not provably ours (rebound or never bound):
				// we did not remove it — any corpse is left for
				// removeStaleBrokerSocket at the next start (fail-safe design).
				logInternalError(
					"crew-broker.stop.unlink-skipped",
					new Error(`socket path not provably owned (${outcome}); left for removeStaleBrokerSocket`),
					`path=${redactSecretString(sockPath)}`,
				);
			}
		} else {
			await closeServer();
		}
		this.resolvedSocketPath = null;
		this.socketIdentity = null;

		// 3. Clear the token map. This is the single point where the heap
		//    state for runIds is wiped. No persistence to clean up.
		this.tokens.clear();
		// Task 10: drop the taskId → token index with it.
		this.taskTokens.clear();
	}

	// Connection lifecycle

	private async handleConnection(sock: net.Socket): Promise<void> {
		// B1 (Round 14): a connection event queued after stop() must not be
		// processed — the broker is shutting down and the token registry is
		// already cleared. Destroy (not end) since the server is stopping.
		if (this.stopped) {
			sock.destroy();
			return;
		}
		const conn: ServerConnection = {
			socket: sock,
			decoder: new NdjsonDecoder(),
			authed: false,
			runId: undefined,
			taskId: undefined,
			role: undefined,
			authMatchKind: undefined,
			outbound: [],
			queuedBytes: 0,
			needsResync: false,
			closed: false,
			helloTimer: null,
			outboundSeq: 0,
		};
		this.connections.add(conn);

		// 1. Hello deadline. Fires after HELLO_DEADLINE_MS if hello has not
		//    succeeded. Route through closeConnection so the connection is
		//    properly removed from this.connections + the per-run fanout index.
		conn.helloTimer = setTimeout(() => {
			if (!conn.authed && !conn.closed) {
				logInternalError("crew-broker.hello.deadline", new Error("hello deadline"), `sessionId=${this.options.sessionId}`);
				this.closeConnection(conn);
			}
		}, HELLO_DEADLINE_MS);
		conn.helloTimer.unref?.();

		sock.on("data", (chunk: Buffer) => {
			this.handleData(conn, chunk).catch((err) => {
				logInternalError(
					"crew-broker.connection.data-crashed",
					err instanceof Error ? err : new Error(String(err)),
					`sessionId=${this.options.sessionId}`,
				);
				this.closeConnection(conn);
			});
		});
		sock.on("error", (err) => {
			// socket-level error — log with redaction, then close.
			logInternalError(
				"crew-broker.connection.socket-error",
				err instanceof Error ? err : new Error(String(err)),
				`sessionId=${this.options.sessionId}`,
			);
			this.closeConnection(conn);
		});
		sock.on("close", () => {
			this.closeConnection(conn);
		});
	}

	private closeConnection(conn: ServerConnection): void {
		if (conn.closed) return;
		conn.closed = true;
		if (conn.helloTimer) {
			clearTimeout(conn.helloTimer);
			conn.helloTimer = null;
		}
		this.connections.delete(conn);
		// Phase 1.3: remove from the per-run fanout index.
		if (conn.runId) {
			const set = this.connectionsByRun.get(conn.runId);
			if (set) {
				set.delete(conn);
				if (set.size === 0) {
					this.connectionsByRun.delete(conn.runId);
					// R10-3: no more waiters for this run — drop its stat-gated
					// manifest cache entry so the Map stays bounded across runs.
					this.waitStatusCache.delete(conn.runId);
				}
			}
		}
		// Phase 2: tear down any per-connection event subscriptions.
		const subs = this.subscriptionUnsubs.get(conn);
		if (subs) {
			for (const unsub of subs) {
				try {
					unsub();
				} catch {
					/* ignore */
				}
			}
			subs.clear();
			this.subscriptionUnsubs.delete(conn);
		}
		try {
			conn.socket.destroy();
		} catch {
			/* ignore */
		}
	}

	/**
	 * Phase 1.3: see ./mailbox-observer/mailbox-fanout.ts (M4 / WI-4.1 moved).
	 * Class method delegates with 1-line binding of connectionsByRun + writers.
	 */
	private fanoutMailboxMessage(msg: MailboxMessage): void {
		fanoutMailboxMessage(this.connectionsByRun, { writeOrQueue: (conn, buf, force) => this.writeOrQueue(conn, buf, force) }, msg);
	}

	private async handleData(conn: ServerConnection, chunk: Buffer): Promise<void> {
		if (conn.closed) return;
		let frames: unknown[];
		try {
			frames = conn.decoder.push(chunk);
		} catch (err) {
			// BrokerError from the decoder — typed close.
			if (err instanceof BrokerError) {
				logInternalError("crew-broker.decoder.error", err, `code=${err.code} sessionId=${this.options.sessionId}`);
				this.sendErrorAndClose(conn, undefined, err.code === "oversize-frame" ? "oversize-frame" : "protocol", err.message);
				return;
			}
			throw err;
		}
		for (const frame of frames) {
			await this.dispatchFrame(conn, frame);
			if (conn.closed) return;
		}
	}

	private async dispatchFrame(conn: ServerConnection, frame: unknown): Promise<void> {
		// Validate the frame is a request object.
		if (!isRequestObject(frame)) {
			this.sendErrorAndClose(conn, undefined, "protocol", "malformed request");
			return;
		}
		const { id, method, params } = frame;

		// Hello MUST be the first method. Any other method before hello
		// returns a generic protocol error and closes.
		if (!conn.authed) {
			if (method !== "hello") {
				this.sendErrorAndClose(conn, id, "protocol", "hello required");
				return;
			}
			await this.handleHello(conn, id, params);
			return;
		}

		// Post-hello: dispatch the known set.
		// Task 10 (mux-surface A1 §5.2): a revoked task token is dead on
		// arrival for EVERY frame, not just hellos — an already-authed
		// connection is rejected here, at the next request boundary, with the
		// connection closed (A1: no mid-stream force-close, so the revoke
		// itself never tears a socket out from under a handler).
		// Fix round 1 (BUG #2): WORKER role only — an orchestrator hello may
		// legitimately name a revoked task as its taskId (T11 degrade: revoke
		// → respawn → steer).
		// Fix round 2 (BUG #3): SECRET-based, not key-based — the check
		// evaluates the digest of the secret this connection authenticated
		// with. Looking up the token currently registered for the key let a
		// revoked-secret connection silently regain full capability once the
		// key was re-issued for the respawn (the connection outlived the
		// revoke → re-issue window while staying quiet).
		if (conn.role === "worker" && conn.authedSecretHash !== undefined && this.tokens.isSecretRevoked(conn.authedSecretHash)) {
			this.sendErrorAndClose(conn, id, "revoked", "token revoked");
			return;
		}
		switch (method) {
			case "ping":
				this.sendResult(conn, id, { pong: true, protocol: BROKER_PROTOCOL });
				return;
			case "hello":
				// Repeat hello on the same connection — generic protocol error.
				this.sendErrorAndClose(conn, id, "protocol", "hello already completed");
				return;
			case "msg.send":
				await this.handleMsgSend(conn, id, params);
				return;
			case "msg.inbox":
				await this.handleMsgInbox(conn, id, params);
				return;
			case "events.since":
				await this.handleEventsSince(conn, id, params);
				return;
			case "events.subscribe":
				await this.handleEventsSubscribe(conn, id, params);
				return;
			case "task.waitStatus":
				await this.handleTaskWaitStatus(conn, id, params);
				return;
			case "steer.push":
				await this.handleSteerPush(conn, id, params);
				return;
			case "escalate":
				await this.handleEscalate(conn, id, params);
				return;
			// WP-2/R2 (ADR-0 2026-08-17-waiting-producer-ask items 3,6,7):
			// waiting-producer park/resolve. Task-scoped tokens only;
			// capability-gated via options.waitMethodsEnabled (fail-closed).
			case "wait.request":
				await this.handleWaitRequest(conn, id, params);
				return;
			case "wait.resolve":
				await this.handleWaitResolve(conn, id, params);
				return;
			// T3/R5 (ADR-5 §1): governed-nesting delegation. Task-scoped tokens
			// only; capability-gated via options.nestingEnabled (fail-closed);
			// admission runs the full spawn-policy gate matrix.
			case "delegate.request":
				await this.handleDelegateRequest(conn, id, params);
				return;
			default:
				// Unhandled method → typed not-implemented.
				this.sendError(conn, id, "not-implemented", `method '${method}' is not implemented`);
				return;
		}
	}

	private async handleHello(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		// Validate params shape. We deliberately do NOT disclose which field
		// is wrong — return a generic auth/protocol code.
		if (!isHelloParams(params)) {
			this.sendErrorAndClose(conn, id, "auth", "hello rejected");
			return;
		}
		const { protocol, runId, taskId, token } = params;

		// Protocol must be exactly BROKER_PROTOCOL. Mismatch is a generic
		// auth failure so we don't disclose whether the runId was valid.
		if (protocol !== BROKER_PROTOCOL) {
			this.sendErrorAndClose(conn, id, "auth", "hello rejected");
			return;
		}

		// Token must match. Role is derived from the TOKEN TYPE (orchestrator
		// vs worker), never from a self-declared hello field (F-06: otherwise a
		// worker could forge role:'orchestrator' and call steer.push/msg.send).
		// Constant-time compare; never include the token in the error path.
		// WP-2/R2 (ADR-0 item 6): the match KIND is recorded on the connection
		// (compound vs legacy bare-runId fallback) so wait.* can enforce the
		// task-scoped-token rule without retaining the secret candidate.
		const resolved = this.tokens.tokenRoleWithMatchKind(runId, taskId, token);
		if (resolved === null) {
			// Task 10 (mux-surface A1 §5.2): distinguish a STALE token from a
			// wrong one. A worker re-attaching from a durable surface (broker
			// restarted → heap registry lost, run still on disk) presents a
			// token this broker never issued: when the run exists and the task
			// is real, that is a stale token — reject, but say so, because the
			// A2 remedy is a re-issue, not a retry. An unknown run/task keeps
			// the generic auth error (no disclosure of which id was valid).
			const loaded = loadRunForHello(this.options.cwd, runId);
			if (loaded && (loaded.tasks ?? []).some((t) => t.id === taskId)) {
				this.sendErrorAndClose(
					conn,
					id,
					"stale-token",
					"hello rejected: stale token (run/task exist but this broker did not issue the token; re-issue required)",
				);
				return;
			}
			this.sendErrorAndClose(conn, id, "auth", "hello rejected");
			return;
		}
		// Task 10: the token matches — but an explicitly revoked secret is
		// reported as "revoked" (more specific than stale), and a WORKER token
		// for a TERMINAL run is stale by definition: the run will never issue
		// work again, so a surface worker must not re-attach with it.
		// Orchestrator connections are exempt from BOTH checks: the
		// orchestrator is in-process (same root session) and legitimately
		// talks to the broker after the run completed (late steer, closeout
		// reads) and after a task token was revoked (T11 degrade flow).
		// Fix round 1 (BUG #2): the revoked check keys on (runId, taskId), so
		// without the role guard an orchestrator hello naming a revoked task
		// as its taskId was rejected 'revoked'.
		if (resolved.role === "worker" && this.tokens.isTaskTokenRevoked(runId, taskId)) {
			this.sendErrorAndClose(conn, id, "revoked", "hello rejected: token revoked");
			return;
		}
		if (resolved.role === "worker") {
			const loaded = loadRunForHello(this.options.cwd, runId);
			if (loaded && STALE_RUN_STATUSES.has(loaded.manifest.status)) {
				this.sendErrorAndClose(conn, id, "stale-token", "hello rejected: run is already terminal (stale token)");
				return;
			}
		}

		// taskId/runId/token bounds (non-empty, ≤256) are enforced upstream by isHelloParams — protocol/request-parsers.ts.

		// Bind connection identity and ack. Ack never includes the token.
		conn.authed = true;
		conn.runId = runId;
		conn.taskId = taskId;
		conn.role = resolved.role;
		conn.authMatchKind = resolved.matchKind;
		// Fix round 2 (BUG #3): digest of the authenticated secret for the
		// secret-based frame revocation check below (never the plaintext).
		conn.authedSecretHash = BrokerTokenRegistry.hashToken(token);
		// Phase 1.3: index by runId for live mailbox fanout.
		let connsForRun = this.connectionsByRun.get(runId);
		if (!connsForRun) {
			connsForRun = new Set();
			this.connectionsByRun.set(runId, connsForRun);
		}
		connsForRun.add(conn);
		if (conn.helloTimer) {
			clearTimeout(conn.helloTimer);
			conn.helloTimer = null;
		}
		this.handshakeCount += 1;
		this.sendResult(conn, id, {
			protocol: BROKER_PROTOCOL,
			session: this.options.sessionId,
			run: runId,
			ok: true,
		});
	}

	/** Task 10 (mux-surface A1 §5.2): best-effort manifest load for the hello
	 *  decision path. Returns undefined when no cwd is configured or the run
	 *  is not on disk — callers treat that as "cannot classify" and keep the
	 *  legacy generic-auth behavior (the heap registry stays the source of
	 *  truth for authentication). */
	// loadRunForHello: inlined at the 2 call sites (was a 5-line method; M4/WI-4.1).

	// Outbound queue + drop-newest + resync-close (R6-5)

	private sendResult(conn: ServerConnection, id: string, result: unknown): void {
		this.enqueueFrame(conn, { id, result });
	}

	private sendError(conn: ServerConnection, id: string, code: string, message: string): void {
		this.enqueueFrame(conn, { id, error: { code, message: redactSecretString(message) } });
	}

	private sendErrorAndClose(conn: ServerConnection, id: string | undefined, code: string, message: string): void {
		if (id !== undefined) {
			// Best-effort error frame before close. Even if the queue is full
			// we still try to deliver the close reason.
			try {
				const buf = encodeBrokerFrame({ id, error: { code, message: redactSecretString(message) } });
				this.writeOrQueue(conn, buf, /*force*/ true);
			} catch {
				// encodeBrokerFrame may throw oversize-frame; we still want to
				// close, so swallow.
			}
		}
		this.closeConnection(conn);
	}

	private enqueueFrame(conn: ServerConnection, payload: unknown): void {
		let buf: Buffer;
		try {
			buf = encodeBrokerFrame(payload);
		} catch (err) {
			logInternalError(
				"crew-broker.enqueue.encode-failed",
				err instanceof Error ? err : new Error(String(err)),
				`sessionId=${this.options.sessionId}`,
			);
			// R9-N1 (2026-10-17): silently dropping a REQUEST-RESPONSE frame here
			// (e.g. an events.since replay page larger than MAX_BROKER_FRAME_BYTES)
			// left the client waiting on its id until its request timeout — a
			// hang with no diagnostic. When the payload carries an id, answer it
			// with a small typed error frame on the SAME id; if even that cannot
			// encode, close (the client's reconnect+replay is the only durable
			// answer left).
			const id = (payload as { id?: unknown } | null)?.id;
			if (typeof id === "number" || typeof id === "string") {
				try {
					const errBuf = encodeBrokerFrame({
						id,
						error: { code: "response-oversize", message: "response frame exceeds the broker frame limit" },
					});
					this.writeOrQueue(conn, errBuf, /*force*/ true);
					return;
				} catch {
					/* fall through to close */
				}
			}
			this.closeConnection(conn);
			return;
		}
		// R6-5: request responses (the acks for ping/msg.send/wait.request/…)
		// are response-class — they bypass the drop-newest cap so a saturated
		// fanout queue can no longer swallow an ack and leave the caller to its
		// request-timeout (a delivered send reported "NOT sent").
		this.writeOrQueue(conn, buf, "response");
	}

	private writeOrQueue(conn: ServerConnection, buf: Buffer, force: OutboundAdmission): void {
		writeOrQueueFrame(conn, buf, force, this.options, this.outboundHooks());
	}

	/** R6-5(b): fanout/event frame dropped at cap → typed resync close (moved body in connection-state.ts). */
	private handleOutboundOverflow(conn: ServerConnection): void {
		handleOutboundOverflowFrame(conn, this.options, this.outboundHooks());
	}

	private outboundHooks(): OutboundQueueHooks {
		return {
			onOverflow: (conn) => this.handleOutboundOverflow(conn),
			onClose: (conn) => this.closeConnection(conn),
		};
	}

	// Phase 1: msg.send + msg.inbox handlers

	/** Phase 1.1: direct or broadcast mailbox write via the durable append path. */
	private async handleMsgSend(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		if (!conn.runId) {
			this.sendError(conn, id, "auth", "not authed");
			return;
		}
		// D9/§15.2 role gate: workers may send messages (for notifying the
		// orchestrator, DMing a sibling, or broadcasting the group) with strictly
		// bounded privileges. Orchestrator role keeps its full prior surface
		// (arrays / "all" / steer kinds / arbitrary recipient sets).
		const isWorker = conn.role === "worker";
		if (conn.role !== "orchestrator" && !isWorker) {
			this.sendError(conn, id, "forbidden", "msg.send requires orchestrator or worker role");
			return;
		}
		const parsed = parseMsgSendParams(params);
		if (!parsed) {
			this.sendError(conn, id, "bad-params", "msg.send: invalid params");
			return;
		}
		// Worker constraint (3): kind limited to notify|message. Fire-and-forget
		// `notify` vs inbox-facing `message` — both return immediately to the
		// caller; the distinction is receiver-side handling.
		if (isWorker && parsed.kind !== undefined && parsed.kind !== "notify" && parsed.kind !== "message") {
			this.sendError(conn, id, "bad-params", "msg.send: worker kind must be 'notify' or 'message'");
			return;
		}
		const bodyJson = safeStringify(parsed.body);
		if (bodyJson.length > MAX_BROKER_FRAME_BYTES) {
			this.sendError(conn, id, "oversize-frame", "msg.send: body too large");
			return;
		}
		const cwd = this.options.cwd;
		if (!cwd) {
			this.sendError(conn, id, "no-manifest", "broker has no cwd configured");
			return;
		}
		let manifest: Parameters<typeof appendMailboxMessageAsync>[0];
		let taskIds: string[];
		try {
			const loaded = loadRunManifestById(cwd, conn.runId);
			if (!loaded) {
				this.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
				return;
			}
			manifest = loaded.manifest;
			taskIds = (loaded.tasks ?? []).map((t) => t.id);
		} catch (err) {
			this.sendError(conn, id, "no-manifest", (err as Error).message);
			return;
		}
		// ── Recipient resolution: pure D9/§15.2 matrix in protocol/msg-send-targets.ts (wc-gate).
		const resolved = resolveMsgSendTargets({ isWorker, connTaskId: conn.taskId, to: parsed.to, taskIds });
		if (!resolved.ok) {
			this.sendError(conn, id, resolved.code, resolved.message);
			return;
		}
		const { targets, sentToParent } = resolved;
		const messageId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const fromField = isWorker ? conn.taskId! : (conn.taskId ?? conn.runId);
		// U5: every send carries a unique requestId — client-supplied (idempotent
		// retries reuse the SAME one) or broker-generated. The durable
		// (direction, requestId) index makes resend-after-resume a no-op.
		const requestId = parsed.requestId ?? `${manifest.runId}:${fromField}:${randomUUID()}`;
		let dedupedRecipients = 0;
		let durable = false;
		try {
			// PERF: to:"all" with 50 tasks used to run 50 sequential awaited locked
			// appends while the connection's frames queued behind it. Chunked
			// fan-out — independent mailbox files append concurrently.
			const CHUNK = 8;
			for (let i = 0; i < targets.length; i += CHUNK) {
				const results = await Promise.allSettled(
					targets.slice(i, i + CHUNK).map((target) =>
						appendMailboxMessageIdempotentAsync(manifest, {
							id: `${messageId}_${target.label}`,
							direction: "inbox",
							from: fromField,
							to: target.label,
							taskId: target.mailboxTaskId,
							body: bodyJson,
							kind: parsed.kind ?? "message",
							priority: parsed.priority ?? "normal",
							deliveryMode: "next_turn",
							replyTo: parsed.replyTo,
							requestId,
						}),
					),
				);
				for (const r of results) {
					if (r.status === "fulfilled" && r.value.deduped) dedupedRecipients++;
				}
				const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
				if (failure) throw failure.reason;
			}
			durable = true;
		} catch (err) {
			this.sendError(conn, id, "durable-failed", (err as Error).message);
			return;
		}
		// U5: one bounded audit event per send — requestId + dedup count make
		// the exactly-once chain auditable. Never the body; mailbox rows are
		// the source of truth.
		try {
			await appendEventAsync(manifest.eventsPath, {
				type: "mailbox.send",
				runId: manifest.runId,
				taskId: fromField,
				message: `Mailbox send ${dedupedRecipients > 0 ? "(resend, deduped) " : ""}to ${targets.length} recipient(s).`,
				data: {
					requestId,
					messageId,
					recipients: targets.length,
					deduped: dedupedRecipients,
					kind: parsed.kind ?? "message",
					to: isWorker ? (typeof parsed.to === "string" ? parsed.to : "group") : "orchestrator",
				},
			});
		} catch (err) {
			logInternalError(
				"crew-broker.msg.mailbox-send-event",
				err instanceof Error ? err : new Error(String(err)),
				`runId=${conn.runId}`,
			);
		}
		// Task 5b (spec §15.2 wake): a worker message addressed to the parent
		// appends a bounded `worker.message` run event so the host-side event
		// bus (sidebar/widget refresh) and any live orchestrator connection
		// wake up. Only kind/subject are recorded — NEVER the body, to keep the
		// append-only event log lean. Awaited before the ack so the wake signal
		// is durable by the time the caller proceeds; failure is non-fatal (the
		// mailbox write above is the source of truth).
		if (sentToParent) {
			try {
				await appendEventAsync(manifest.eventsPath, {
					type: "worker.message",
					runId: manifest.runId,
					taskId: fromField,
					data: {
						to: "parent",
						kind: parsed.kind ?? "message",
						...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
						// U5: correlate the wake event with the durable send.
						requestId,
					},
				});
			} catch (err) {
				logInternalError(
					"crew-broker.msg.worker-message-event",
					err instanceof Error ? err : new Error(String(err)),
					`runId=${conn.runId}`,
				);
			}
		}
		this.sendResult(conn, id, {
			messageId,
			requestId,
			recipientCount: targets.length,
			dedupedRecipients,
			durableStatus: durable ? "ok" : "failed",
			liveDeliveryStatus: "ok",
		});
	}

	/** Phase 1.2: paginated inbox pull — see ./protocol/msg-inbox.ts
	 * (M4 / WI-4.1 moved; label corrected 2026-09-10: Phase 1.1 = msg.send). */
	private async handleMsgInbox(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		await handleMsgInbox(
			conn,
			id,
			params,
			{
				sendError: (c, i, code, msg) => this.sendError(c, i, code, msg),
				sendResult: (c, i, r) => this.sendResult(c, i, r),
			},
			this.options.cwd,
		);
	}

	/** Phase 1.5: events.since — bounded replay; clients resync after a missed
	 * live frame (queue overflow / reconnect). See ./protocol/events-replay.ts
	 * (M4 / WI-4.1 moved; Phase 2 = events.subscribe, not this). */
	private async handleEventsSince(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		await handleEventsSince(
			conn,
			id,
			params,
			{
				sendError: (c, i, code, msg) => this.sendError(c, i, code, msg),
				sendResult: (c, i, r) => this.sendResult(c, i, r),
			},
			this.options.cwd,
		);
	}

	/**
	 * Phase 2: events.subscribe — live event-stream subscription.
	 * Replays events with seq > sinceSeq from the durable log, then pushes
	 * live events as they are emitted. Delivery uses the same writeOrQueue
	 * path as mailbox fanout (queue-cap 256, drop-newest on overflow).
	 */
	private async handleEventsSubscribe(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		if (!conn.runId) {
			this.sendError(conn, id, "auth", "not authed");
			return;
		}
		const cwd = this.options.cwd;
		if (!cwd) {
			this.sendError(conn, id, "no-manifest", "broker has no cwd configured");
			return;
		}
		let eventsPath: string;
		try {
			const loaded = loadRunManifestById(cwd, conn.runId);
			if (!loaded) {
				this.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
				return;
			}
			eventsPath = loaded.manifest.eventsPath;
		} catch (err) {
			this.sendError(conn, id, "no-manifest", (err as Error).message);
			return;
		}
		const v = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
		const sinceSeq = typeof v.sinceSeq === "number" && Number.isFinite(v.sinceSeq) ? Math.max(0, Math.floor(v.sinceSeq)) : 0;
		// Live callback: enqueue a serialized event frame onto the connection's
		// outbound queue (non-blocking; queue-cap enforces drop-newest).
		const cb = (event: unknown) => {
			if (conn.closed) return;
			const seq =
				event && typeof event === "object" && "seq" in (event as Record<string, unknown>)
					? ((event as { seq?: unknown }).seq as number | undefined)
					: undefined;
			const eventFrame = encodeBrokerFrame({ event: "team.event", data: event, seq });
			try {
				this.writeOrQueue(conn, eventFrame, false);
			} catch {
				/* a slow/dead client must not break the bus */
			}
		};
		const unsub = runEventBus.onWithReplay(conn.runId, eventsPath, sinceSeq, cb);
		// Track the unsub so closeConnection can tear it down.
		let bucket = this.subscriptionUnsubs.get(conn);
		if (!bucket) {
			bucket = new Set();
			this.subscriptionUnsubs.set(conn, bucket);
		}
		bucket.add(unsub);
		// Auto-cleanup on close.
		const origUnsub = unsub;
		const wrappedUnsub = () => {
			try {
				origUnsub();
			} catch {
				/* ignore */
			}
			const b = this.subscriptionUnsubs.get(conn);
			if (b) b.delete(origUnsub);
		};
		bucket.delete(origUnsub);
		bucket.add(wrappedUnsub);
		this.sendResult(conn, id, { subscribed: true, sinceSeq });
	}

	/**
	 * Phase 2: task.waitStatus — resolve when a task reaches `until` status.
	 * Polls loadRunManifestById + tasks.json mtime with a bounded backoff.
	 * Returns the current task state if already at the target.
	 */
	private async handleTaskWaitStatus(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		if (!conn.runId) {
			this.sendError(conn, id, "auth", "not authed");
			return;
		}
		const cwd = this.options.cwd;
		if (!cwd) {
			this.sendError(conn, id, "no-manifest", "broker has no cwd configured");
			return;
		}
		const v = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
		const targetTaskId = typeof v.taskId === "string" ? v.taskId : undefined;
		const targetStatus = typeof v.until === "string" ? v.until : undefined;
		const timeoutMs =
			typeof v.timeoutMs === "number" && Number.isFinite(v.timeoutMs)
				? Math.min(Math.max(0, Math.floor(v.timeoutMs)), 60_000)
				: 30_000;
		if (!targetTaskId || !targetStatus) {
			this.sendError(conn, id, "bad-params", "task.waitStatus: taskId and until are required");
			return;
		}
		// Reject non-authed identity-supplying params.
		if (targetTaskId.length === 0 || targetTaskId.length > 256) {
			this.sendError(conn, id, "bad-params", "task.waitStatus: taskId out of range");
			return;
		}
		const validStatuses = new Set(["queued", "running", "waiting", "completed", "failed", "blocked", "cancelled"]);
		if (!validStatuses.has(targetStatus)) {
			this.sendError(conn, id, "bad-params", `task.waitStatus: invalid until '${targetStatus}'`);
			return;
		}
		const isTerminal = (s: string) => s === "completed" || s === "failed" || s === "cancelled";
		const start = Date.now();
		const interval = 200; // 200ms poll; bounded by timeoutMs.
		// Properly recursive: the promise returned by `pollUntilDone` only
		// resolves when the task reaches the target status OR the timeout
		// elapses OR the connection closes. Each iteration schedules the
		// next via setTimeout to keep the event loop free.
		const pollUntilDone = (): Promise<void> =>
			new Promise<void>((resolve) => {
				const tick = () => {
					if (conn.closed) {
						this.sendError(conn, id, "close", "connection closed during wait");
						resolve();
						return;
					}
					const connRunId = conn.runId;
					if (!connRunId) {
						this.sendError(conn, id, "auth", "not authed (post-narrow)");
						resolve();
						return;
					}
					if (Date.now() - start >= timeoutMs) {
						this.sendError(conn, id, "wait-timeout", `task did not reach '${targetStatus}' within ${timeoutMs}ms`);
						resolve();
						return;
					}
					try {
						// R10-3: stat-gated cache — parse only when manifest/tasks
						// mtime/size changed; identical observable behavior per poll.
						const loaded = this.waitStatusCache.load(cwd, connRunId);
						if (!loaded) {
							this.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
							resolve();
							return;
						}
						const task = loaded.tasks.find((t) => t.id === targetTaskId);
						if (!task) {
							this.sendError(conn, id, "no-task", `task '${targetTaskId}' not found`);
							resolve();
							return;
						}
						if (task.status === targetStatus || (isTerminal(targetStatus) && isTerminal(task.status))) {
							this.sendResult(conn, id, { taskId: task.id, status: task.status, waitedMs: Date.now() - start });
							resolve();
							return;
						}
					} catch (err) {
						this.sendError(conn, id, "wait-failed", (err as Error).message);
						resolve();
						return;
					}
					setTimeout(tick, interval);
				};
				setTimeout(tick, 0);
			});
		await pollUntilDone();
	}

	/** Phase 3: steer.push — push steering message to a running worker.
	 *  Dual-write for durability: (1) mailbox append feeds the live broker
	 *  fanout AND persists to the inbox JSONL; (2) steering-file append writes
	 *  ${artifactsRoot}/steering/${taskId}.jsonl — the durable fallback the
	 *  child's pollSteering() polls via PI_CREW_STEERING_FILE even when its
	 *  broker connection is down. A steering-file write failure does NOT fail
	 *  the push — the mailbox write has already succeeded. */
	private async handleSteerPush(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		if (conn.role !== "orchestrator") {
			this.sendError(conn, id, "forbidden", "steer.push requires orchestrator role");
			return;
		}
		if (!conn.runId) {
			this.sendError(conn, id, "auth", "not authed");
			return;
		}
		const v = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
		const targetTaskId = typeof v.taskId === "string" ? v.taskId : undefined;
		const body = typeof v.body === "string" ? v.body : undefined;
		// R2-L-A4 (2026-10-17): optional client requestId — mirrors msg.send's U5
		// dedup. An orchestrator retry after ack-loss used to DUPLICATE the steer
		// (mailbox append + steering file); a stable requestId makes the resend a
		// no-op.
		const requestId = typeof v.requestId === "string" && v.requestId.length > 0 ? v.requestId.slice(0, 128) : undefined;
		if (!targetTaskId || body === undefined) {
			this.sendError(conn, id, "bad-params", "steer.push: taskId and body are required");
			return;
		}
		if (body.length > MAX_BROKER_FRAME_BYTES) {
			this.sendError(conn, id, "oversize-frame", "steer.push: body too large");
			return;
		}
		const cwd = this.options.cwd;
		if (!cwd) {
			this.sendError(conn, id, "no-manifest", "broker has no cwd configured");
			return;
		}
		try {
			const loaded = loadRunManifestById(cwd, conn.runId);
			if (!loaded) {
				this.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
				return;
			}

			const messageId = `steer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
			// Write 1: mailbox — live broker fanout + persistent inbox read.
			// R2-L-A4: idempotent append when the client supplied a requestId —
			// resend-after-ack-loss dedupes instead of duplicating the steer.
			let deduped = false;
			if (requestId) {
				const outcome = await appendMailboxMessageIdempotentAsync(loaded.manifest, {
					id: messageId,
					direction: "inbox",
					from: conn.taskId ?? conn.runId,
					to: targetTaskId,
					taskId: targetTaskId,
					body,
					kind: "steer",
					priority: (v.priority as "urgent" | "normal" | "low" | undefined) ?? "urgent",
					deliveryMode: "interrupt",
					requestId,
				});
				deduped = outcome.deduped;
			} else {
				await appendMailboxMessageAsync(loaded.manifest, {
					id: messageId,
					direction: "inbox",
					from: conn.taskId ?? conn.runId,
					to: targetTaskId,
					taskId: targetTaskId,
					body,
					kind: "steer",
					priority: (v.priority as "urgent" | "normal" | "low" | undefined) ?? "urgent",
					deliveryMode: "interrupt",
				});
			}
			// Write 2: steering file — durable fallback so pollSteering() picks
			// up the steer even when the recipient child's broker connection is down. Matches the
			// JSONL format of appendSteeringAsync in task-runner.ts.
			// Best-effort: a failure here must NOT fail the push (mailbox write
			// already succeeded).
			// R2-L-A4: a deduped resend must NOT re-append the steering file either.
			if (!deduped) {
				try {
					const steeringDir = `${loaded.manifest.artifactsRoot}/steering`;
					const steeringPath = resolveRealContainedPath(loaded.manifest.artifactsRoot, `steering/${targetTaskId}.jsonl`);
					// w1a sender binding: the steering file is same-uid writable, so the
					// line must carry this (broker/writer) process's Ed25519 signature —
					// the worker's pollSteering drops unauthenticated lines.
					const line =
						JSON.stringify(
							signSteeringEntry({
								type: "steer",
								message: body,
								id: messageId,
								ts: new Date().toISOString(),
							}),
						) + "\n";
					await fsp.mkdir(steeringDir, { recursive: true });
					await fsp.appendFile(steeringPath, line, "utf-8");
				} catch (fileErr) {
					const safeMessage = fileErr instanceof Error ? redactSecretString(fileErr.message) : "";
					logInternalError("crew-broker.steer-file-write-failed", new Error(safeMessage), `taskId=${targetTaskId}`);
				}
			}
			this.sendResult(conn, id, { messageId, taskId: targetTaskId, durable: true, ...(requestId ? { requestId, deduped } : {}) });
		} catch (err) {
			this.sendError(conn, id, "steer-failed", (err as Error).message);
		}
	}

	/**
	 * Phase 3: escalate — worker → orchestrator question/block.
	 * For Phase 3, the durable path is via the same mailbox append
	 * (kind = "follow-up" or "response") to the orchestrator's task
	 * (conn.taskId of the SENDER, or runId itself). The live-fanout
	 * via the mailbox observer will push the event frame to any connected
	 * orchestrator.
	 */
	private async handleEscalate(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		if (!conn.runId) {
			this.sendError(conn, id, "auth", "not authed");
			return;
		}
		const v = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
		const body = typeof v.body === "string" ? v.body : undefined;
		const to = typeof v.to === "string" ? v.to : undefined;
		if (body === undefined) {
			this.sendError(conn, id, "bad-params", "escalate: body is required");
			return;
		}
		if (body.length > MAX_BROKER_FRAME_BYTES) {
			this.sendError(conn, id, "oversize-frame", "escalate: body too large");
			return;
		}
		const cwd = this.options.cwd;
		if (!cwd) {
			this.sendError(conn, id, "no-manifest", "broker has no cwd configured");
			return;
		}
		// Default recipient: the sender's taskId (the orchestrator that
		// spawned this worker). If 'to' is provided, use it instead.
		// R2-L-A6 (wave-2b): 'to' is SENDER-CHOSEN and lands in a mailbox
		// record (taskId field) — an arbitrary value would let a worker
		// address any task in the run (spoofed follow-up routing). Restrict
		// to the two identities the sender legitimately owns: its run and
		// its own (parent) task.
		if (to !== undefined && to !== conn.runId && to !== conn.taskId) {
			this.sendError(conn, id, "bad-params", `escalate: 'to' must be this connection's run or task`);
			return;
		}
		const target = to ?? conn.taskId ?? conn.runId;
		try {
			const loaded = loadRunManifestById(cwd, conn.runId);
			if (!loaded) {
				this.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
				return;
			}
			const messageId = `esc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
			await appendMailboxMessageAsync(loaded.manifest, {
				id: messageId,
				direction: "inbox",
				from: conn.taskId ?? conn.runId,
				to: target,
				taskId: target,
				body,
				kind: "follow-up",
				priority: (v.priority as "urgent" | "normal" | "low" | undefined) ?? "normal",
				deliveryMode: "next_turn",
			});
			this.sendResult(conn, id, { messageId, to: target, durable: true });
		} catch (err) {
			this.sendError(conn, id, "escalate-failed", (err as Error).message);
		}
	}

	// WP-2/R2: wait.request / wait.resolve (ADR-0 2026-08-17-waiting-producer-ask)
	// waitAuthError: imported directly from protocol/wait-auth.ts (M4/WI-4.1).

	// T3/R5 (ADR-5): delegate.request — governed-nesting admission + background
	// grandchild spawn with durable mailbox delivery (WP-5 step 5).

	/** ADR-5 §5: lazy singleton for the nested-slot budget — first use
	 *  constructs it from the broker options (4 call sites previously
	 *  inlined this IIFE). */
	private nestedSlotBudget(): NestedSlotBudget {
		if (!this.nestedSlots)
			this.nestedSlots = new NestedSlotBudget(this.options.globalWorkerSemaphore ?? 4, this.options.nestingMaxSlots);
		return this.nestedSlots;
	}

	/** RR-023 F4: bounded busy-retry around a run-locked RMW (see
	 *  protocol/lock-busy.ts) — options override or the default schedule.
	 *  A busy-exhausted result is the handler's cue to answer a typed `busy`
	 *  frame (connection survives) instead of letting the throw kill it. */
	private runLockBusyRetry<T>(manifest: TeamRunManifest, fn: () => T): Promise<LockBusyOutcome<T>> {
		return withRunLockBusyRetry(manifest, this.options.lockBusyRetryDelaysMs ?? DEFAULT_LOCK_BUSY_RETRY_DELAYS_MS, fn);
	}

	private recordDelegateEvent(
		manifest: DelegateEventTarget,
		type: DelegateEventType,
		taskId: string,
		data: Record<string, unknown>,
	): void {
		recordDelegateEvent(manifest, type, taskId, data);
	}

	/** T3/R5 (ADR-5): delegate.request — governed-nesting admission + background
	 *  grandchild spawn with durable mailbox delivery (WP-5 step 5). Handler
	 *  body moved to ./crew-broker-delegate-request.ts (wc-gate ITEM C,
	 *  2026-10-27 — pure move, no behavior change; deps threaded via
	 *  DelegateRequestDeps). */
	private async handleDelegateRequest(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		await handleDelegateRequest(conn, id, params, {
			sendError: (c, i, code, msg) => this.sendError(c, i, code, msg),
			sendResult: (c, i, r) => this.sendResult(c, i, r),
			options: this.options,
			nestedSlotBudget: () => this.nestedSlotBudget(),
			recordDelegateEvent: (m, type, taskId, data) => this.recordDelegateEvent(m, type, taskId, data),
			runLockBusyRetry: (manifest, fn) => this.runLockBusyRetry(manifest, fn),
			delegateAborts: this.delegateAborts,
			socketPath: this.socketPath,
			issueRunToken: (runId, taskId) => this.issueRunToken(runId, taskId),
		});
	}

	// recordWaitPolicyRejection: imported directly from protocol/wait-auth.ts.

	/** WP-2/R2 step 4: park the calling task while its `ask` tool awaits a
	 *  leader answer. Park = task.status "waiting" + task.waiting marker +
	 *  manifest.waitState pointer; manifest.status NEVER flips (stays
	 *  "running" — registry entry, sidebar visibility and
	 *  live-executor.isCurrent() all preserved; ADR item 3). Writes happen
	 *  under withRunLockSync with a fresh reload (respond.ts:42-43 discipline).
	 *  deadline = now + min(timeoutSec, 3600): the SERVER clamps —
	 *  worker-controlled timeoutSec may never exceed 1h (ADR P2-7). */
	private async handleWaitRequest(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		if (!conn.runId || !conn.taskId) {
			this.sendError(conn, id, "auth", "not authed");
			return;
		}
		const authErr = waitAuthError(conn);
		if (authErr) {
			this.sendError(conn, id, authErr.code, authErr.message);
			return;
		}
		const parsed = parseWaitRequestParams(params);
		if (!parsed) {
			this.sendError(conn, id, "bad-params", "wait.request: invalid params");
			return;
		}
		// Server-side identity enforcement: `to` MUST equal the authenticated
		// task — a worker may only park ITSELF. (The escalate handler's
		// unvalidated `to` is the recorded anti-pattern; do NOT replicate.)
		if (parsed.to !== conn.taskId) {
			this.sendError(conn, id, "forbidden", "wait.request: 'to' must match the authenticated task");
			return;
		}
		const cwd = this.options.cwd;
		if (!cwd) {
			this.sendError(conn, id, "no-manifest", "broker has no cwd configured");
			return;
		}
		let loaded: NonNullable<ReturnType<typeof loadRunManifestById>>;
		try {
			const l = loadRunManifestById(cwd, conn.runId);
			if (!l) {
				this.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
				return;
			}
			loaded = l;
		} catch (err) {
			this.sendError(conn, id, "no-manifest", (err as Error).message);
			return;
		}
		// Capability gate (ADR item 7): fail-closed, NEVER silent — every
		// rejection leaves a policy.action trace in the run's events.jsonl.
		if (this.options.waitMethodsEnabled !== true) {
			recordWaitPolicyRejection(loaded.manifest, conn.taskId, "wait.request");
			this.sendError(
				conn,
				id,
				"policy-disabled",
				"wait.request is disabled: broker.waitMethodsEnabled=false (fail-closed; policy.action recorded in events.jsonl)",
			);
			return;
		}
		// Server clamp BEFORE any state write (ADR P2-7).
		const requestedSec = parsed.timeoutSec ?? WAIT_REQUEST_TIMEOUT_SEC_DEFAULT;
		const clampSec = Math.min(Math.max(1, Math.floor(requestedSec)), WAIT_REQUEST_TIMEOUT_SEC_MAX);
		const clamped = requestedSec > clampSec;
		const questionId = randomUUID();
		const askedAt = new Date().toISOString();
		const deadline = Date.now() + clampSec * 1000;
		const runId = conn.runId;
		const taskId = conn.taskId;
		// RR-023 F4: run-locked via bounded busy-retry (protocol/lock-busy.ts).
		const outcome = await this.runLockBusyRetry(loaded.manifest, () => {
			// Fresh reload INSIDE the lock (respond.ts:42-43 discipline).
			const fresh = loadRunManifestById(loaded.manifest.cwd, runId);
			if (!fresh) return { code: "no-manifest" as const, message: `run '${runId}' not found` };
			const task = fresh.tasks.find((t) => t.id === taskId);
			if (!task) return { code: "no-task" as const, message: `task '${taskId}' not found` };
			if (task.status !== "running") {
				return { code: "bad-params" as const, message: `wait.request: task '${taskId}' is ${task.status}, not running` };
			}
			const updatedTasks = fresh.tasks.map((t) =>
				t.id === taskId
					? {
							...t,
							status: "waiting" as const,
							waiting: {
								questionId,
								askedAt,
								deadline,
								...(parsed.options ? { options: parsed.options } : {}),
							},
						}
					: t,
			);
			// M4-R1(a) (fix-wave 6 residual, M3-C): `waitState` is a SINGLE
			// run-level slot and `isWaitAnswerPending` (stale-reconciler) reads
			// ONLY it — that slot is the shield keeping a parked (deliberately
			// non-heartbeating) worker from being stale-reaped / orphan-cancelled.
			// Overwriting it unconditionally with the NEWER park SHORTENED the
			// shield whenever the new park asked for a shorter timeout (the
			// clamp allows 1s..1h), so an older, longer park could lose its
			// protection while still awaiting an answer. Same invariant as
			// wait.resolve's repointedWaitState: the slot follows the park with
			// the LATEST deadline — a park never shortens a live shield (living
			// slightly long only delays repair, the fail-safe direction).
			const currentSlot = fresh.manifest.waitState;
			const currentOwner = currentSlot === undefined ? undefined : fresh.tasks.find((t) => t.id === currentSlot.taskId);
			const keepCurrentSlot =
				currentSlot !== undefined &&
				typeof currentSlot.deadline === "number" &&
				currentSlot.deadline > deadline &&
				currentSlot.taskId !== taskId &&
				currentOwner?.status === "waiting" &&
				currentOwner.waiting?.questionId === currentSlot.questionId;
			const updatedManifest = {
				...fresh.manifest,
				// manifest.status stays "running" — park NEVER flips run status (ADR item 3).
				// R2-M-A2: mirror task.waiting.deadline for shield expiry.
				waitState: keepCurrentSlot ? currentSlot : { taskId, questionId, askedAt, deadline },
				updatedAt: askedAt,
			};
			saveRunTasks(updatedManifest, updatedTasks);
			saveRunManifest(updatedManifest);
			return { code: "ok" as const, message: "" };
		});
		// RR-023 F4 (finding #4): run.lock held by a live cross-process holder
		// (e.g. the detached runner) — typed busy frame, connection survives.
		if (!outcome.ok) {
			this.sendError(conn, id, "busy", outcome.message);
			return;
		}
		if (outcome.value.code !== "ok") {
			this.sendError(conn, id, outcome.value.code, outcome.value.message);
			return;
		}
		// Events AFTER the run lock is released (the event-log lock is a
		// separate lock; no cross-lock ordering). task.waiting mirrors the
		// persisted status flip for event-log reconstruction (tasks.json
		// corruption recovery); ask.requested carries the question for the
		// leader/UI. Fire-and-forget: an event failure must not fail the park.
		const eventsPath = loaded.manifest.eventsPath;
		void appendEventAsync(eventsPath, {
			type: "task.waiting",
			runId,
			taskId,
			message: `Task parked awaiting leader answer (question ${questionId}, deadline in ${clampSec}s).`,
			data: { questionId, deadline },
		}).catch((err) =>
			logInternalError("crew-broker.wait.task-waiting-event", err instanceof Error ? err : new Error(String(err)), `runId=${runId}`),
		);
		void appendEventAsync(eventsPath, {
			type: "ask.requested",
			runId,
			taskId,
			message: parsed.question,
			data: {
				questionId,
				deadline,
				timeoutSec: clampSec,
				clamped,
				...(parsed.options ? { options: parsed.options } : {}),
			},
		}).catch((err) =>
			logInternalError("crew-broker.wait.ask-requested-event", err instanceof Error ? err : new Error(String(err)), `runId=${runId}`),
		);
		// B-1 (OSC 7501 program-status): wake the in-process terminal-status
		// wiring — neither `task.waiting` nor `ask.requested` is forwarded on the
		// live UI bus (teamEventToRunEventType maps neither), so without this
		// nudge the blocked-state channels would lag until the next unrelated
		// event. Best-effort: detached brokers emit into their own process
		// (harmless no-op for the host UI; durable state still re-reads on the
		// next host-side wake). The park itself already succeeded above.
		try {
			runEventBus.emit({ type: "mailbox_updated", runId, taskId });
		} catch {
			/* UI wake is best-effort only. */
		}
		this.sendResult(conn, id, {
			ok: true,
			questionId,
			askedAt,
			deadline,
			timeoutSec: clampSec,
			clamped,
		});
		// F1 (2026-09-12 live battery): release the sync foreground waiter with
		// the question (evidence + design notes in broker/wait-push.ts).
		await pushWaitingToForegroundWaiter({
			cwd: this.options.cwd,
			runId,
			taskId,
			questionId,
			question: parsed.question,
			deadline,
			...(parsed.options ? { options: parsed.options } : {}),
		});
	}

	/** WP-2/R2/R3: wait.resolve handler lives in ./protocol/wait-resolve.ts
	 *  (moved out for the wc-gate M4 §5 — pure move, no behavior change). */
	private async handleWaitResolve(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		await handleWaitResolve(
			conn,
			id,
			params,
			{
				sendError: (c, i, code, msg) => this.sendError(c, i, code, msg),
				sendResult: (c, i, r) => this.sendResult(c, i, r),
			},
			{ cwd: this.options.cwd, waitMethodsEnabled: this.options.waitMethodsEnabled },
		);
	}
}

// ============================================================================
// Type guards (no `any`)
// ============================================================================

/** Parsers/constants moved to ./protocol/request-parsers.ts (M4 / WI-4.1):
 *  hello/msg/wait params + safeStringify + WAIT_* constants — re-exported
 *  from there. */
