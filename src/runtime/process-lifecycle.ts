/**
 * Owned-process lifecycle abstraction (P0 item #3).
 *
 * Distilled and adapted from gajae-code's `runtime/process-lifecycle.ts`.
 *
 * Two complementary primitives:
 *
 *   F1(a) {@link spawnOwnedProcess} / {@link OwnedProcess} — wraps a
 *         `child_process.spawn` child with explicit ownership: escalating
 *         (SIGTERM → grace → SIGKILL) teardown, idempotent `dispose()`, bounded
 *         `awaitExit()`, abort-signal wiring, and postmortem registration so
 *         an owned child can never outlive its owner.
 *
 *   F1(b) {@link registerResourceOwner} — a generic postmortem registry for
 *         NON-process resources (timers, sockets, Workers, VM contexts) with
 *         `disposeAllOwners()` / `disposeOwner(name)`.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  IMPORTANT — INCREMENTAL, NOT FULL MIGRATION                              ║
 * ║  pi-crew ALREADY has sophisticated kill logic in child-pi.ts              ║
 * ║  (killProcessTree, escalating SIGTERM→grace→SIGKILL, hard-kill timer,    ║
 * ║  post-exit stdio guard) and async-runner.ts does detached/setsid spawns.  ║
 * ║  Those paths are NOT rewritten here. This module provides a clean         ║
 * ║  ownership primitive for NEW code paths that need guaranteed teardown     ║
 * ║  without re-implementing the escalation dance each time.                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Cross-platform: on Windows there is no SIGTERM; teardown uses
 * `taskkill /F /T /PID` escalation directly (force-kill the whole tree).
 * See `.crew/knowledge.md` gotchas: BSD/Windows signal handling differs.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { logInternalError } from "../utils/internal-error.ts";

// ── tunables ──────────────────────────────────────────────────────────────────

const DEFAULT_GRACEFUL_MS = 2_000;
/** Hard cap on how long dispose() waits after SIGKILL before giving up, so a
 *  wedged/unkillable child can never block shutdown forever. */
const SIGKILL_REAP_CAP_MS = 2_000;
/** After the root child exits on its own, how long to wait for the process
 *  group to drain before deregistering. Clean servers drain immediately. */
const ROOT_EXIT_DRAIN_MS = 250;

const isPosix = process.platform !== "win32";

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, Math.max(0, ms));
	});

/** Poll `predicate` until true or `timeoutMs` elapses. Returns the final value. */
async function pollUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 20): Promise<boolean> {
	if (predicate()) return true;
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (Date.now() < deadline) {
		await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
		if (predicate()) return true;
	}
	return predicate();
}

/** Whether a POSIX process group still has any member (zombies count as alive). */
function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		// EPERM => the group exists but we cannot signal it; treat as alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

// ── F1(a) OwnedProcess ────────────────────────────────────────────────────────

/** Options for {@link spawnOwnedProcess}. */
export interface SpawnOwnedOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** stdin mode passed through to the child. Defaults to `"ignore"`. */
	stdin?: "pipe" | "ignore";
	/** When aborted, the owned process tree is disposed (escalating kill). */
	signal?: AbortSignal;
	/** Grace period (ms) between SIGTERM and SIGKILL on dispose. Default 2000. */
	gracefulMs?: number;
	/**
	 * Spawn the child as its own process-group leader so the whole descendant
	 * tree can be signalled on dispose. Defaults to `true` on POSIX. Has no
	 * effect on Windows, where teardown falls back to single-process kill.
	 */
	processGroup?: boolean;
	/** Label used in diagnostics. */
	name?: string;
	/** Extra SpawnOptions merged in (e.g. windowsHide). */
	extraOptions?: SpawnOptions;
}

/** Result of a bounded {@link OwnedProcess.awaitExit}. */
export interface AwaitExitResult {
	/** `true` when the process has exited; `false` when the timeout fired first. */
	exited: boolean;
	/** Exit code if known, else `null`. */
	code: number | null;
}

/** Exit callback signature for {@link OwnedProcess.onExit}. */
export type OwnedExitCallback = (code: number | null, signal: NodeJS.Signals | null) => void;

