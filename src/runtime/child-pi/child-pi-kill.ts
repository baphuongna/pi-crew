/**
 * child-pi-kill.ts — Kill/escape path for child Pi worker processes.
 *
 * Extracted from child-pi.ts (H-7 decomposition, step 2).
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
 *
 * U15 (upgrade-spec 2026-10-09): every child registered via registerActiveChild
 * is ALSO adopted into the OwnedProcess registry (owned-process.ts) — kills then
 * route through the escalating group dispose (SIGTERM → poll → SIGKILL → cap →
 * warn give-up) instead of a one-shot fire-and-forget signal pair, and the
 * root-exit drain-reconcile reaps backgrounded descendants. The background
 * zombie scanner and the child-side PI_CREW_PARENT_PID guard are KEPT as the
 * complementary layers (owner-side catchable exits vs child-side leader-death
 * backstop — see spec U15 "Complementary" note).
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { DEFAULT_CHILD_PI } from "../../config/defaults.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { TailCaptureStage } from "../compaction/compact-stages/tail-capture-stage.ts";
import { type ProcIdentity, readProcIdentity, reapGroup, resolveReapGroupEnabled } from "../process/reap-group.ts";
import { HARD_KILL_MS } from "./child-pi-constants.ts";
import { adoptOwnedProcess, disposeAllOwnedProcesses, type OwnedProcess } from "./owned-process.ts";

const MAX_CAPTURE_BYTES = DEFAULT_CHILD_PI.maxCaptureBytes;

// Active children bookkeeping. Mutated by registerActiveChild/unregisterActiveChild.
const activeChildProcesses = new Map<number, ChildProcess>();
const childHardKillTimers = new Map<number, NodeJS.Timeout>();

// U15: adopted OwnedProcess handles by pid. Filled by registerActiveChild;
// entries survive root exit on purpose (the owned process owns the drain-
// reconcile of backgrounded descendants) and are pruned by the scanner below
// once the owner reaches its terminal state.
const ownedByPid = new Map<number, OwnedProcess>();

// Wave 11a (F1): the /proc identity snapshot of each registered child, taken
// AT REGISTRATION (while the child is definitely alive). This is the only
// pre-exit record of the child's pgid/starttime — once the root exits, /proc is
// gone and `adoptOwnedProcess`'s live pgid resolution (owned-process.ts) has
// nothing left to read, so a still-live group becomes unreachable. killProcessTree
// uses this snapshot for the exited-root case; the 60 s sweep prunes it once the
// owner is terminal.
const identityByPid = new Map<number, ProcIdentity>();

// Wave 11a injection seam (same shape as zombie-scanner.ts `__test`): tests seed
// identity snapshots and swap the group reaper without a real child process.
let reapGroupImpl: typeof reapGroup = reapGroup;
// Wave 16 (E1): injectable /proc identity reader for killProcessPid's PID-recycle
// re-validation — tests simulate a recycled starttime without racing the OS for
// a real pid reuse. registerActiveChild deliberately keeps the REAL reader (its
// identityByPid snapshot is production /proc state, not a test fixture).
let readProcIdentityImpl: typeof readProcIdentity = readProcIdentity;
export const __test = {
	/** Seed the exit-time identity snapshot for a pid (as registerActiveChild would). */
	seedIdentity(pid: number, identity: ProcIdentity | undefined): void {
		if (identity === undefined) identityByPid.delete(pid);
		else identityByPid.set(pid, identity);
	},
	/** Drop every seeded/recorded identity snapshot. */
	clearIdentities(): void {
		identityByPid.clear();
	},
	/** Replace the group reaper (undefined restores the real one). */
	setReapGroup(fn: typeof reapGroup | undefined): void {
		reapGroupImpl = fn ?? reapGroup;
	},
	/** Replace the /proc identity reader used by killProcessPid's E1 re-validation (undefined restores the real one). */
	setReadProcIdentity(fn: typeof readProcIdentity | undefined): void {
		readProcIdentityImpl = fn ?? readProcIdentity;
	},
};

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
	// U15: prune adopted owners that reached terminal state (group confirmed
	// gone via dispose or drain-reconcile). Non-terminal owners stay routable.
	for (const [pid, owner] of ownedByPid) {
		if (!owner.terminated) continue;
		ownedByPid.delete(pid);
		// Wave 11a: the owner confirmed its group is gone — the snapshot is spent.
		identityByPid.delete(pid);
	}
}, 60_000).unref();

/** Register a newly-spawned child so it can be tracked + killed on shutdown. */
export function registerActiveChild(pid: number, child: ChildProcess): void {
	activeChildProcesses.set(pid, child);
	// U15: adopt into the owned-process registry so kill paths escalate through
	// group dispose. Group leadership is resolved inside adoptOwnedProcess
	// (authoritative /proc check on Linux — the rpc branch child, spawned
	// without detached, lands on the single-process fallback automatically).
	ownedByPid.set(pid, adoptOwnedProcess(child, { name: `child-pi:${pid}` }));
	// Wave 11a (F1): snapshot the identity NOW — the child is alive here, so
	// /proc is readable. killProcessTree's exited-root branch reaps the group
	// from this snapshot after the root is gone.
	const identity = readProcIdentity(pid);
	if (identity) identityByPid.set(pid, identity);
}

