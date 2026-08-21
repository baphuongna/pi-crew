/**
 * child-process-shield.ts — stop abort-driven child-process errors from
 * killing the host pi process.
 *
 * THE CRASH
 * ---------
 * Node spawns a child with `options.signal` and the signal fires while that
 * child is still tracked (before its 'exit' event has dispatched), Node runs:
 *
 *   abortChildProcess(child, killSignal, reason)
 *     try { if (child.kill(killSignal)) {
 *       child.emit("error", new AbortError(...))   // node:child_process
 *     } } catch (err) { child.emit("error", err); }
 *
 * `child.emit("error", ...)` THROWS synchronously when the ChildProcess has
 * no 'error' listener (EventEmitter 'error'-event semantics). That throw is
 * captured by the AbortSignal dispatch machinery and re-thrown on the next
 * tick (`process.nextTick(() => { throw err; })`, node:internal/event_target)
 * — OUTSIDE any try/catch, so it surfaces as `uncaughtException` and pi dies
 * (`pi exiting due to uncaughtException: AbortError: The operation was
 * aborted`). This is exactly the crash seen on /crew-view session switches
 * mid-foreground-run: the run's signal propagates into the vendored pi SDK's
 * session machinery, an internal controller abort reaches a signal-spawned
 * child with no error listener, and the terminal dies.
 *
 * IMPORTANT: because the rethrow is asynchronous (next tick), wrapping the
 * AbortController.abort() call in try/catch (see safe-abort.ts) CANNOT stop
 * it. The only reliable fix is to make sure the spawned child ALWAYS has an
 * 'error' listener before an abort can fire, so child.emit("error", ...)
 * dispatches instead of throwing.
 *
 * THE SHIELD
 * ----------
 * 1. `ChildProcess.prototype.kill` — every abort path in node runs through
 *    `child.kill()` FIRST (abortChildProcess calls it before emitting), so a
 *    no-op 'error' listener attached inside kill() protects every signal-
 *    spawned child IN THE PROCESS, regardless of when the spawning module
 *    captured its `spawn` reference (the vendored SDK may bind `spawn` at a
 *    point we cannot observe).
 * 2. `child_process.spawn` wrapper — attaches the same no-op 'error' listener
 *    at spawn time when `options.signal` is present, so the listener exists
 *    before Node's pre-aborted-signal nextTick abort and before spawn-failure
 *    errors (ENOENT) are emitted.
 *
 * The no-op listener never swallows anything a consumer cares about: 'error'
 * events still reach every other listener (multiple listeners run), and code
 * that previously died on an unhandled 'error' event keeps its semantics for
 * genuinely broken spawns — it just no longer takes down the whole pi process
 * for the abort-after-exit case, which is a semantic no-op by definition (the
 * child was already gone).
 */
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const childProcessModule = require("node:child_process") as {
	spawn: (file: string, args?: readonly string[] | undefined, options?: object) => ChildProcess;
	ChildProcess: { prototype: { kill: (signal?: number | string) => boolean } };
};

const SHIELD_MARKER = Symbol.for("pi-crew.childProcessAbortShieldInstalled");

/** No-op 'error' listener: prevents the EventEmitter throw, never filters data. */
function shieldErrorListener(): void {
	/* deliberately empty — see module docstring */
}

/**
 * Install the child-process abort shield. Idempotent: subsequent calls are
 * no-ops. MUST be called at extension registration, before any team run can
 * start (the vendored SDK is imported lazily later, so any spawn it binds
 * afterwards already sees the shielded spawn).
 */
export function installChildProcessAbortShield(): void {
	const proto = childProcessModule.ChildProcess.prototype as typeof childProcessModule.ChildProcess.prototype & {
		[SHIELD_MARKER]?: boolean;
	};
	if (proto[SHIELD_MARKER]) return;

	const originalKill = proto.kill;
	proto.kill = function shieldedKill(this: ChildProcess, signal?: number | string): boolean {
		// A signal-spawned child may be aborted synchronously by node's
		// abortChildProcess right after this kill() returns; guarantee a
		// listener is present so child.emit("error", AbortError) dispatches
		// instead of throwing.
		if (this.listenerCount("error") === 0) this.on("error", shieldErrorListener);
		return originalKill.call(this, signal);
	};

	const moduleObject = childProcessModule as {
		spawn: typeof childProcessModule.spawn;
	};
	const originalSpawn = moduleObject.spawn;
	moduleObject.spawn = function shieldedSpawn(this: unknown, ...args: Parameters<typeof childProcessModule.spawn>) {
		const child = originalSpawn.apply(this, args);
		// Attach at spawn time: covers pre-aborted signals (node defers the
		// abort to the next tick) and spawn-failure errors (ENOENT etc.)
		// before any abort could fire.
		if (child && (args[2] as { signal?: unknown } | undefined)?.signal !== undefined) {
			child.on("error", shieldErrorListener);
		}
		return child;
	};

	proto[SHIELD_MARKER] = true;
}