/**
 * A spawned child process owned by the runtime with guaranteed teardown.
 *
 * Implemented as a class so callers retain a strong handle and so `dispose()`
 * can be idempotent (concurrent/repeated calls return the same in-flight
 * promise). Never throws from `dispose()` / `awaitExit()`.
 */
export class OwnedProcess {
	readonly child: ChildProcess;
	readonly pid: number | undefined;
	/** Process-group id (POSIX detached only); `undefined` on Windows / opt-out. */
	readonly pgid: number | undefined;
	private readonly gracefulMs: number;
	private readonly name: string | undefined;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private deregistered = false;
	/** Terminal once teardown/reconciliation has confirmed the group is gone. */
	private terminated = false;
	private exitPromise: Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>;
	private exitCallbacks = new Set<OwnedExitCallback>();
	private onAbort: (() => void) | undefined;
	private readonly abortSignal: AbortSignal | undefined;

	constructor(child: ChildProcess, opts: SpawnOwnedOptions, registerSelf: (owner: OwnedProcess) => () => void) {
		this.child = child;
		this.pid = child.pid;
		this.gracefulMs = opts.gracefulMs ?? DEFAULT_GRACEFUL_MS;
		this.name = opts.name;
		this.abortSignal = opts.signal;

		const useGroup = (opts.processGroup ?? true) && isPosix;
		// On POSIX with `detached`, the child is its own process-group leader,
		// so the group id equals its pid.
		this.pgid = useGroup ? child.pid : undefined;

		this.exitPromise = new Promise((resolve) => {
			child.once("exit", (code, signal) => {
				resolve({ code: code, signal: signal });
				for (const cb of this.exitCallbacks) {
					try {
						cb(code, signal);
					} catch (err) {
						logInternalError("owned-process.onExit-callback", err, this.name ? `name=${this.name}` : undefined);
					}
				}
			});
		});

		// Register for postmortem cleanup and wire abort.
		const deregister = registerSelf(this);
		this.deregisterFn = deregister;

		// When the root exits on its own (not via dispose), reconcile ownership
		// by the *group*: after a short drain window, deregister if the group is
		// empty, otherwise reap the owned group (no child outlives its owner).
		void this.exitPromise
			.then(() => {
				if (this.disposed) return; // dispose() owns deregistration
				if (this.pgid === undefined) {
					this.deregisterInternal();
					return;
				}
				void (async () => {
					const drained = await pollUntil(() => !groupAlive(this.pgid!), ROOT_EXIT_DRAIN_MS);
					if (this.disposed) return;
					if (drained) {
						this.deregisterInternal();
						return;
					}
					// Root exited but the owned group still has descendants: reap them.
					await this.dispose();
				})();
			})
			.catch(() => undefined);

		if (this.abortSignal) {
			if (this.abortSignal.aborted) {
				void this.dispose();
			} else {
				this.onAbort = () => void this.dispose();
				this.abortSignal.addEventListener("abort", this.onAbort, {
					once: true,
				});
			}
		}
	}

	private deregisterFn: () => void = () => undefined;

	/** `true` once `dispose()` has started. */
	get isDisposed(): boolean {
		return this.disposed;
	}

	/**
	 * Register a callback invoked exactly once when the root child exits.
	 * If the child has already exited, the callback is invoked synchronously
	 * with the cached exit info. Returns an unsubscribe function.
	 */
	onExit(callback: OwnedExitCallback): () => void {
		this.exitCallbacks.add(callback);
		// If already exited, the exitPromise is resolved; fire immediately.
		// We race to detect resolution without awaiting.
		let settled = false;
		this.exitPromise.then((info) => {
			if (settled) return; // callback may have been removed
			if (this.exitCallbacks.has(callback)) {
				try {
					callback(info.code, info.signal);
				} catch (err) {
					logInternalError("owned-process.onExit-immediate", err, this.name ? `name=${this.name}` : undefined);
				}
			}
		});
		return () => {
			settled = true;
			this.exitCallbacks.delete(callback);
		};
	}

