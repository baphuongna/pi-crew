/**
 * EngineManager — the host half of the evaluator (Node port, spike).
 *
 * Owns one persistent Node guest process, speaks the line-JSON protocol over a
 * private pipe (fd 3), and exposes the execute / snapshot / restore API the
 * spike needs to prove patterns 01 (namespace), 04 (transform), 05
 * (incremental bindings), 08 (snapshot) and 09 (revive) on Node.
 *
 * SPIKE API DEVIATION from pi-rlm's engine:
 *   - the guest is spawned as `node --experimental-strip-types guest.ts`
 *     (NEVER `bun run`) — Node is the only runtime;
 *   - snapshotState(path) / restoreState(path) take an EXPLICIT file path and
 *     are called explicitly — NO debounce/scheduleSnapshot, NO
 *     options.snapshot config, NO hostHandlers (no host bridge in the spike);
 *   - EngineBusyError + maybeWedged liveness machinery dropped (minimalism);
 *   - everything else — sync queue-slot claim, output attribution, abort
 *     grace, truncateWithMarker, the childClosed race guard — is ported 1:1.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** D6 read-side cap (Checkpoint B, MINOR-2): restoreState refuses a file larger
 *  than this — an independent guard from the lifecycle cap (same value, no
 *  import to keep engine free of a lifecycle cycle). Bounds v8.deserialize
 *  amplification from a swapped snapshot file. */
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

import { decodeMessage, encodeMessage, type GuestToHostMessage, type HostToGuestMessage, NONCE_ENV, PROTOCOL_FD } from "./protocol.ts";

const GUEST_PATH = fileURLToPath(new URL("./guest.ts", import.meta.url));
const DEFAULT_MAX_OUTPUT_CHARS = 65536;
const READY_TIMEOUT_MS = 10_000;
const ABORT_GRACE_MS = 500;
const PING_TIMEOUT_MS = 5_000;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30_000;

export interface EngineExecuteError {
	/** Error class name, e.g. "TypeError". */
	name: string;
	message: string;
	/** Stack trace, split into lines. */
	stack: string[];
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	/** Rendered value of the cell's final expression, when it has one. */
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: EngineExecuteError;
	durationMs: number;
}

export interface ExecuteOptions {
	/** Aborting cancels the cell cooperatively; namespace is preserved. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** Cap stdout / stderr / result at this many characters. Default 65536. */
	maxOutputChars?: number;
}

/** Lifecycle state of an EngineManager. "shutdown" is terminal. */
export type EngineState = "idle" | "starting" | "running" | "shutdown";

export interface SnapshotResult {
	path: string;
	/** Top-level names successfully serialized. */
	saved: string[];
	/** Names that could not be serialized, with reasons. */
	failed: { name: string; reason: string }[];
}

export interface RestoreResult {
	path: string;
	restored: string[];
	failed: { name: string; reason: string }[];
}

export interface EngineOptions {
	cwd?: string;
	env?: Record<string, string>;
}

interface ActiveExecution {
	cellId: string;
	started: number;
	maxChars: number;
	opts: ExecuteOptions;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	result?: string;
	error?: EngineExecuteError;
	status: ExecuteResult["status"];
	settled: boolean;
	/** Set on cancellation: a cancelled cell must stop contributing output at once. */
	abortRequested: boolean;
	resolve(result: ExecuteResult): void;
	reject(error: Error): void;
}

// ── process-wide cleanup ─────────────────────────────────────────────────────
// Guests are killed when the host exits normally. As a backstop the guest also
// self-exits when its stdin reaches EOF, which covers a host death abrupt
// enough that no handler runs.

const liveEngines = new Set<EngineManager>();
let cleanupHandlersInstalled = false;

function installProcessCleanupOnce(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", () => {
		for (const engine of liveEngines) engine.killSync();
	});
}

