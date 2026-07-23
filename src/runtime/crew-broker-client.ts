/**
 * crew-broker-client.ts — Child-side connector for the local broker.
 *                       PHASE 0 skeleton (sub-task 0.3).
 *
 *  - Connects only on the first request/subscribe.
 *  - Sends `hello` first; any other method before ack is a protocol error.
 *  - Bounded backoff (50/100/200/400/800 ms + jitter, max 4 attempts).
 *    After exhaustion, no hot reconnect loop is scheduled. The only way back
 *    to the live path is an explicit `reconnect()` (or a new worker lifecycle).
 *  - On ANY connect/auth/timeout/close error, transitions to `fallback` mode
 *    and never lets an exception escape `request()` / `subscribe()`. The
 *    caller can read `client.mode` or the `{ok:false, fallback:true}` result
 *    and continue using today's file-based paths.
 *  - `close()` removes all listeners and pending requests.
 *  - All diagnostic strings pass through `redactSecretString` from
 *    `src/utils/redaction.ts`. Token and payload bytes are never logged.
 *
 *  No process management. No children. No socket listening. Connect-only.
 *
 *  See `reports/inter-pi-broker-impl-plan-2026-07-21.md` §"0.3" for the
 *  full contract and acceptance criteria.
 */

import { randomUUID } from "node:crypto";
import * as net from "node:net";

import { logInternalError } from "../utils/internal-error.ts";
import { BrokerError, encodeBrokerFrame, NdjsonDecoder } from "../utils/ndjson.ts";
import { redactSecretString } from "../utils/redaction.ts";

/** Shape of an unsolicited event frame pushed by the broker (mailbox.message,
 *  team.event, etc.). */
export interface BrokerEventFrame {
	event: string;
	data: unknown;
	seq?: number;
}

/** Protocol version negotiated at hello. Must match the broker. */
const BROKER_PROTOCOL = 1;

/** Per-attempt timeout for connect + hello. */
const CONNECT_HELLO_TIMEOUT_MS = 5_000;

/** Bounded backoff schedule (ms). At most 4 attempts means 3 retries after
 *  the first failure. Jitter is ±25%. */
const BACKOFF_SCHEDULE_MS: readonly number[] = [50, 100, 200, 400, 800] as const;
/** Hard cap on the number of attempts. 4 total = 1 initial + 3 retries. */
const MAX_ATTEMPTS = 4;

export type BrokerClientMode = "unstarted" | "connected" | "fallback";

export type BrokerClientResult<T> = { ok: true; value: T } | { ok: false; fallback: true; errorCode?: string; error?: Error };

export interface CrewBrokerClientOptions {
	runId: string;
	taskId: string;
	/** Pre-resolved socket path. If absent, the client is permanently
	 *  fallback (caller forgot to wire spawn context). */
	socketPath?: string;
	/** Per-run token. If absent, the client is permanently fallback. */
	token?: string;
	/** Override `process.env` (used by tests). */
	env?: NodeJS.ProcessEnv;
	/** Test seam: override the `net` module. */
	netModule?: typeof net;
	/** Test seam: clock for backoff scheduling. */
	now?: () => number;
	/** Test seam: timer factory. */
	setTimeoutFn?: (cb: () => void, ms: number) => NodeJS.Timeout;
	/** Test seam: clear timer. */
	clearTimeoutFn?: (timer: NodeJS.Timeout) => void;
	/** Test seam: random jitter source (returns a multiplier in [0.75, 1.25]). */
	jitter?: () => number;
	/** Handler for unsolicited event frames pushed by the broker after hello
	 *  (e.g. `mailbox.message`, `team.event`). When omitted, event frames are
	 *  silently ignored (Phase 0 behavior). Never throws into the socket loop. */
	onEvent?: (event: BrokerEventFrame) => void;
}

