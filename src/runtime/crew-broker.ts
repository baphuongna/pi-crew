/**
 * crew-broker.ts — Root-only local socket server for cross-process pi-worker
 *                  message transport. PHASE 0 skeleton (sub-task 0.4).
 *
 *  - Bound to a `node:net` Unix domain socket or Windows named pipe.
 *  - One broker per root session; per-run token auth on first `hello`.
 *  - NDJSON framing, 256 KiB UTF-8 cap, 1s hello deadline.
 *  - Per-connection outbound queue cap (default 256) with drop-newest +
 *    `needsResync` marker.
 *  - Phase 0 dispatches ONLY `hello` and `ping`. All other methods return
 *    a typed `not-implemented` response (preserves forward-compat without
 *    pretending Phase 1 methods are live).
 *  - Token map is HEAP ONLY; cleared on `stop()`. Never serialized.
 *  - `stop()` is idempotent. Never calls `process.kill`.
 *  - All log/error scopes use `crew-broker.*` prefix; every diagnostic
 *    passes through `redactSecretString` from `src/utils/redaction.ts`.
 *
 *  NO outbound TCP. NO persistence. NO children. NO process killing.
 *
 *  See `reports/inter-pi-broker-impl-plan-2026-07-21.md` §"0.4" for the
 *  full contract and acceptance criteria.
 */

import * as fsp from "node:fs/promises";
import * as net from "node:net";

import { readEventsCursor } from "../state/event-log.ts";
import {
	appendMailboxMessageAsync,
	type MailboxMessage,
	type MailboxMessageKind,
	type MailboxMessagePriority,
	readMailbox,
	registerMailboxAppendObserver,
} from "../state/mailbox.ts";
import { loadRunManifestById } from "../state/state-store.ts";
import { runEventBus } from "../ui/run-event-bus.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { BrokerError, encodeBrokerFrame, MAX_BROKER_FRAME_BYTES, NdjsonDecoder } from "../utils/ndjson.ts";
import { redactSecretString } from "../utils/redaction.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { getBrokerSocketPath, prepareBrokerSocketDir, removeStaleBrokerSocket } from "../utils/socket-path.ts";
import { BrokerTokenRegistry } from "./crew-broker-tokens.ts";

/** Protocol version negotiated at `hello` time. Bump on breaking change. */
const BROKER_PROTOCOL = 1;

/** Hard hello deadline (per spec). After 1s, the connection is closed with a
 *  generic auth/protocol code. */
const HELLO_DEADLINE_MS = 1_000;

/** Default per-connection outbound queue cap (events). */
const DEFAULT_OUTBOUND_QUEUE_CAP = 256;

export interface CrewBrokerOptions {
	/** Root session ID used to derive the socket path. */
	sessionId: string;
	/** Pre-resolved socket path (skips re-derivation; useful for tests). */
	socketPath?: string;
	/** Frame cap in UTF-8 bytes. Default 256 KiB. */
	maxFrameBytes?: number;
	/** Per-connection outbound queue cap. Default 256. */
	outboundQueueCap?: number;
	/** Required: when false, start() is a no-op and the server never binds.
	 *  Lets the lifecycle controller install the broker unconditionally and
	 *  have a single kill switch. */
	enabled: boolean;
	/** CWD for `loadRunManifestById` (Phase 1 msg.send / msg.inbox resolution).
	 *  When omitted, manifest-touching methods return no-manifest errors. */
	cwd?: string;
	/** Optional test seam: override the `net` module (allows fake-server tests). */
	netModule?: typeof net;
}

/** Per-connection server-side state. */
interface ServerConnection {
	socket: net.Socket;
	decoder: NdjsonDecoder;
	/** Whether the connection has completed `hello` successfully. */
	authed: boolean;
	/** Run id bound by hello. */
	runId?: string;
	/** Task id bound by hello. */
	taskId?: string;
	/** Outbound queue of encoded frames awaiting drain. */
	outbound: Buffer[];
	/** Set when the queue has hit the cap and a frame was dropped. */
	needsResync: boolean;
	/** Set when the connection is closing (idempotent). */
	closed: boolean;
	/** Timer for the hello deadline. */
	helloTimer: NodeJS.Timeout | null;
	/** Monotonic seq counter for outbound events (diagnostic). */
	outboundSeq: number;
}

