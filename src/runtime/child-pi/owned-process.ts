/**
 * owned-process.ts — U15: OwnedProcess pattern, Node 22 port.
 *
 * Ported from gajae-code `packages/coding-agent/src/runtime/process-lifecycle.ts`
 * (fork pi-mono v0.8.2) per spec U15 of pi-crew-upgrade-spec-2026-10-09.md:
 * the Bun `ptree.spawn` core is re-expressed with `node:child_process.spawn`
 * `{detached:true}` — pi-crew's child-pi spawns already use detached+setsid
 * (child-pi-spawn.ts), they were only missing the group-kill discipline:
 *
 *   - Process-group ownership: a detached child is its own group leader, so
 *     `process.kill(-pgid, sig)` signals the WHOLE descendant tree — including
 *     `sh -c "worker &"` backgrounded descendants, pi-crew's real zombie
 *     vector (proof-of-pattern round 9: root SIGKILL left 2 children
 *     reparented to ppid=1 while the group stayed signalable).
 *   - Escalating dispose with hard cap: SIGTERM group → poll gracefulMs (2s)
 *     → SIGKILL → poll cap (2s) → warn + give up. A wedged child can never
 *     block shutdown forever.
 *   - Root-exit drain-reconcile (250ms): when the root exits on its own but
 *     the group still has live members, the owner reaps the group — no child
 *     outlives its owner.
 *   - PID-recycle guard: once terminal, dispose() is a settled no-op and
 *     never re-probes a pgid the OS may have recycled into an unrelated group.
 *   - Idempotent/concurrent dispose share ONE in-flight promise; bounded
 *     `awaitExit` never rejects.
 *   - Postmortem registry (postmortem-registry.ts) reaps every still-live
 *     owned group on exit/SIGINT/SIGTERM/SIGHUP/uncaught/unhandled; owners
 *     deregister only AFTER teardown completed.
 *
 * GOTCHA (round 9, MUST keep): do NOT `unref()` the root child handle. The
 * root-exit drain-reconcile needs the 'exit' event delivered; unref'ing the
 * handle starves exit-event delivery when the rest of the loop is idle and
 * the reconcile silently never runs. Internal poll/delay timers unref
 * THEMSELVES (they must not pin the loop), but the child handle stays ref'd.
 *
 * Known limit (spec, grep-verified in the fork): no parent-death detection —
 * if THIS owner process is SIGKILLed, no postmortem runs. That case is owned
 * by the complementary child-side PI_CREW_PARENT_PID guard (zombie-scanner +
 * background-runner parent-guard), which stays in place untouched.
 *
 * rpc-socket-security.ts is explicitly NOT ported (spec: defer until an UDS
 * transport exists — see U14/U15 lane notes).
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { logInternalError } from "../../utils/internal-error.ts";
import { registerPostmortemCleanup } from "./postmortem-registry.ts";

const DEFAULT_GRACEFUL_MS = 2_000;
// Hard cap for how long dispose() waits after SIGKILL before giving up so a
// wedged, unkillable child can never block shutdown forever.
const SIGKILL_REAP_CAP_MS = 2_000;
// After the root process exits on its own, how long to wait for the process
// group to drain before deregistering. Clean children drain immediately; a
// root that backgrounded descendants keeps the owner registered past this
// window and the group is then reaped by dispose().
const ROOT_EXIT_DRAIN_MS = 250;
const POLL_INTERVAL_MS = 20;

const isPosix = process.platform !== "win32";

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, Math.max(0, ms));
		timer.unref?.();
	});

/** Poll `predicate` until true or `timeoutMs` elapses. Returns the final value. */
async function pollUntil(predicate: () => boolean, timeoutMs: number, intervalMs = POLL_INTERVAL_MS): Promise<boolean> {
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

/**
 * Read the process-group id of `pid` from /proc (Linux). Returns undefined
 * when /proc is unavailable (non-Linux) or the stat line is unparseable.
 * Authoritative group-leadership check on Linux.
 */
function readPgidFromProc(pid: number): number | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// Layout: pid (comm) state ppid pgrp session ... — comm may contain
		// spaces and parens, so fields are counted AFTER the last ')'.
		const close = stat.lastIndexOf(")");
		if (close === -1) return undefined;
		const fields = stat
			.slice(close + 2)
			.trim()
			.split(/\s+/);
		const pgrp = Number(fields[2]);
		return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : undefined;
	} catch {
		return undefined;
	}
}

