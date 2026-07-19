/**
 * child-pi-kill.ts — Kill/escape path for child Pi worker processes.
 *
 * Extracted from child-pi.ts (H-7 decomposition, step 2). Zero behavior change.
 *
 * Responsibilities:
 *   - appendBoundedTail(): bounded concatenation with truncation marker.
 *   - killProcessPid(): send SIGTERM → SIGKILL escalation, with Windows taskkill fallback.
 *   - killProcessTree(): log+kill a child by pid, optionally attach exit listener to clear timer.
 *   - terminateActiveChildPiProcesses(): kill all known active children.
 *   - registerActiveChild()/unregisterActiveChild(): book-keeping for the active-children Map.
 *   - Periodic zombie reaper (setInterval) that drops dead entries.
 *
 * The activeChildrenMap and hardKillTimers Map are kept here (not re-exported)
 * because they are tightly coupled to the kill lifecycle.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { DEFAULT_CHILD_PI } from "../config/defaults.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { HARD_KILL_MS } from "./child-pi-constants.ts";
import { TailCaptureStage } from "./compact-stages/tail-capture-stage.ts";

const MAX_CAPTURE_BYTES = DEFAULT_CHILD_PI.maxCaptureBytes;

// Active children bookkeeping. Mutated by registerActiveChild/unregisterActiveChild.
const activeChildProcesses = new Map<number, ChildProcess>();
const childHardKillTimers = new Map<number, NodeJS.Timeout>();

// Periodic cleanup of dead child process entries to prevent memory leaks.
// If a child process never emits exit/close (zombie), the entry would leak.
setInterval(() => {
	for (const [pid, child] of activeChildProcesses) {
		try {
			process.kill(pid, 0); // Throws ESRCH if dead
		} catch {
			activeChildProcesses.delete(pid);
		}
	}
}, 60_000).unref();

/** Register a newly-spawned child so it can be tracked + killed on shutdown. */
export function registerActiveChild(pid: number, child: ChildProcess): void {
	activeChildProcesses.set(pid, child);
}

/** Remove a child from the active set once it has exited (or before kill). */
export function unregisterActiveChild(pid: number): void {
	activeChildProcesses.delete(pid);
}

/** Clear the SIGKILL escalation timer for a pid (called on early exit). */
export function clearHardKillTimer(pid: number | undefined): void {
	if (pid === undefined) return;
	const timer = childHardKillTimers.get(pid);
	if (timer) {
		clearTimeout(timer);
		childHardKillTimers.delete(pid);
	}
}

/**
 * Append `chunk` to `current`, keeping the result within `maxBytes`. When the
 * cap is exceeded, returns the tail (most recent bytes) prefixed with a marker
 * showing how much was dropped. Delegates to TailCaptureStage so the logic
 * stays consistent with the rest of the compaction pipeline.
 */
export function appendBoundedTail(current: string, chunk: string, maxBytes = MAX_CAPTURE_BYTES): string {
	return new TailCaptureStage({
		maxBytes,
		marker: `[pi-crew captured output truncated to last ${Math.round(maxBytes / 1024)} KiB]`,
	}).apply(current + chunk);
}

function spawnTaskkillSafe(pid: number): void {
	// B6: spawn taskkill and attach an 'error' listener. spawn() emits ENOENT/EACCES
	// via the 'error' event — unhandled these would become uncaughtException and
	// can crash the parent as an uncaught exception. taskkill is a standard Windows
	// utility and rarely fails to spawn, but be defensive.
	try {
		const taskkillChild = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
			stdio: "ignore",
			detached: false,
		});
		taskkillChild.on("error", (err) => {
			logInternalError("child-pi.taskkill-spawn-error", err instanceof Error ? err : new Error(String(err)), `pid=${pid}`);
		});
		taskkillChild.unref();
	} catch (error) {
		logInternalError("child-pi.taskkill-sync-error", error instanceof Error ? error : new Error(String(error)), `pid=${pid}`);
	}
}

export function killProcessPid(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		if (process.platform === "win32") {
			// 3.8: Windows path uses taskkill /T /F (force kill the entire tree).
			// taskkill itself can silently fail (PID gone, permission denied, etc.)
			// so verify after 2s and log a warning if the process is still alive.
			spawnTaskkillSafe(pid);
			const verifyTimer = setTimeout(() => {
				try {
					process.kill(pid, 0); // throws ESRCH when dead
					// Still alive — log and retry once.
					logInternalError(
						"child-pi.taskkill-stuck",
						new Error(`process ${pid} still alive 2s after taskkill /T /F; retrying`),
						`pid=${pid}`,
						"error",
					);
					try {
						spawnTaskkillSafe(pid);
					} catch {
						/* best-effort */
					}
				} catch {
					// ESRCH or EPERM — process is gone. OK.
				}
			}, 2000);
			verifyTimer.unref();
			return;
		}
		try {
			process.kill(-pid, "SIGTERM");
		} catch (error) {
			logInternalError("child-pi.sigterm", error, `pid=${pid}`);
			try {
				process.kill(pid, "SIGTERM");
			} catch (fallbackError) {
				logInternalError("child-pi.sigterm-absolute", fallbackError, `pid=${pid}`);
			}
		}
		clearHardKillTimer(pid);
		const hardKillTimer = setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch (error) {
				logInternalError("child-pi.sigkill", error, `pid=${pid}`);
				try {
					process.kill(pid, "SIGKILL");
				} catch (fallbackError) {
					logInternalError("child-pi.sigkill-absolute", fallbackError, `pid=${pid}`);
				}
			}
			childHardKillTimers.delete(pid);
		}, HARD_KILL_MS);
		hardKillTimer.unref();
		childHardKillTimers.set(pid, hardKillTimer);
	} catch (error) {
		logInternalError("child-pi.kill-process-pid", error, `pid=${pid}`);
	}
}

export function killProcessTree(pid: number | undefined, child?: ChildProcess): void {
	// Phase-0 diagnostic (HB-003a): capture who invoked killProcessTree so the
	// exit-null race has a provenance trail. .stack is best-effort (may be undefined
	// under deep async), so we take a snapshot lazily.
	try {
		const callerStack = new Error("killProcessTree caller").stack ?? "(no stack)";
		logInternalError(
			"child-pi.kill-process-tree-invoked",
			new Error(`pid=${pid} called from:\n${callerStack.split("\n").slice(0, 8).join("\n")}`),
			`pid=${pid}`,
		);
	} catch {
		/* diagnostic best-effort */
	}
	if (!pid || !Number.isInteger(pid) || pid <= 0) return;
	if (child && child.exitCode !== null) return;
	killProcessPid(pid);
	child?.once("exit", () => clearHardKillTimer(pid));
}

export function terminateActiveChildPiProcesses(): number {
	const entries = [...activeChildProcesses.entries()];
	for (const [pid, child] of entries) killProcessTree(pid, child);
	return entries.length;
}