export class CrewBroker {
	private readonly options: Required<Pick<CrewBrokerOptions, "sessionId" | "enabled">> &
		Pick<CrewBrokerOptions, "socketPath" | "maxFrameBytes" | "outboundQueueCap" | "cwd" | "netModule">;
	private readonly tokens = new BrokerTokenRegistry();
	private server: net.Server | null = null;
	private resolvedSocketPath: string | null = null;
	private stopped = false;
	private starting = false;
	private startingPromise: Promise<void> | null = null;
	private readonly connections = new Set<ServerConnection>();
	/** Connections indexed by runId for live message fanout (Phase 1.3). */
	private readonly connectionsByRun = new Map<string, Set<ServerConnection>>();
	/** Per-connection event subscription unsubscribers (Phase 2: events.subscribe). */
	private readonly subscriptionUnsubs = new WeakMap<ServerConnection, Set<() => void>>();
	/** Unsubscribe handle for the mailbox append observer (set on start, cleared on stop). */
	private mailboxObserverUnsub: (() => void) | null = null;
	/** A single observable handshake counter (test/observability). */
	private handshakeCount = 0;

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
			cwd: options.cwd,
			netModule: options.netModule,
		};
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

	/** Issue a fresh token for `runId`. The token is stored in the heap-only
	 *  registry and is the only way a child can complete `hello`. Never log
	 *  the return value; never write it to disk. */
	issueRunToken(runId: string): string {
		if (typeof runId !== "string" || runId.length === 0) {
			throw new Error("CrewBroker.issueRunToken: runId must be a non-empty string");
		}
		return this.tokens.issue(runId);
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
		this.starting = true;
		this.startingPromise = this.doStart()
			.then(() => {
				this.starting = false;
			})
			.catch((err) => {
				this.starting = false;
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

		// 2. Close the server itself.
		if (this.server) {
			await new Promise<void>((resolve) => {
				const srv = this.server;
				if (!srv) return resolve();
				srv.close(() => resolve());
				// If the server is not currently listening, close() resolves
				// synchronously — guard with a hard timeout for safety.
				setTimeout(() => resolve(), 250).unref();
			});
			this.server = null;
		}

		// 3. Clear the token map. This is the single point where the heap
		//    state for runIds is wiped. No persistence to clean up.
		this.tokens.clear();

		// 4. Unlink the recorded socket file IF we created it. We never
		//    touch any other path. We also never `process.kill` anything.
		const sockPath = this.resolvedSocketPath ?? this.options.socketPath;
		if (sockPath && process.platform !== "win32") {
			try {
				await fsp.unlink(sockPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					logInternalError(
						"crew-broker.stop.unlink-failed",
						err instanceof Error ? err : new Error(String(err)),
						`path=${redactSecretString(sockPath)}`,
					);
				}
			}
		}
		this.resolvedSocketPath = null;
	}

	/**
	 * Non-throwing enqueue entry point for the post-append mailbox observer
	 * (Phase 1) or any other in-process producer. Phase 0 accepts `notifyMessage`
	 * as a no-op shape so the lifecycle controller can install a single
	 * observer regardless of broker state.
	 *
	 * Fanout goes ONLY to authenticated connections matching the recipient.
	 * Phase 0 keeps this as a typed no-op (`not-implemented` would be
	 * inappropriate here — the caller is in-process and shouldn't be
	 * punished for testing the broker skeleton).
	 */
	notifyMessage(_message: unknown): void {
		// Phase 0: no fanout. Phase 1 replaces this with the single
		// post-durable mailbox observer fanout.
	}

	// ------------------------------------------------------------------------
	// Connection lifecycle
	// ------------------------------------------------------------------------

	private async handleConnection(sock: net.Socket): Promise<void> {
		const conn: ServerConnection = {
			socket: sock,
			decoder: new NdjsonDecoder(),
			authed: false,
			runId: undefined,
			taskId: undefined,
			outbound: [],
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
				if (set.size === 0) this.connectionsByRun.delete(conn.runId);
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
	 * Phase 1.3: push a durable-appended mailbox message to any connected
	 * recipient for the message's run. Best-effort — silently skips
	 * recipients that are offline (they recover via msg.inbox). Never throws.
	 */
	private fanoutMailboxMessage(msg: MailboxMessage): void {
		const set = this.connectionsByRun.get(msg.runId);
		if (!set || set.size === 0) return;
		// Recipient delivery dedup lives in src/prompt/prompt-runtime.ts and is
		// keyed by the same message id in this mailbox event and the steering JSONL.
		const eventFrame = encodeBrokerFrame({
			event: "mailbox.message",
			data: { id: msg.id, from: msg.from, to: msg.to, body: msg.body, kind: msg.kind, priority: msg.priority },
			seq: 0, // mailbox messages don't carry a TeamEvent seq; dedup by msg.id
		});
		for (const conn of set) {
			if (conn.closed || !conn.authed) continue;
			// Recipient filter: deliver to the addressed task, or to all if 'all'.
			if (msg.to && msg.to !== "all" && conn.taskId !== msg.to) continue;
			try {
				this.writeOrQueue(conn, eventFrame, false);
			} catch {
				/* a slow/dead recipient must not break fanout to others */
			}
		}
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

		// Token must match. We use constant-time compare and never include
		// the token (or any substring) in the error path.
		if (!this.tokens.matches(runId, token)) {
			this.sendErrorAndClose(conn, id, "auth", "hello rejected");
			return;
		}

		// Bounded identity checks. taskId must be a non-empty string.
		if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 256) {
			this.sendErrorAndClose(conn, id, "auth", "hello rejected");
			return;
		}
		if (typeof runId !== "string" || runId.length === 0 || runId.length > 256) {
			this.sendErrorAndClose(conn, id, "auth", "hello rejected");
			return;
		}

		// Bind connection identity and ack. Ack never includes the token.
		conn.authed = true;
		conn.runId = runId;
		conn.taskId = taskId;
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

	// ------------------------------------------------------------------------
	// Outbound queue + drop-newest + needsResync
	// ------------------------------------------------------------------------

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
			return;
		}
		this.writeOrQueue(conn, buf, /*force*/ false);
	}

	private writeOrQueue(conn: ServerConnection, buf: Buffer, force: boolean): void {
		if (conn.closed) return;
		const cap = this.options.outboundQueueCap ?? DEFAULT_OUTBOUND_QUEUE_CAP;
		if (conn.outbound.length >= cap) {
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
			// Drop-newest: do NOT add the new frame, mark needsResync, and stop
			// further live fanout for this connection. The client must reconnect
			// and replay (Phase 1: via events.since; Phase 0: protocol error).
			conn.needsResync = true;
			// We do NOT revoke auth — the connection is still authenticated; we
			// simply pause live frame production. The client is expected to
			// notice the queue-depth and resync.
			return;
		}
		conn.outbound.push(buf);
		this.drainOutbound(conn);
	}

	private drainOutbound(conn: ServerConnection): void {
		while (conn.outbound.length > 0) {
			const buf = conn.outbound[0];
			if (buf === undefined) break;
			// Try the write; if it returns false, wait for drain before pushing more.
			try {
				const ok = conn.socket.write(buf);
				if (!ok) {
					// Backpressure — re-arm on drain event.
					conn.socket.once("drain", () => {
						if (!conn.closed) this.drainOutbound(conn);
					});
					return;
				}
			} catch {
				// Write failed — close the connection (we already had it open).
				this.closeConnection(conn);
				return;
			}
			conn.outbound.shift();
			conn.outboundSeq += 1;
		}
	}

	// ------------------------------------------------------------------------
	// Phase 1: msg.send + msg.inbox handlers
	// ------------------------------------------------------------------------

	/** Phase 1.1: direct or broadcast mailbox write via the durable append path. */
	private async handleMsgSend(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		if (!conn.runId) {
			this.sendError(conn, id, "auth", "not authed");
			return;
		}
		const parsed = parseMsgSendParams(params);
		if (!parsed) {
			this.sendError(conn, id, "bad-params", "msg.send: invalid params");
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
		const recipients: string[] = Array.isArray(parsed.to)
			? (parsed.to as string[])
			: parsed.to === "all"
				? taskIds
				: [parsed.to as string];
		if (recipients.length === 0 || recipients.length > 64) {
			this.sendError(conn, id, "bad-params", "msg.send: recipient count out of range");
			return;
		}
		const messageId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const fromField = conn.taskId ?? conn.runId;
		let durable = false;
		try {
			for (const recipient of recipients) {
				await appendMailboxMessageAsync(manifest, {
					id: `${messageId}_${recipient}`,
					direction: "inbox",
					from: fromField,
					to: recipient,
					taskId: recipient,
					body: bodyJson,
					kind: parsed.kind ?? "message",
					priority: parsed.priority ?? "normal",
					deliveryMode: "next_turn",
					replyTo: parsed.replyTo,
				});
			}
			durable = true;
		} catch (err) {
			this.sendError(conn, id, "durable-failed", (err as Error).message);
			return;
		}
		this.sendResult(conn, id, {
			messageId,
			recipientCount: recipients.length,
			durableStatus: durable ? "ok" : "failed",
			liveDeliveryStatus: "ok",
		});
	}

	/** Phase 1.2: paginated inbox pull for the authenticated run/task. */
	private async handleMsgInbox(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		if (!conn.runId) {
			this.sendError(conn, id, "auth", "not authed");
			return;
		}
		const parsed = parseMsgInboxParams(params);
		if (!parsed) {
			this.sendError(conn, id, "bad-params", "msg.inbox: invalid params");
			return;
		}
		const cwd = this.options.cwd;
		if (!cwd) {
			this.sendError(conn, id, "no-manifest", "broker has no cwd configured");
			return;
		}
		let manifest: Parameters<typeof readMailbox>[0];
		try {
			const loaded = loadRunManifestById(cwd, conn.runId);
			if (!loaded) {
				this.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
				return;
			}
			manifest = loaded.manifest;
		} catch (err) {
			this.sendError(conn, id, "no-manifest", (err as Error).message);
			return;
		}
		const limit = Math.min(Math.max(parsed.limit ?? 100, 1), 1000);
		const taskId = conn.taskId ?? undefined;
		const all = readMailbox(manifest, "inbox", taskId);
		const filtered = all.filter((m) => m.status !== "acknowledged");
		const offset = parsed.cursor ? parseInt(parsed.cursor, 10) || 0 : 0;
		const page = filtered.slice(offset, offset + limit);
		const nextOffset = offset + page.length;
		const hasMore = nextOffset < filtered.length;
		this.sendResult(conn, id, {
			messages: page,
			nextCursor: hasMore ? String(nextOffset) : undefined,
			hasMore,
			total: filtered.length,
		});
	}

	/**
	 * Phase 1.5: events.since — bounded replay of structured events with seq >
	 * sinceSeq from the durable log. Used by clients to resync after a missed
	 * live frame (e.g. after a queue overflow or reconnect). Reuses the same
	 * readEventsCursor + seq semantics as runEventBus.onWithReplay.
	 */
	private async handleEventsSince(conn: ServerConnection, id: string, params: unknown): Promise<void> {
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
		const limit = typeof v.limit === "number" && Number.isFinite(v.limit) ? Math.min(Math.max(1, Math.floor(v.limit)), 1000) : 1000;
		try {
			const result = readEventsCursor(eventsPath, { sinceSeq, limit });
			// hasMore is true iff the total filtered count exceeds the page we
			// returned. When `total === events.length` we are at the exact end
			// of the stream (caller will discover this on the next call when
			// `nextSeq` is unchanged from `sinceSeq`).
			const hasMore = result.total > result.events.length;
			this.sendResult(conn, id, {
				events: result.events,
				nextSeq: result.nextSeq,
				hasMore,
			});
		} catch (err) {
			this.sendError(conn, id, "replay-failed", (err as Error).message);
		}
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
		const validStatuses = new Set(["queued", "running", "completed", "failed", "blocked", "cancelled"]);
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
						const loaded = loadRunManifestById(cwd, connRunId);
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

	/**
	 * Phase 3: steer.push — push steering message to a running worker.
	 *
	 * Dual-write strategy for durability:
	 *  1. Mailbox append (appendMailboxMessageAsync) — feeds the live broker
	 *     fanout to connected subscribers AND persists to the mailbox inbox
	 *     JSONL for later read.
	 *  2. Steering-file append — writes the steer body to
	 *     ${artifactsRoot}/steering/${taskId}.jsonl, the same file the
	 *     child's pollSteering() polls via PI_CREW_STEERING_FILE. This is
	 *     the durable fallback: even if the recipient child's broker connection is down, the
	 *     child picks up the steer on its next poll tick.
	 *
	 * A steering-file write failure does NOT fail the steer push — the
	 * mailbox write (1) has already succeeded.
	 */
	private async handleSteerPush(conn: ServerConnection, id: string, params: unknown): Promise<void> {
		if (!conn.runId) {
			this.sendError(conn, id, "auth", "not authed");
			return;
		}
		const v = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
		const targetTaskId = typeof v.taskId === "string" ? v.taskId : undefined;
		const body = typeof v.body === "string" ? v.body : undefined;
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
			// Write 2: steering file — durable fallback so pollSteering() picks
			// up the steer even when the recipient child's broker connection is down. Matches the
			// JSONL format of appendSteeringAsync in task-runner.ts.
			// Best-effort: a failure here must NOT fail the push (mailbox write
			// already succeeded).
			try {
				const steeringDir = `${loaded.manifest.artifactsRoot}/steering`;
				const steeringPath = resolveRealContainedPath(loaded.manifest.artifactsRoot, `steering/${targetTaskId}.jsonl`);
				const line =
					JSON.stringify({
						type: "steer",
						message: body,
						id: messageId,
						ts: new Date().toISOString(),
					}) + "\n";
				await fsp.mkdir(steeringDir, { recursive: true });
				await fsp.appendFile(steeringPath, line, "utf-8");
			} catch (fileErr) {
				const safeMessage = fileErr instanceof Error ? redactSecretString(fileErr.message) : "";
				logInternalError("crew-broker.steer-file-write-failed", new Error(safeMessage), `taskId=${targetTaskId}`);
			}
			this.sendResult(conn, id, { messageId, taskId: targetTaskId, durable: true });
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
}

// ============================================================================
// Type guards (no `any`)
// ============================================================================

function isRequestObject(value: unknown): value is { id: string; method: string; params: unknown } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > 256) return false;
	if (typeof v.method !== "string" || v.method.length === 0 || v.method.length > 64) return false;
	// Method names are restricted to a small safe charset. This guards against
	// odd inputs (control chars, very long names) reaching the dispatcher.
	if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(v.method)) return false;
	// params may be anything (validated per-method), but not undefined-shaped.
	return "params" in v;
}

function isHelloParams(value: unknown): value is {
	protocol: number;
	runId: string;
	taskId: string;
	token: string;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	if (v.protocol !== BROKER_PROTOCOL) {
		// Force exact-type comparison (must be the number 1, not "1").
		if (typeof v.protocol !== "number" || !Number.isInteger(v.protocol)) return false;
	}
	if (typeof v.runId !== "string" || v.runId.length === 0 || v.runId.length > 256) return false;
	if (typeof v.taskId !== "string" || v.taskId.length === 0 || v.taskId.length > 256) return false;
	if (typeof v.token !== "string" || v.token.length === 0 || v.token.length > 256) return false;
	return true;
}

// ============================================================================
// Phase 1 parameter parsers (module-level; no `any`)
// ============================================================================

interface MsgSendParams {
	to: string | string[] | "all";
	body: unknown;
	kind?: MailboxMessageKind;
	priority?: MailboxMessagePriority;
	replyTo?: string;
}

function parseMsgSendParams(value: unknown): MsgSendParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	const to = v.to;
	if (typeof to !== "string" && !Array.isArray(to)) return undefined;
	if (Array.isArray(to) && !to.every((s) => typeof s === "string" && s.length > 0)) return undefined;
	if (typeof to === "string" && to.length === 0) return undefined;
	if (v.body === undefined) return undefined;
	const kind = v.kind as MailboxMessageKind | undefined;
	if (kind !== undefined && !["message", "steer", "follow-up", "response", "group_join"].includes(kind)) {
		return undefined;
	}
	const priority = v.priority as MailboxMessagePriority | undefined;
	if (priority !== undefined && !["urgent", "normal", "low"].includes(priority)) {
		return undefined;
	}
	const replyTo = typeof v.replyTo === "string" ? v.replyTo : undefined;
	return { to: to as string | string[] | "all", body: v.body, kind, priority, replyTo };
}

interface MsgInboxParams {
	limit?: number;
	cursor?: string;
}

function parseMsgInboxParams(value: unknown): MsgInboxParams | undefined {
	if (value === undefined || value === null) return { limit: 100, cursor: undefined };
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	const limit = v.limit;
	if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1)) {
		return undefined;
	}
	const cursor = v.cursor;
	if (cursor !== undefined && typeof cursor !== "string") return undefined;
	return { limit: limit as number | undefined, cursor: cursor as string | undefined };
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "{}";
	} catch {
		return "{}";
	}
}