/** Options shared by {@link spawnOwnedProcess} and {@link adoptOwnedProcess}. */
export interface OwnedProcessOptions {
	/** Grace period (ms) between SIGTERM and SIGKILL on dispose. Default 2000. */
	gracefulMs?: number;
	/** Label used in diagnostics. */
	name?: string;
	/**
	 * When aborted, the owned process tree is disposed (escalating kill).
	 * The listener is removed on settle so long-lived signals never leak.
	 */
	signal?: AbortSignal;
}

export interface SpawnOwnedOptions extends OwnedProcessOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/**
	 * Spawn the child as its own process-group leader so the whole descendant
	 * tree can be signalled on dispose. Defaults to `true` on POSIX. Has no
	 * effect on Windows, where teardown falls back to single-process kill.
	 */
	processGroup?: boolean;
}

/** Result of a bounded {@link OwnedProcess.awaitExit}. */
export interface AwaitExitResult {
	/** `true` when the process has exited; `false` when the timeout fired first. */
	exited: boolean;
	/** Exit code if known, else `null`. */
	code: number | null;
}

/** A child process owned by the runtime with guaranteed group teardown. */
export interface OwnedProcess {
	readonly child: ChildProcess;
	readonly pid: number | undefined;
	/** Process-group id when the child leads its own group, else undefined. */
	readonly pgid: number | undefined;
	/** Resolves with the exit code when the root child exits. Never rejects. */
	readonly exited: Promise<number | null>;
	/** `true` once dispose() has started. */
	readonly disposed: boolean;
	/**
	 * `true` once teardown/reconciliation confirmed the tree is gone. A late
	 * dispose() is then a settled no-op (PID-recycle guard).
	 */
	readonly terminated: boolean;
	/**
	 * Wait for the root child to exit, optionally bounded by `timeoutMs`.
	 * Never rejects.
	 */
	awaitExit(opts?: { timeoutMs?: number }): Promise<AwaitExitResult>;
	/**
	 * Idempotently terminate the owned process *group*: SIGTERM the group,
	 * wait `gracefulMs`, then SIGKILL, polling group liveness throughout.
	 * Removes the abort listener and deregisters from the live-owner set only
	 * after teardown has completed. Repeated/concurrent calls return the same
	 * in-flight promise.
	 */
	dispose(): Promise<void>;
}

const liveOwners = new Set<OwnedProcess>();
let ownedPostmortemRegistered = false;

function ensureOwnedPostmortem(): void {
	if (ownedPostmortemRegistered) return;
	ownedPostmortemRegistered = true;
	registerPostmortemCleanup("child-pi:owned-processes", () => disposeAllOwnedProcesses());
}