/**
 * Remove a child from the active set once it has exited (or before kill).
 *
 * NOTE (U15): this does NOT drop the adopted OwnedProcess handle — the owner
 * still owes a drain-reconcile for backgrounded descendants after the root
 * exit. The owned entry is pruned by the scanner once terminal.
 */
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
	// U15: adopted children escalate through the owned dispose ladder
	// (SIGTERM group → poll → SIGKILL group → cap → warn give-up) instead of
	// the one-shot signal pair below. External pid-only callers that never
	// registered (live-session agents, cancel paths on stale pids) keep the
	// legacy one-shot behavior unchanged.
	const owned = ownedByPid.get(pid);
	if (owned) {
		void owned.dispose();
		return;
	}
	// E1 (fix-wave 16): baseline the pid's /proc starttime (stat field 22) while
	// it is alive at kill entry; the hard-kill timer below re-reads it and
	// refuses to signal a CHANGED starttime — the original process exited during
	// the grace window and an unrelated process recycled the pid. Effectively
	// Linux-only: Windows has no /proc (readProcIdentity → undefined ⇒ no
	// baseline ⇒ the timer keeps the pre-wave unconditional behavior — see the
	// win32 branch note below), and /proc-less POSIX (macOS) degrades the same
	// way. Deliberately NOT the registration-snapshot pattern (identityByPid):
	// external pid-only callers — live-session agents, cancel paths on stale
	// pids — have no registration to consult.
	const baselineStarttime = process.platform === "win32" ? undefined : readProcIdentityImpl(pid)?.starttime;
	try {
		if (process.platform === "win32") {
			// 3.8: Windows path uses taskkill /T /F (force kill the entire tree).
			// E1 note: Windows has no /proc, so no starttime baseline/re-validation
			// is possible here — behavior stays exactly as before. taskkill /T /F on
			// a recycled pid fails harmlessly ("process not found"), so the residual
			// recycle window is not actionable on this platform.
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
			// E1: PID-recycle re-validation immediately before the hard kill —
			// guards BOTH the group kill (-pid) below and the absolute-pid fallback
			// inside its catch. Skip ONLY on a proven mismatch (baseline known AND
			// current known AND different): an unreadable current value means the pid
			// is already gone (the kill below reports ESRCH exactly as before) or
			// /proc is unavailable on this platform (there was never a baseline to
			// compare against).
			const currentStarttime = readProcIdentityImpl(pid)?.starttime;
			if (baselineStarttime !== undefined && currentStarttime !== undefined && currentStarttime !== baselineStarttime) {
				logInternalError(
					"child-pi.sigkill-pid-recycled",
					new Error(
						`starttime changed between SIGTERM and the hard-kill timer (${baselineStarttime} → ${currentStarttime}) — pid was recycled, skipping hard kill of the unrelated new occupant`,
					),
					`pid=${pid}`,
					"warn",
				);
				childHardKillTimers.delete(pid);
				return;
			}
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
	// U15: route adopted children through the escalating owned dispose. This
	// deliberately BYPASSES the `child.exitCode !== null` early-out below: a
	// dead root can still have live backgrounded descendants in its group, and
	// dispose() is the component that knows (groupAlive is its source of truth;
	// a terminal owner settles as a no-op via the PID-recycle guard).
	const owned = ownedByPid.get(pid);
	if (owned) {
		void owned.dispose();
		return;
	}
	if (child && child.exitCode !== null) {
		// Wave 11a (F1): an EXITED ROOT IS NOT AN EMPTY GROUP. The root may have
		// backgrounded descendants that are still alive in its process group; the
		// pre-wave early-out returned here and left them running forever. We reap
		// the group only when the registration-time snapshot PROVES the root was
		// its own group leader (pgid === pid) — reapGroup re-validates everything
		// (uid/pgid/starttime) and refuses on a recycled pgid. No snapshot, or a
		// non-leader root, keeps the pre-wave behaviour exactly (no signal, and
		// nothing logged above debug).
		const identity = identityByPid.get(pid);
		if (identity?.pgid === pid && resolveReapGroupEnabled()) {
			const result = reapGroupImpl(pid, pid, { name: `child-pi:exited-root:${pid}`, expected: identity });
			// MINOR #5 (review): the SIGKILL escalation is fire-and-forget here (this
			// caller is sync), so it must be explicitly swallowed — `reapGroup` never
			// rejects by contract, but a `void` promise is exactly what turns an
			// unexpected rejection into a FATAL unhandled rejection on Node 22.
			void result.pending.catch(() => {
				/* settle-only: the escalation verdict is not actionable here */
			});
			identityByPid.delete(pid);
		} else {
			logInternalError(
				"child-pi.kill-exited-root-no-snapshot",
				new Error(`exited root pid=${pid} has no group-leader snapshot; no signal sent`),
				`pid=${pid}`,
				"debug",
			);
		}
		return;
	}
	killProcessPid(pid);
	child?.once("exit", () => clearHardKillTimer(pid));
}

export function terminateActiveChildPiProcesses(): number {
	const entries = [...activeChildProcesses.entries()];
	for (const [pid, child] of entries) killProcessTree(pid, child);
	// U15: also reap owners whose active-set entry is already gone (root exited,
	// backgrounded descendants mid-drain). Fire-and-forget by design — the sync
	// SIGTERM prefix is delivered immediately; the ladder completes while the
	// shutdown path drains, and the postmortem registry covers a hard exit.
	void disposeAllOwnedProcesses();
	return entries.length;
}