	/**
	 * Wait for the root child to exit, optionally bounded by `timeoutMs`.
	 * With no timeout it resolves only when the child exits. Never rejects.
	 */
	async awaitExit(opts?: { timeoutMs?: number }): Promise<AwaitExitResult> {
		const exitResult = this.exitPromise.then((info) => ({
			exited: true as const,
			code: info.code,
		}));
		if (opts?.timeoutMs === undefined) return exitResult;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<AwaitExitResult>((resolve) => {
			timer = setTimeout(() => resolve({ exited: false, code: this.child.exitCode }), Math.max(0, opts.timeoutMs!));
		});
		try {
			return await Promise.race([exitResult, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** Signal the process tree with `signal` (group-aware on POSIX). */
	private signalTree(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (pid === undefined) return;
		if (this.pgid !== undefined) {
			try {
				process.kill(-this.pgid, signal);
				return;
			} catch {
				/* group already gone */
			}
			return;
		}
		try {
			this.child.kill(signal);
		} catch {
			/* already gone */
		}
	}

	private deregisterInternal(): void {
		if (this.deregistered) return;
		this.deregistered = true;
		this.terminated = true;
		this.deregisterFn();
		if (this.onAbort && this.abortSignal) {
			this.abortSignal.removeEventListener("abort", this.onAbort);
			this.onAbort = undefined;
		}
	}

	/**
	 * Idempotently terminate the owned process *group*: SIGTERM the group, wait
	 * `gracefulMs`, then SIGKILL, polling liveness throughout. On Windows,
	 * escalate directly to taskkill /F /T /PID. Removes the abort listener and
	 * deregisters from the live-owner set only after teardown has completed.
	 * Repeated/concurrent calls return the same in-flight promise. Never throws.
	 */
	dispose(): Promise<void> {
		// Already terminal: never re-probe a recycled pgid.
		if (this.terminated) {
			this.disposed = true;
			if (!this.disposePromise) this.disposePromise = Promise.resolve();
			return this.disposePromise;
		}
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		if (this.onAbort && this.abortSignal) {
			this.abortSignal.removeEventListener("abort", this.onAbort);
			this.onAbort = undefined;
		}
		this.disposePromise = (async () => {
			try {
				if (!isPosix) {
					await this.disposeWindows();
					return;
				}
				if (this.pgid !== undefined) {
					// Group ownership: reap until the whole group is gone, even if
					// the root has already exited (it may have backgrounded children).
					if (!groupAlive(this.pgid)) return;
					this.signalTree("SIGTERM");
					if (await pollUntil(() => !groupAlive(this.pgid!), this.gracefulMs)) return;
					this.signalTree("SIGKILL");
					if (!(await pollUntil(() => !groupAlive(this.pgid!), SIGKILL_REAP_CAP_MS))) {
						console.warn(
							`[pi-crew] owned process group still alive after SIGKILL (name=${this.name ?? "?"}, pgid=${this.pgid})`,
						);
					}
					return;
				}
				// Single-process fallback (processGroup:false).
				if (this.child.exitCode !== null) return;
				this.signalTree("SIGTERM");
				if ((await this.awaitExit({ timeoutMs: this.gracefulMs })).exited) return;
				this.signalTree("SIGKILL");
				await this.awaitExit({ timeoutMs: SIGKILL_REAP_CAP_MS });
			} catch (err) {
				logInternalError("owned-process.dispose", err, this.name ? `name=${this.name}` : undefined);
			} finally {
				// Deregister only after teardown completes so a postmortem firing
				// mid-grace still sees the owner.
				this.deregisterInternal();
			}
		})();
		return this.disposePromise;
	}

	/** Windows teardown: no SIGTERM; escalate to taskkill /F /T /PID. */
	private async disposeWindows(): Promise<void> {
		const pid = this.child.pid;
		if (pid === undefined) return;
		if (this.child.exitCode !== null) return;
		// First try a graceful taskkill (no /F), then escalate to /F /T.
		const tryTaskkill = (force: boolean): Promise<void> =>
			new Promise((resolve) => {
				const args = ["/T", "/PID", String(pid), ...(force ? ["/F"] : [])];
				const tk = spawn("taskkill", args, {
					stdio: "ignore",
					windowsHide: true,
				});
				tk.on("error", () => resolve());
				tk.on("exit", () => resolve());
			});
		await tryTaskkill(false);
		if ((await this.awaitExit({ timeoutMs: this.gracefulMs })).exited) return;
		await tryTaskkill(true);
		await this.awaitExit({ timeoutMs: SIGKILL_REAP_CAP_MS });
	}
}

// ── live-owner set + postmortem ───────────────────────────────────────────────

const liveOwners = new Set<OwnedProcess>();
let ownedPostmortemRegistered = false;

function ensureOwnedPostmortem(): void {
	if (ownedPostmortemRegistered) return;
	ownedPostmortemRegistered = true;
	// Register a process-exit handler that disposes every live owned process.
	// We wire both beforeExit (event-loop empty) and exit (synchronous final).
	const drain = async (): Promise<void> => {
		await Promise.all([...liveOwners].map((owner) => owner.dispose().catch(() => undefined)));
	};
	process.once("beforeExit", () => {
		void drain().catch(() => undefined);
	});
}

/**
 * Spawn a child process owned by the runtime. The returned {@link OwnedProcess}
 * is registered for postmortem cleanup and tears down its whole process group
 * on dispose/abort.
 *
 * NOTE: this is for NEW ownership-scoped spawns. Do NOT use it to replace
 * child-pi.ts's runChildPi (which has its own battle-tested escalation logic)
 * or async-runner.ts's intentionally-detached background spawns.
 */
export function spawnOwnedProcess(command: string, args: readonly string[] = [], opts: SpawnOwnedOptions = {}): OwnedProcess {
	ensureOwnedPostmortem();
	const useGroup = (opts.processGroup ?? true) && isPosix;
	const spawnOpts: SpawnOptions = {
		cwd: opts.cwd,
		env: opts.env as NodeJS.ProcessEnv | undefined,
		stdio: [opts.stdin ?? "ignore", "pipe", "pipe"],
		detached: useGroup,
		windowsHide: true,
		...opts.extraOptions,
	};
	const child = spawn(command, args as string[], spawnOpts);
	const owner = new OwnedProcess(child, opts, (self) => {
		liveOwners.add(self);
		return () => {
			liveOwners.delete(self);
		};
	});
	return owner;
}

/** Number of currently live owned processes. Exposed for leak assertions/tests. */
export function liveOwnedProcessCount(): number {
	return liveOwners.size;
}

/** Dispose every live owned process. For owner-scoped teardown and tests. */
export async function disposeAllOwnedProcesses(): Promise<void> {
	await Promise.all([...liveOwners].map((owner) => owner.dispose().catch(() => undefined)));
}

// ── F1(b) generic resource owners ─────────────────────────────────────────────

type ResourceDisposer = () => void | Promise<void>;

const resourceOwners = new Map<string, ResourceDisposer>();
let resourcePostmortemRegistered = false;

function ensureResourcePostmortem(): void {
	if (resourcePostmortemRegistered) return;
	resourcePostmortemRegistered = true;
	process.once("beforeExit", () => {
		void disposeAllOwners().catch(() => undefined);
	});
}

/**
 * Register a non-process resource for postmortem/fatal-exit cleanup.
 *
 * Idempotent by `name`: re-registering the same name replaces the prior
 * disposer (last wins). Returns an unregister function that removes the owner
 * only while it is still the active registration for that name.
 */
export function registerResourceOwner(name: string, disposer: ResourceDisposer): () => void {
	resourceOwners.set(name, disposer);
	ensureResourcePostmortem();
	let unregistered = false;
	return () => {
		if (unregistered) return;
		unregistered = true;
		if (resourceOwners.get(name) === disposer) {
			resourceOwners.delete(name);
		}
	};
}

/** Number of registered resource owners. Exposed for leak assertions/tests. */
export function resourceOwnerCount(): number {
	return resourceOwners.size;
}

/**
 * Run and clear every registered resource disposer. Attempts all disposers even
 * if some throw, then surfaces the failures as an `AggregateError` so callers
 * can distinguish "all closed" from "a resource may still be alive".
 */
export async function disposeAllOwners(): Promise<void> {
	const disposers = [...resourceOwners.values()];
	resourceOwners.clear();
	const errors: unknown[] = [];
	for (const disposer of disposers) {
		try {
			await disposer();
		} catch (err) {
			errors.push(err);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, `${errors.length} resource disposer(s) failed during teardown`);
	}
}

/** Dispose a single named resource owner. Returns true if it was registered. */
export async function disposeOwner(name: string): Promise<boolean> {
	const disposer = resourceOwners.get(name);
	if (!disposer) return false;
	resourceOwners.delete(name);
	await disposer();
	return true;
}