/** Create the OwnedProcess wrapper around a spawned (or adoptable) child. */
function createOwnedProcess(child: ChildProcess, pgid: number | undefined, opts: OwnedProcessOptions): OwnedProcess {
	const gracefulMs = opts.gracefulMs ?? DEFAULT_GRACEFUL_MS;

	ensureOwnedPostmortem();

	// exited: resolves exactly once with the exit code (null on spawn error or
	// signal death without a code). Never rejects — reconcile relies on that.
	let exitSettled = false;
	let resolveExit!: (code: number | null) => void;
	const exited = new Promise<number | null>((resolve) => {
		resolveExit = resolve;
	});
	const settleExit = (code: number | null): void => {
		if (exitSettled) return;
		exitSettled = true;
		resolveExit(code);
	};
	if (child.exitCode !== null || child.signalCode !== null) {
		// Already exited before adoption/creation (signal death leaves exitCode
		// null with signalCode set) — settle immediately, the events are gone.
		settleExit(child.exitCode);
	} else {
		child.once("exit", (code) => settleExit(code));
		// Spawn failures ('error', pid undefined) must not leave a hanging
		// promise — resolve null so drain-reconcile can deregister.
		child.once("error", () => settleExit(null));
	}

	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	let deregistered = false;
	// Terminal once teardown/reconciliation has confirmed the group is gone. A
	// late dispose() must then be a true no-op and never re-probe a pgid the OS
	// may have recycled into an unrelated group.
	let terminated = false;
	let onAbort: (() => void) | undefined;

	const removeAbort = (): void => {
		if (onAbort && opts.signal) {
			opts.signal.removeEventListener("abort", onAbort);
			onAbort = undefined;
		}
	};

	const deregister = (): void => {
		if (deregistered) return;
		deregistered = true;
		terminated = true;
		liveOwners.delete(owner);
		removeAbort();
	};

	const signalTree = (signal: NodeJS.Signals): void => {
		const pid = child.pid;
		if (pid === undefined) return;
		if (pgid !== undefined) {
			try {
				// Negative pid signals the entire process group (child is leader).
				process.kill(-pgid, signal);
			} catch {
				// Group already gone; nothing to do.
			}
			return;
		}
		// Single-process fallback (Windows / non-group child, e.g. the U14 rpc
		// branch which spawns without detached). child.kill() is best-effort;
		// fall through to process.kill() when it reports no delivery.
		if (signal === "SIGKILL" || !child.kill(signal)) {
			try {
				process.kill(pid, signal);
			} catch {
				/* already gone */
			}
		}
	};

	const owner: OwnedProcess = {
		child,
		get pid() {
			return child.pid;
		},
		get pgid() {
			return pgid;
		},
		get exited() {
			return exited;
		},
		get disposed() {
			return disposed;
		},
		get terminated() {
			return terminated;
		},
		async awaitExit({ timeoutMs }: { timeoutMs?: number } = {}): Promise<AwaitExitResult> {
			const exitedResult = exited.then((code) => ({ exited: true as const, code }));
			if (timeoutMs === undefined) return exitedResult;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<AwaitExitResult>((resolve) => {
				timer = setTimeout(() => resolve({ exited: false, code: child.exitCode }), Math.max(0, timeoutMs));
				timer.unref?.();
			});
			try {
				return await Promise.race([exitedResult, timeout]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
		dispose(): Promise<void> {
			// Already terminal (e.g. clean drain reconciled and deregistered):
			// never re-probe the pgid; treat dispose as a settled no-op.
			if (terminated) {
				disposed = true;
				if (!disposePromise) disposePromise = Promise.resolve();
				return disposePromise;
			}
			if (disposePromise) return disposePromise;
			disposed = true;
			removeAbort();
			disposePromise = (async () => {
				try {
					if (pgid !== undefined) {
						// Group ownership: reap until the whole group is gone, even if
						// the root has already exited (it may have backgrounded children).
						if (!groupAlive(pgid)) return;
						signalTree("SIGTERM");
						if (await pollUntil(() => !groupAlive(pgid), gracefulMs)) return;
						signalTree("SIGKILL");
						if (!(await pollUntil(() => !groupAlive(pgid), SIGKILL_REAP_CAP_MS))) {
							logInternalError(
								"child-pi.owned-sigkill-cap",
								new Error(`owned process group still alive after SIGKILL cap (${SIGKILL_REAP_CAP_MS}ms); giving up`),
								`name=${opts.name} pgid=${pgid}`,
								"warn",
							);
						}
						return;
					}
					// Single-process fallback (Windows / processGroup:false / rpc child).
					if (child.exitCode !== null) return;
					signalTree("SIGTERM");
					if ((await owner.awaitExit({ timeoutMs: gracefulMs })).exited) return;
					signalTree("SIGKILL");
					await owner.awaitExit({ timeoutMs: SIGKILL_REAP_CAP_MS });
				} catch (err) {
					logInternalError(
						"child-pi.owned-dispose-failed",
						err instanceof Error ? err : new Error(String(err)),
						`name=${opts.name}`,
					);
				} finally {
					// Deregister only AFTER teardown completed so a postmortem firing
					// mid-grace still sees the owner and awaits this in-flight dispose.
					deregister();
				}
			})();
			return disposePromise;
		},
	};

	liveOwners.add(owner);

	// When the root exits on its own (not via dispose), reconcile ownership by
	// the *group*. After a short drain window: if the group is empty, deregister;
	// if descendants are still alive, reap the owned group (no child outlives its
	// owner). Either way the owner never lingers holding a stale pgid that the OS
	// could later recycle and a stray dispose could mis-signal.
	void exited.finally(() => {
		if (disposed) return; // dispose() owns deregistration
		if (pgid === undefined) {
			deregister();
			return;
		}
		void (async () => {
			const drained = await pollUntil(() => !groupAlive(pgid), ROOT_EXIT_DRAIN_MS);
			if (disposed) return;
			if (drained) {
				deregister();
				return;
			}
			// Root exited but the owned group still has descendants: reap them.
			// dispose() escalates SIGTERM→SIGKILL and deregisters in its finally.
			await owner.dispose();
		})();
	});

	if (opts.signal) {
		if (opts.signal.aborted) {
			void owner.dispose();
		} else {
			onAbort = () => void owner.dispose();
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	return owner;
}

/**
 * Spawn a child process owned by the runtime. The returned {@link OwnedProcess}
 * is registered for postmortem cleanup and tears down its whole process group
 * on dispose/abort. POSIX: spawned `detached:true` so the child is its own
 * session+group leader (pgid === pid).
 */
export function spawnOwnedProcess(command: string, args: string[], opts: SpawnOwnedOptions = {}): OwnedProcess {
	const useGroup = (opts.processGroup ?? true) && isPosix;
	const child = spawn(command, args, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: "ignore",
		detached: useGroup,
	});
	// Round-9 gotcha: do NOT child.unref() — the root handle must stay ref'd
	// or the exit event starves when the rest of the loop is idle, killing the
	// drain-reconcile above. Callers that want fire-and-forget semantics get
	// them from the postmortem registry instead.
	return createOwnedProcess(child, useGroup ? child.pid : undefined, opts);
}

/**
 * Adopt an ALREADY-spawned child into the owned-process registry. Group
 * leadership is resolved conservatively:
 *   - Linux: read the child's real pgrp from /proc — authoritative (covers
 *     the U14 rpc branch, whose RpcClient spawns WITHOUT detached: pgrp ≠ pid
 *     ⇒ single-process fallback, exactly the deferred behavior noted there).
 *   - Other POSIX: a live group with id === child.pid implies the child leads
 *     it (same pid-recycle exposure as the legacy killProcessPid group path).
 *   - Windows: no process groups ⇒ single-process fallback.
 */
export function adoptOwnedProcess(child: ChildProcess, opts: OwnedProcessOptions = {}): OwnedProcess {
	let pgid: number | undefined;
	if (isPosix && child.pid !== undefined) {
		const pgrp = readPgidFromProc(child.pid);
		if (pgrp !== undefined) {
			pgid = pgrp === child.pid ? child.pid : undefined;
		} else if (groupAlive(child.pid)) {
			pgid = child.pid;
		}
	}
	return createOwnedProcess(child, pgid, opts);
}

/** Number of currently live owned processes. Exposed for leak assertions/tests. */
export function liveOwnedProcessCount(): number {
	return liveOwners.size;
}

/** Dispose every live owned process (owner-scoped teardown, postmortem, tests). */
export async function disposeAllOwnedProcesses(): Promise<void> {
	await Promise.allSettled([...liveOwners].map((owner) => owner.dispose()));
}