interface PendingRequest {
	id: string;
	method: string;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

export class CrewBrokerClient {
	private readonly options: Required<Pick<CrewBrokerClientOptions, "runId" | "taskId">> &
		Pick<
			CrewBrokerClientOptions,
			"socketPath" | "token" | "env" | "netModule" | "now" | "setTimeoutFn" | "clearTimeoutFn" | "jitter" | "onEvent"
		>;
	private _mode: BrokerClientMode = "unstarted";
	private socket: net.Socket | null = null;
	private decoder: NdjsonDecoder | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private attempts = 0;
	/** Listeners attached to the current socket; kept for explicit close(). */
	private readonly socketListeners: Array<{
		event: string;
		listener: (...args: unknown[]) => void;
	}> = [];
	/** Set in close(); gates reconnect attempts and backoff loops. */
	private closed = false;
	/** Handle to the in-flight backoff timer so close() can cancel it. */
	private backoffTimer: NodeJS.Timeout | null = null;
	/** Resolver for the in-flight backoff await so close() can unblock it.
	 *  Without this, cancelling the timer leaves the connectAndHello await
	 *  hanging forever (resolve() never fires). */
	private backoffResolver: (() => void) | null = null;

	constructor(options: CrewBrokerClientOptions) {
		if (!options || typeof options !== "object") {
			throw new Error("CrewBrokerClient: options is required");
		}
		if (typeof options.runId !== "string" || options.runId.length === 0) {
			throw new Error("CrewBrokerClient: runId must be a non-empty string");
		}
		if (typeof options.taskId !== "string" || options.taskId.length === 0) {
			throw new Error("CrewBrokerClient: taskId must be a non-empty string");
		}
		this.options = {
			runId: options.runId,
			taskId: options.taskId,
			socketPath: options.socketPath,
			token: options.token,
			env: options.env,
			netModule: options.netModule,
			now: options.now,
			setTimeoutFn: options.setTimeoutFn,
			clearTimeoutFn: options.clearTimeoutFn,
			jitter: options.jitter,
			onEvent: options.onEvent,
		};
	}

	get mode(): BrokerClientMode {
		return this._mode;
	}

	/** Diagnostic: number of currently-pending requests. */
	get pendingCount(): number {
		return this.pending.size;
	}