interface PendingRequest {
	resolve(message: GuestToHostMessage): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

function truncateWithMarker(text: string, maxChars: number, wasTruncated: boolean): string {
	if (!wasTruncated && text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... output truncated at ${maxChars} chars ...]`;
}

export class EngineManager {
	private readonly options: EngineOptions;
	private child?: ChildProcess;
	private engineState: EngineState = "idle";
	private startPromise?: Promise<void>;
	private executionQueue: Promise<unknown> = Promise.resolve();
	private activeExecution?: ActiveExecution;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	/** Per-process protocol nonce; also names the guest's internal bindings. */
	private readonly nonce = randomUUID().replaceAll("-", "");
	/** Tail of the guest's own stderr, surfaced when it dies unexpectedly. */
	private guestStderr = "";
	/** Resolves when the child and all of its stdio have fully closed. */
	private childClosed?: Promise<void>;
	/** Held so the protocol reader is not garbage-collected mid-session, which
	 * would close the guest's write end and kill it with EPIPE. */
	private protocolReader?: ReturnType<typeof createInterface>;

	constructor(options: EngineOptions = {}) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.engineState === "running";
	}

	/**
	 * Public read of the lifecycle state (F12): lets callers distinguish a
	 * TERMINAL shutdown engine (start() will throw "Engine has been shut down")
	 * from a wedged-but-alive one. The private field is `engineState` so this
	 * accessor can share the `state` name.
	 */
	get state(): EngineState {
		return this.engineState;
	}

	// ── lifecycle ──────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.engineState === "shutdown") throw new Error("Engine has been shut down");
		if (!this.startPromise) {
			const startup = this.doStart().catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
			// Callers await the rejection; this guard keeps a startup failure that
			// nobody is waiting on from surfacing as an unhandled rejection.
			// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional fire-and-forget guard.
			startup.catch(() => {});
			this.startPromise = startup;
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.engineState = "starting";
		installProcessCleanupOnce();
		liveEngines.add(this);
		const child = spawn(process.execPath, ["--experimental-strip-types", GUEST_PATH], {
			cwd: this.options.cwd,
			env: {
				...process.env,
				...(this.options.env ?? {}),
				[NONCE_ENV]: this.nonce,
			},
			// Run the guest as its own session leader so descendants
			// (cell-spawned subprocesses) share its process group. teardown
			// then uses `process.kill(-pid, ...)` (POSIX) or `taskkill /T`
			// (Windows) to clean up the whole tree — closing the
			// "cell-subprocess orphan on session_shutdown" gap declared in
			// docs/failure-mode-inventory.md (D.4 narrowed).
			// stdio pipes are still owned by the parent; `detached` only
			// affects process-group / kill-on-parent-exit semantics.
			detached: true,
			// fd 3 carries protocol traffic so stdout/stderr stay pure user output.
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.childClosed = new Promise((resolve) => child.once("close", () => resolve()));

		const ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Engine guest did not become ready in time")), READY_TIMEOUT_MS);
			timer.unref?.();
			this.pendingRequests.set("__ready__", {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});

		const protocolStream = child.stdio[PROTOCOL_FD] as NodeJS.ReadableStream | null;
		if (!protocolStream) {
			throw new Error("Engine guest was spawned without a protocol pipe on fd 3");
		}
		this.protocolReader = createInterface({ input: protocolStream });
		this.protocolReader.on("line", (line) => this.handleGuestLine(line));
		// Anything the guest writes to the real stdout/stderr fds is subprocess
		// output; attribute it to the running cell.
		child.stdout!.on("data", (buffer: Buffer) => this.appendActiveOutput("stdout", buffer.toString()));
		child.stderr!.on("data", (buffer: Buffer) => {
			const text = buffer.toString();
			this.guestStderr = (this.guestStderr + text).slice(-4000);
			this.appendActiveOutput("stderr", text);
		});

		child.on("error", (error) => {
			const message = `Engine process failed: ${error.message}`;
			this.failAllPending(new Error(message));
			this.transitionToShutdown(message);
		});
		child.on("exit", (code, signal) => {
			// A killed child's exit event arrives after teardown has already moved
			// on. Acting on it would reject an execution nobody is waiting for any
			// more, surfacing as an unhandled rejection in an unrelated context.
			if (this.child !== child) return;
			if (this.engineState !== "shutdown") {
				const tail = this.guestStderr.trim();
				const reason =
					`Engine process exited unexpectedly (code=${code} signal=${signal})` +
					(tail ? `\nguest stderr:\n${tail.slice(-1500)}` : "");
				this.failAllPending(new Error(reason));
				this.transitionToShutdown(reason);
			}
		});

		await ready;
		// Being torn down while starting wins: without this the late assignment
		// resurrects a killed engine as "running", and the child's own exit event
		// then reads that as an unexpected death.
		if ((this.engineState as string) === "shutdown") throw new Error("Engine has been shut down");
		this.engineState = "running";
	}

	private transitionToShutdown(reason: string): void {
		this.engineState = "shutdown";
		const active = this.activeExecution;
		if (active && !active.settled) {
			this.activeExecution = undefined;
			active.settled = true;
			active.reject(new Error(reason));
		}
	}

	private failAllPending(error: Error): void {
		for (const [, pending] of this.pendingRequests) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	async kill(): Promise<void> {
		const closed = this.childClosed;
		this.killSync();
		// Teardown is not done until the child's stdio is actually closed. A
		// SIGKILL'd child's pipes are torn down asynchronously, and a spawn that
		// follows too quickly recycles those descriptors while the teardown is
		// still in flight — which can close a pipe belonging to the new engine.
		// Observed as a fresh guest hitting EPIPE on its first protocol write.
		if (closed) {
			await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())]);
		}
	}

	/** Synchronous teardown, safe from process.on("exit"). */
	killSync(): void {
		const active = this.activeExecution;
		if (active && !active.settled) {
			active.status = "aborted";
			this.settleActiveExecution(active);
		}
		this.engineState = "shutdown";
		liveEngines.delete(this);
		this.failAllPending(new Error("Engine has been shut down"));
		// Kill the whole process group / job tree so cell-spawned
		// subprocesses (grandchildren of the host) do not orphan when the
		// session shuts down. Best-effort: fall back to a single-pid kill
		// if the group/tree kill fails (already dead, EPERM, etc.).
		const child = this.child;
		const pid = child?.pid;
		if (pid !== undefined && pid > 0) {
			try {
				if (process.platform === "win32") {
					// taskkill /T /F kills the entire process tree rooted at pid.
					spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
				} else {
					// Negative pid = signal the entire process group.
					// Requires the guest to be its own session leader (detached:true above).
					process.kill(-pid, "SIGKILL");
				}
			} catch {
				try {
					child?.kill("SIGKILL");
				} catch {
					/* already gone — nothing to clean up */
				}
			}
		} else if (child) {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
		this.child = undefined;
		this.protocolReader?.close();
		this.protocolReader = undefined;
	}

	/**
	 * Graceful cleanup: optionally flush a final snapshot (explicit path, since
	 * the spike has no auto-snapshot config), then terminate the guest.
	 */
	async dispose(snapshotPath?: string): Promise<void> {
		if (snapshotPath && this.engineState === "running") {
			await this.snapshotState(snapshotPath).catch(() => null);
		}
		await this.kill();
	}

	// ── guest messaging ────────────────────────────────────────────────────────

	private sendToGuest(message: HostToGuestMessage): void {
		// A write into a dying child's stdin can throw synchronously. A dead pipe
		// here only ever means "engine gone", which every caller already learns
		// through the exit path — a late write must not become an unhandled
		// rejection.
		try {
			this.child?.stdin?.write(encodeMessage(message, this.nonce));
			// biome-ignore lint/suspicious/noEmptyBlockStatements: a dead pipe only means engine gone; every caller learns via the exit path.
		} catch {}
	}

	private request(message: HostToGuestMessage & { id: string }, timeoutMs: number): Promise<GuestToHostMessage> {
		const pending = new Promise<GuestToHostMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(message.id);
				reject(new Error(`Engine request ${message.type} timed out`));
			}, timeoutMs);
			timer.unref?.();
			this.pendingRequests.set(message.id, { resolve, reject, timer });
			this.sendToGuest(message);
		});
		// Teardown rejects every outstanding request. A caller that has already
		// moved on is no longer listening, and that rejection would otherwise
		// escape as an unhandled rejection in whatever happens to be running.
		// Marking it handled here does not hide anything from the real caller,
		// which still receives the rejection through the returned promise.
		// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op — the returned promise still carries the rejection.
		pending.catch(() => {});
		return pending;
	}

	private handleGuestLine(line: string): void {
		// fd 3 carries only protocol traffic; a line that fails to decode (wrong
		// nonce, malformed) is discarded rather than shown as output.
		const message = decodeMessage<GuestToHostMessage>(line, this.nonce);
		if (!message) return;
		switch (message.type) {
			case "ready": {
				const pending = this.pendingRequests.get("__ready__");
				if (pending) {
					this.pendingRequests.delete("__ready__");
					pending.resolve(message);
				}
				break;
			}
			case "stream": {
				const active = this.activeExecution;
				// Untagged output belongs to no cell; attributing it to whichever cell
				// is active is the same class of bug as the orphan leak.
				if (!active || active.settled || message.cellId !== active.cellId) return;
				this.appendOutput(active, message.name, message.chunk);
				break;
			}
			case "done": {
				const active = this.activeExecution;
				if (!active || active.settled || active.cellId !== message.cellId) return;
				if (message.status === "error") {
					active.status = "error";
					active.error = message.error;
				} else if (message.status === "aborted") {
					active.status = "aborted";
				} else {
					active.result = message.result;
				}
				this.settleActiveExecution(active);
				break;
			}
			case "pong": {
				this.resolveRequest(message.id, message);
				break;
			}
			case "snapshot_result":
			case "restore_result":
			case "names_result": {
				this.resolveRequest(message.id, message);
				break;
			}
		}
	}

	private resolveRequest(id: string, message: GuestToHostMessage): void {
		const pending = this.pendingRequests.get(id);
		if (!pending) return;
		this.pendingRequests.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(message);
	}

	// ── output accumulation ────────────────────────────────────────────────────

	private appendActiveOutput(name: "stdout" | "stderr", text: string): void {
		const active = this.activeExecution;
		if (!active || active.settled) return;
		this.appendOutput(active, name, text);
	}

	private appendOutput(active: ActiveExecution, name: "stdout" | "stderr", text: string): void {
		if (active.abortRequested) return;
		const key = name === "stdout" ? "stdout" : "stderr";
		const truncatedKey = name === "stdout" ? "stdoutTruncated" : "stderrTruncated";
		if (active[key].length < active.maxChars) {
			active[key] += text;
			if (active[key].length > active.maxChars) {
				active[key] = active[key].slice(0, active.maxChars);
				active[truncatedKey] = true;
			}
		} else {
			active[truncatedKey] = true;
		}
		active.opts.onStream?.(text, name);
	}

	// ── execute ────────────────────────────────────────────────────────────────

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		// Claim the queue slot synchronously, before the first await, so that
		// submission order is execution order for concurrent callers.
		const previous = this.executionQueue;
		// biome-ignore lint/suspicious/noEmptyBlockStatements: release is assigned synchronously below before any await.
		let release: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		try {
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
			}
			if (this.engineState === "shutdown") {
				throw new Error("Engine has been shut down");
			}
			await this.start();
			if ((this.engineState as string) === "shutdown") {
				throw new Error("Engine has been shut down");
			}
			return await this.executeInner(code, opts);
		} finally {
			release();
		}
	}

	private executeInner(code: string, opts: ExecuteOptions): Promise<ExecuteResult> {
		const cellId = randomUUID();
		const started = Date.now();

		return new Promise<ExecuteResult>((resolve, reject) => {
			const active: ActiveExecution = {
				cellId,
				started,
				maxChars: opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
				opts,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				status: "ok",
				settled: false,
				abortRequested: false,
				resolve,
				reject,
			};
			this.activeExecution = active;

			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				active.abortRequested = true;
				this.sendToGuest({ type: "abort", cellId });
				graceTimer = setTimeout(() => {
					if (this.activeExecution === active && !active.settled) {
						active.status = "aborted";
						this.settleActiveExecution(active);
					}
				}, ABORT_GRACE_MS);
				graceTimer.unref?.();
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			const originalResolve = active.resolve;
			active.resolve = (result) => {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
				originalResolve(result);
			};
			const originalReject = active.reject;
			active.reject = (error) => {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
				originalReject(error);
			};

			this.sendToGuest({ type: "run", cellId, code });
		});
	}

	private settleActiveExecution(active: ActiveExecution): void {
		if (active.settled) return;
		active.settled = true;
		if (this.activeExecution === active) this.activeExecution = undefined;

		// A cancelled cell reports "aborted" even if it happened to finish first:
		// the caller withdrew interest, so the value is not theirs to consume.
		let status = active.status;
		if (active.opts.signal?.aborted) status = "aborted";

		const stdout = truncateWithMarker(active.stdout, active.maxChars, active.stdoutTruncated);
		const stderr = truncateWithMarker(active.stderr, active.maxChars, active.stderrTruncated);
		let result = active.result;
		if (result !== undefined && result.length > active.maxChars) {
			result = truncateWithMarker(result, active.maxChars, true);
		}

		active.resolve({
			stdout,
			stderr,
			result,
			error: active.error,
			status,
			durationMs: Date.now() - active.started,
		});
	}

	// ── snapshot / restore / names ─────────────────────────────────────────────
	// SPIKE: explicit file paths; no debounce, no options.snapshot config.

	async snapshotState(path: string): Promise<SnapshotResult | null> {
		if (this.engineState !== "running") return null;
		try {
			const reply = await this.request({ type: "snapshot", id: randomUUID() }, SNAPSHOT_REQUEST_TIMEOUT_MS);
			if (reply.type !== "snapshot_result") return null;
			mkdirSync(dirname(path), { recursive: true });
			// Phase 3 (D2'): atomic write — temp + rename same-dir eliminates the
			// torn-write race (debounce timer vs F3 quit, or any future 2nd writer).
			// Same directory ⇒ same filesystem ⇒ rename is atomic.
			const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
			writeFileSync(tmp, JSON.stringify({ version: 1, vars: reply.vars, failed: reply.failed }));
			renameSync(tmp, path);
			return { path, saved: Object.keys(reply.vars), failed: reply.failed };
		} catch {
			return null;
		}
	}

	async restoreState(path: string): Promise<RestoreResult | null> {
		// MINOR-2 (Checkpoint B review) + holistic MINOR-1 (fd leak): open ONCE with
		// O_NOFOLLOW, fstat for regular-file + size cap, read via that fd — ALL
		// under a single try/finally so the fd is closed on EVERY path (the early
		// `return null` checks and an `await this.start()` throw included). Closes
		// the TOCTOU between the caller's lstat and this read, and the cap is
		// enforced HERE so a caller cannot bypass it.
		let fd: number | undefined;
		try {
			try {
				fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			} catch {
				return null; // missing / symlinked final component — fail-open
			}
			const st = fstatSync(fd);
			if (!st.isFile() || st.isSymbolicLink()) return null;
			if (st.size > SNAPSHOT_MAX_BYTES) return null;
			// file validated → lazily start the engine, then read+restore via fd.
			await this.start();
			const payload = JSON.parse(readFileSync(fd, { encoding: "utf8" })) as {
				vars?: Record<string, string>;
			};
			const vars = payload.vars ?? {};
			const reply = await this.request({ type: "restore", id: randomUUID(), vars }, SNAPSHOT_REQUEST_TIMEOUT_MS);
			if (reply.type !== "restore_result") return null;
			return { path, restored: reply.restored, failed: reply.failed };
		} catch {
			return null;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	async listNamespaceNames(): Promise<string[] | null> {
		if (this.engineState !== "running") return null;
		try {
			const reply = await this.request({ type: "list_names", id: randomUUID() }, PING_TIMEOUT_MS);
			return reply.type === "names_result" ? reply.names : null;
		} catch {
			return null;
		}
	}
}