	/**
	 * Send a request. Returns:
	 *   - `{ok:true, value}` on success.
	 *   - `{ok:false, fallback:true, errorCode?}` on any connect/auth/
	 *     timeout/close/protocol error. The client transitions to fallback
	 *     for its lifetime; only `reconnect()` may move it back to "unstarted".
	 *
	 * Never throws. The caller can continue using file-based fallback paths
	 * without unwrapping anything.
	 */
	async request<T = unknown>(method: string, params: unknown): Promise<BrokerClientResult<T>> {
		if (this._mode === "fallback") {
			return { ok: false, fallback: true, errorCode: "fallback-sticky" };
		}
		if (typeof method !== "string" || method.length === 0) {
			return { ok: false, fallback: true, errorCode: "bad-method" };
		}

		// Lazy connect + hello on first use.
		if (this._mode === "unstarted" || !this.socket) {
			const connectResult = await this.connectAndHello();
			if (!connectResult.ok) {
				return connectResult;
			}
		}

		if (!this.socket) {
			return { ok: false, fallback: true, errorCode: "no-socket" };
		}

		// Send the request. Send a frame FIRST so the server's hello gate
		// cannot reject it as "method other than hello".
		const id = `r-${randomUUID()}`;
		const promise = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { id, method, resolve, reject });
		});
		try {
			const frame = encodeBrokerFrame({ id, method, params });
			// Write may emit EPIPE etc. We don't await drain here — the response
			// promise handles the rest.
			this.socket.write(frame);
		} catch (err) {
			// encodeBrokerFrame can throw on oversize. The socket is still
			// alive but the request is bad.
			this.pending.delete(id);
			return { ok: false, fallback: true, errorCode: "encode-failed" };
		}

		try {
			const value = await promise;
			// Detect the tagged broker-error envelope: per-request errors
			// (bad-params, no-manifest, wait-timeout, etc.) resolve with
			// `{__brokerError:true, code, message}` and do NOT enter fallback.
			if (value && typeof value === "object" && (value as { __brokerError?: boolean }).__brokerError === true) {
				const e = value as { code: string; message: string };
				return { ok: false, fallback: true, errorCode: e.code };
			}
			return { ok: true, value: value as T };
		} catch (err) {
			// Reject from pending handlers → the typed error code.
			const code = err instanceof BrokerError ? err.code : "request-failed";
			this.enterFallbackOnce(code, err);
			return { ok: false, fallback: true, errorCode: code };
		}
	}

	/**
	 * Subscribe to a per-run event stream. Phase 0 does not implement
	 * events.since — the subscription returns a no-op unsubscribe and
	 * transitions to fallback if the connection is lost. The caller can
	 * continue using the file poll path.
	 */
	subscribe(options: { runId: string; sinceSeq: number; onEvent: (event: unknown) => void }): () => void {
		// Phase 0: subscription is a typed not-implemented. We register a
		// no-op unsubscribe so the caller can call it without errors.
		void options;
		return () => {
			/* no-op */
		};
	}

	/**
	 * Explicit reconnect. Resets `mode` to `unstarted` and clears the
	 * backoff counter. Returns true if a fresh connection succeeded,
	 * false otherwise (mode becomes `fallback` on failure). Use this
	 * after a known broker restart.
	 */
	async reconnect(): Promise<boolean> {
		// Close the current socket if any.
		this.teardownSocket();
		this.attempts = 0;
		this._mode = "unstarted";
		const res = await this.request("ping", null);
		return res.ok;
	}

	/**
	 * Close the client. Removes all socket listeners, rejects all pending
	 * requests with a clean fallback result, and transitions to fallback
	 * (so a subsequent request() returns a typed error rather than
	 * reconnecting in the background).
	 */
	async close(): Promise<void> {
		// Set the closed flag FIRST so any backoff-loop iteration that
		// resumes after teardownSocket (e.g. after a queued backoff timer
		// fires) sees it and returns immediately with a typed error.
		this.closed = true;
		// Cancel any queued backoff timer. Without this, the in-flight
		// connectAndHello would resume its retry loop after close() and
		// create new sockets against a torn-down client.
		if (this.backoffTimer !== null) {
			try {
				(this.options.clearTimeoutFn ?? ((t: NodeJS.Timeout) => clearTimeout(t)))(this.backoffTimer);
			} catch {
				/* ignore — best-effort cancel */
			}
			this.backoffTimer = null;
		}
		// Unblock the in-flight backoff await. Cancelling the timer alone
		// leaves the connectAndHello Promise stuck on resolve(); this lets
		// the loop unblock, observe this.closed, and return typed 'closed'.
		if (this.backoffResolver !== null) {
			const resolveBackoff = this.backoffResolver;
			this.backoffResolver = null;
			try {
				resolveBackoff();
			} catch {
				/* ignore — best-effort unblock */
			}
		}
		this.teardownSocket();
		// Reject every pending request. Using reject (not resolve) so the
		// request() catch block kicks in and returns {ok:false, fallback:true}.
		// Resolving with undefined would have made request() return
		// {ok:true, value:undefined}, which is misleading.
		for (const [, p] of this.pending) {
			p.reject(new BrokerError("close", "client closed"));
		}
		this.pending.clear();
		this._mode = "fallback";
	}

	// ------------------------------------------------------------------------
	// Connect + hello with bounded backoff
	// ------------------------------------------------------------------------

	private async connectAndHello(): Promise<BrokerClientResult<true>> {
		if (!this.options.socketPath || !this.options.token) {
			this.enterFallbackOnce("missing-credentials", new Error("socket or token not provided"));
			return { ok: false, fallback: true, errorCode: "missing-credentials" };
		}

		const netModule = this.options.netModule ?? net;
		const setTimeoutFn = this.options.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
		const clearTimeoutFn = this.options.clearTimeoutFn ?? ((t: NodeJS.Timeout) => clearTimeout(t));
		const jitter = this.options.jitter ?? (() => 0.75 + Math.random() * 0.5); // [0.75, 1.25]

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			// Closed gate at the top of each iteration: catches the case
			// where close() was called while we were awaiting attemptHello()
			// or while a previous backoff timer was firing. After close(),
			// the client must not open any new sockets.
			if (this.closed) {
				return { ok: false, fallback: true, errorCode: "closed" };
			}
			this.attempts = attempt + 1;
			const result = await this.attemptHello(netModule);
			if (result.ok) {
				// Belt-and-suspenders: a successful hello can still race
				// with close() (e.g. close() called between the hello ack
				// being processed and this return). If we are now closed,
				// tear down the socket we just opened and return the typed
				// error rather than handing back a connected client.
				if (this.closed) {
					this.teardownSocket();
					this._mode = "fallback";
					return { ok: false, fallback: true, errorCode: "closed" };
				}
				this._mode = "connected";
				return result;
			}
			// Failure. If we are out of attempts, give up.
			if (attempt + 1 >= MAX_ATTEMPTS) {
				this.enterFallbackOnce(result.errorCode ?? "connect-failed", result.error);
				return { ok: false, fallback: true, errorCode: result.errorCode ?? "connect-failed" };
			}
			// Wait the next backoff slot (with jitter), unless this was a
			// auth failure (no point retrying — server rejected hello).
			if (result.errorCode === "auth") {
				this.enterFallbackOnce("auth", result.error);
				return { ok: false, fallback: true, errorCode: "auth" };
			}
			const base = BACKOFF_SCHEDULE_MS[attempt] ?? 800;
			const delay = Math.max(1, Math.floor(base * jitter()));
			await new Promise<void>((resolve) => {
				// Capture the resolver so close() can unblock the await
				// even after cancelling the timer (timer cancellation alone
				// leaves resolve() unfired). We also clear the resolver
				// when the timer fires so a stale handle never leaks.
				this.backoffResolver = resolve;
				const t = setTimeoutFn(() => {
					if (this.backoffResolver === resolve) this.backoffResolver = null;
					this.backoffTimer = null;
					resolve();
				}, delay);
				this.backoffTimer = t;
				if (t && typeof (t as { unref?: () => void }).unref === "function") {
					(t as { unref?: () => void }).unref?.();
				}
			});
			// Unused but kept for symmetry with the future test seam.
			void clearTimeoutFn;
		}

		// Defensive: the loop always returns.
		this.enterFallbackOnce("exhausted", new Error("backoff exhausted"));
		return { ok: false, fallback: true, errorCode: "exhausted" };
	}

	private attemptHello(netModule: typeof net): Promise<BrokerClientResult<true>> {
		return new Promise<BrokerClientResult<true>>((resolve) => {
			// Belt-and-suspenders closed gate: the backoff loop in
			// connectAndHello already checks this.closed, but attemptHello
			// can also be entered via reconnect() after the flag is set.
			if (this.closed) {
				resolve({ ok: false, fallback: true, errorCode: "closed" });
				return;
			}
			const sock = netModule.createConnection(this.options.socketPath!);
			let settled = false;
			const finish = (v: BrokerClientResult<true>) => {
				if (settled) return;
				settled = true;
				// Cancel the per-attempt deadline timer so it cannot fire after
				// a successful handshake and destroy the healthy connection.
				try {
					clearTimeoutFn(timer);
				} catch {
					/* ignore */
				}
				try {
					sock.removeAllListeners();
				} catch {
					/* ignore */
				}
				resolve(v);
			};
			this.socket = sock;
			this.decoder = new NdjsonDecoder();

			// Per-attempt deadline.
			const setTimeoutFn = this.options.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
			const clearTimeoutFn = this.options.clearTimeoutFn ?? ((t: NodeJS.Timeout) => clearTimeout(t));
			const timer = setTimeoutFn(() => {
				finish({ ok: false, fallback: true, errorCode: "timeout" });
				try {
					sock.destroy();
				} catch {
					/* ignore */
				}
			}, CONNECT_HELLO_TIMEOUT_MS);
			if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
				(timer as { unref?: () => void }).unref?.();
			}

			const onConnect = () => {
				// Send hello immediately on connect.
				const hello = {
					id: `hello-${randomUUID()}`,
					method: "hello",
					params: {
						protocol: BROKER_PROTOCOL,
						runId: this.options.runId,
						taskId: this.options.taskId,
						token: this.options.token,
					},
				};
				try {
					sock.write(encodeBrokerFrame(hello));
				} catch (err) {
					finish({ ok: false, fallback: true, errorCode: "encode-failed" });
					try {
						sock.destroy();
					} catch {
						/* ignore */
					}
					return;
				}
			};
			const onData = (chunk: Buffer | string) => {
				if (!this.decoder) return;
				const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
				let frames: unknown[];
				try {
					frames = this.decoder.push(buf);
				} catch (err) {
					const code = err instanceof BrokerError ? err.code : "protocol";
					finish({ ok: false, fallback: true, errorCode: code });
					try {
						sock.destroy();
					} catch {
						/* ignore */
					}
					return;
				}
				for (const frame of frames) {
					if (!isResponseObject(frame)) {
						finish({ ok: false, fallback: true, errorCode: "protocol" });
						try {
							sock.destroy();
						} catch {
							/* ignore */
						}
						return;
					}
					// Hello ack: must include `result.ok === true` and matching id.
					if (frame.id && frame.id.startsWith("hello-")) {
						if (frame.error) {
							const code = (frame.error as { code?: string }).code ?? "auth";
							finish({ ok: false, fallback: true, errorCode: code });
							try {
								sock.destroy();
							} catch {
								/* ignore */
							}
							return;
						}
						// Hello succeeded — wire up the response handler.
						finish({ ok: true, value: true });
						this.wireSocketHandlers(sock);
						return;
					}
					// Otherwise it's a response to a request we sent.
					const pending = this.pending.get(frame.id);
					if (pending) {
						this.pending.delete(frame.id);
						if (frame.error) {
							const code = (frame.error as { code?: string }).code ?? "request-failed";
							pending.reject(new BrokerError(code as never, "request error"));
						} else {
							pending.resolve(frame.result);
						}
					}
				}
			};
			const onError = (err: Error & { code?: string }) => {
				// ECONNREFUSED, EMFILE, ENOSPC, EPERM, ENOENT, EPIPE, etc.
				const code = err.code ?? "connect-failed";
				finish({ ok: false, fallback: true, errorCode: code });
			};
			const onClose = () => {
				finish({ ok: false, fallback: true, errorCode: "close" });
			};
			sock.once("connect", onConnect);
			sock.on("data", onData);
			sock.once("error", onError);
			sock.once("close", onClose);
			// Keep timer for explicit cleanup.
			this.socketListeners.push(
				{ event: "connect", listener: onConnect as (...args: unknown[]) => void },
				{ event: "data", listener: onData as (...args: unknown[]) => void },
				{ event: "error", listener: onError as (...args: unknown[]) => void },
				{ event: "close", listener: onClose as (...args: unknown[]) => void },
			);
			void clearTimeoutFn;
		});
	}

	private wireSocketHandlers(sock: net.Socket): void {
		// After hello, attach persistent handlers. The once-handlers from
		// attemptHello are already removed in finish().
		// Unref the socket so a still-open broker connection never keeps a
		// finished child worker's event loop alive (mirrors the file-poll
		// steering timer's unref). Pushes still arrive while the worker runs.
		(sock as { unref?: () => void }).unref?.();
		const onData = (chunk: Buffer | string) => {
			if (!this.decoder) return;
			const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			let frames: unknown[];
			try {
				frames = this.decoder.push(buf);
			} catch (err) {
				// Malformed frame — fall back.
				this.enterFallbackOnce("protocol", err);
				try {
					sock.destroy();
				} catch {
					/* ignore */
				}
				return;
			}
			for (const frame of frames) {
				// Distinguish unsolicited event frames (e.g. mailbox.message
				// pushed by the broker's observer-driven live fanout) from
				// request-response frames. Events have `event` + `data` (+ optional
				// `seq`); responses have `id` + `result` or `error`. Event frames
				// are routed to the optional `onEvent` handler; a missing handler
				// silently drops them (the durable path remains authoritative).
				if (isEventFrame(frame)) {
					const handler = this.options.onEvent;
					if (handler) {
						const ev = frame as Record<string, unknown>;
						try {
							handler({ event: ev.event as string, data: ev.data, seq: typeof ev.seq === "number" ? ev.seq : undefined });
						} catch {
							/* an onEvent handler fault must never break the socket loop */
						}
					}
					continue;
				}
				if (!isResponseObject(frame)) {
					this.enterFallbackOnce("protocol", new Error("malformed response"));
					return;
				}
				const pending = this.pending.get(frame.id);
				if (!pending) continue;
				this.pending.delete(frame.id);
				if (frame.error) {
					// Per-request error response from the broker: NOT a protocol
					// error, NOT a fallback condition. The broker explicitly rejected
					// this call (e.g. bad-params, no-manifest, wait-timeout).
					// Resolve with a tagged envelope so request() can return
					// ok:false WITHOUT triggering fallback mode.
					const errCode = (frame.error as { code?: string }).code ?? "request-failed";
					pending.resolve({
						__brokerError: true,
						code: errCode,
						message: (frame.error as { message?: string }).message ?? "",
					} as never);
				} else {
					pending.resolve(frame.result);
				}
			}
		};
		const onError = (err: Error & { code?: string }) => {
			this.enterFallbackOnce(err.code ?? "socket-error", err);
		};
		const onClose = () => {
			// Reject every pending with a close error so request() returns
			// {ok:false, fallback:true}. (Resolving with undefined previously
			// returned {ok:true, value:undefined}, which is misleading.)
			for (const [, p] of this.pending) {
				p.reject(new BrokerError("close", "socket closed"));
			}
			this.pending.clear();
			this.enterFallbackOnce("close", new Error("socket closed"));
		};
		sock.on("data", onData);
		sock.once("error", onError);
		sock.once("close", onClose);
		this.socketListeners.push(
			{ event: "data", listener: onData as (...args: unknown[]) => void },
			{ event: "error", listener: onError as (...args: unknown[]) => void },
			{ event: "close", listener: onClose as (...args: unknown[]) => void },
		);
	}

	private teardownSocket(): void {
		if (!this.socket) {
			this.socket = null;
			this.decoder = null;
			this.socketListeners.length = 0;
			return;
		}
		const sock = this.socket;
		for (const l of this.socketListeners) {
			try {
				sock.removeListener(l.event, l.listener);
			} catch {
				/* ignore */
			}
		}
		this.socketListeners.length = 0;
		try {
			sock.destroy();
		} catch {
			/* ignore */
		}
		this.socket = null;
		this.decoder = null;
	}

	private enterFallbackOnce(code: string, cause?: unknown): void {
		if (this._mode === "fallback") return;
		this._mode = "fallback";
		// Log exactly ONE diagnostic per transition. We redact any cause string
		// so token-like bytes cannot leak via the error message.
		const safeCause = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
		const safe = safeCause ? redactSecretString(safeCause) : undefined;
		logInternalError(
			"crew-broker.client.fallback",
			new Error(`fallback (${code})`),
			`runId=${this.options.runId}${safe ? ` cause=${safe}` : ""}`,
		);
	}
}

// ============================================================================
// Type guards (no `any`)
// ============================================================================

function isResponseObject(value: unknown): value is { id: string; result?: unknown; error?: { code?: string; message?: string } } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > 256) return false;
	if ("error" in v) {
		const e = v.error;
		if (!e || typeof e !== "object" || Array.isArray(e)) return false;
		const errObj = e as Record<string, unknown>;
		if (typeof errObj.code !== "string") return false;
		if (typeof errObj.message !== "string") return false;
	}
	return true;
}

/**
 * Detect an unsolicited event frame (no `id`, has `event` + `data`).
 * Event frames are pushed by the broker's live-fanout (e.g. mailbox.message)
 * and must NOT be treated as request responses — otherwise the client's
 * strict response validator would fall back on every push.
 */
function isEventFrame(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.event !== "string" || v.event.length === 0) return false;
	return "data" in v;
}
