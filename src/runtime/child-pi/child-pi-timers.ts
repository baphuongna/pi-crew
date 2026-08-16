/**
 * child-pi-timers.ts — Timer constructs for the runChildPi Promise body.
 *
 * Extracted from child-pi.ts (Phase 2.3 of the maintainability refactor).
 * Pure code motion — zero behavior change. The six timer constructs that were
 * local to the Promise constructor inside runChildPi now live here, owned by a
 * single factory instance:
 *
 *   1. noResponseTimer  — unresponsive-worker guard (restartNoResponseTimer)
 *   2. finalDrainTimer  — 5 s drain ceiling after the final assistant event
 *   3. hardKillTimer    — SIGTERM → SIGKILL escalation after final drain
 *   4. safetyTimer      — #3 hardening: bounded settle if the child is immortal
 *   5. cancelHardKill   — 200 ms fast-escalate on explicit cancel (R6-F1)
 *   6. pollHandle       — F12 quiet-window interval (early drain on stdout silence)
 *
 * The callbacks close over many runChildPi locals (child, settled, childExited,
 * stderrTail, stdoutTail, hardKilled, forcedFinalDrain, responseTimeoutHit,
 * lastStdoutActivityMonotonicMs, finalDrainFiredMonotonicMs, input callbacks,
 * logInternalError, killProcessTree, settle, ...). Those are threaded through
 * `deps` (values) + `state` (getters/setters over the runChildPi-local flags)
 * so behavior is preserved byte-for-byte.
 *
 * R6-F1 (refactor-plan.review.md §ROUND 6): clearAll() MUST cover all six
 * constructs — previously cancelHardKill was a local const inside abort() and
 * was NOT cleared by clearChildPiTimeouts(), leaking a 200 ms unref'd timer per
 * cancel on short-lived children.
 */
import type { ChildProcess } from "node:child_process";
import { DEFAULT_CHILD_PI } from "../../config/defaults.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import type { BoundedTail } from "../compaction/compact-stages/bounded-tail.ts";
import type { ChildPiRunInput, ChildPiRunResult } from "./child-pi.ts";
import { HARD_KILL_MS } from "./child-pi-constants.ts";
import { killProcessTree } from "./child-pi-kill.ts";

/** Mutable run state shared with runChildPi via getters/setters. */
export interface ChildPiTimersState {
	getSettled(): boolean;
	getChildExited(): boolean;
	setResponseTimeoutHit(value: boolean): void;
	getHardKilled(): boolean;
	setHardKilled(value: boolean): void;
	setForcedFinalDrain(value: boolean): void;
	getLastStdoutActivityMonotonicMs(): number;
	setFinalDrainFiredMonotonicMs(value: number): void;
	getAbortRequested(): boolean;
}

export interface ChildPiTimersDeps {
	child: ChildProcess;
	/** Raw run input — only the timer-relevant fields are read. */
	input: Pick<ChildPiRunInput, "onLifecycleEvent" | "finalDrainMs" | "finalDrainQuietMs">;
	/** Computed timings (identical formulas to runChildPi). */
	responseTimeoutMs: number;
	finalDrainMs: number;
	hardKillMs: number;
	/** Bounded accumulators (P0-1) — snapshotted inside timer callbacks. */
	stdoutTail: BoundedTail;
	stderrTail: BoundedTail;
	/** Cleanup-error accumulator shared with settle(). */
	cleanupErrors: string[];
	/** settle() — the run finalizer, also called from the safety path.
	 *  Provided as a getter because `settle` is declared later in the runChildPi
	 *  Promise body than this factory is constructed; the getter is only
	 *  invoked from the safety timer (≥ HARD_KILL_MS + 2 s after a response
	 *  timeout), by which point the binding is initialized. */
	getSettle: () => (result: ChildPiRunResult) => Promise<void>;
	/** SEC-1 redaction helper (defined in child-pi.ts, passed in to avoid a
	 *  runtime import cycle). */
	redactStderrExcerpt: (stderr: string, maxChars: number) => string;
	state: ChildPiTimersState;
}

export interface ChildPiTimers {
	restartNoResponseTimer(): void;
	clearNoResponseTimer(): void;
	/** F12: arm the final-drain ceiling timer plus (optionally) the quiet-window
	 *  poller that fires the drain early when stdout goes quiet. */
	armFinalDrain(): void;
	/** True when the 5 s drain ceiling timer is currently armed. */
	hasFinalDrainTimer(): boolean;
	/** 3.5 — arm the 200 ms fast-escalate SIGKILL for explicit cancel. */
	armCancelHardKill(): void;
	clearFinalDrainTimers(): void;
	/** Clear ALL six timer constructs (R6-F1: incl. cancelHardKill). */
	clearAll(): void;
}

export function createChildPiTimers(deps: ChildPiTimersDeps): ChildPiTimers {
	let finalDrainTimer: NodeJS.Timeout | undefined;
	let hardKillTimer: NodeJS.Timeout | undefined;
	let noResponseTimer: NodeJS.Timeout | undefined;
	let safetyTimer: NodeJS.Timeout | undefined;
	let cancelHardKillTimer: NodeJS.Timeout | undefined;
	let pollHandle: NodeJS.Timeout | undefined;

	const restartNoResponseTimer = (): void => {
		if (deps.responseTimeoutMs <= 0) return;
		if (noResponseTimer) clearTimeout(noResponseTimer);
		noResponseTimer = setTimeout(() => {
			deps.state.setResponseTimeoutHit(true);
			// P0-1: snapshot the bounded stderr accumulator once for this timer fire.
			const stderr = deps.stderrTail.value();
			// Capture stderr at timeout moment for debugging
			// SEC-1: redact secrets before embedding in lifecycle event so
			// worker-emitted secrets (API keys etc.) don't bypass redaction.
			const timeoutStderr = deps.redactStderrExcerpt(stderr, 1024); // Last 1KB of stderr (redacted, SEC-1)
			deps.input.onLifecycleEvent?.({
				type: "response_timeout",
				pid: deps.child.pid,
				error: `No output for ${deps.responseTimeoutMs}ms`,
				ts: new Date().toISOString(),
				stderr: timeoutStderr || undefined,
			});
			killProcessTree(deps.child.pid, deps.child);
			try {
				deps.child.kill(process.platform === "win32" ? undefined : "SIGTERM");
			} catch (error) {
				logInternalError("child-pi.response-timeout-term", error, `pid=${deps.child.pid}`);
			}
			// #3 hardening: if the child never exits (zombie) and neither the
			// 'exit' nor 'close' event ever fires, the promise would hang forever.
			// SIGKILL fires ~3s after SIGTERM via hardKillTimer in killProcessPid,
			// but on platforms where SIGKILL also fails (e.g. permission issues),
			// add a bounded safety settle so the promise always resolves. Using
			// hardKillMs + 2s as the safety window: enough for SIGKILL to work
			// normally, but forces settle if the process is truly immortal.
			// NOTE: we do NOT clear hardKillTimer here (that would defeat its purpose);
			// we intentionally add a parallel safety path.
			const SAFETY_SETTLE_MS = HARD_KILL_MS + 2000;
			safetyTimer = setTimeout(() => {
				if (deps.state.getSettled() || deps.state.getChildExited()) return;
				logInternalError(
					"child-pi.settle-safety-fired",
					new Error(`Child did not exit within ${SAFETY_SETTLE_MS}ms of kill; forcing settle`),
					`pid=${deps.child.pid}, responseTimeoutMs=${deps.responseTimeoutMs}`,
				);
				// Verify the child is still alive before forcing settle.
				// If it somehow exited between childExited=false and here, the
				// settled/childExited guard prevents double-settle (harmless but noisy).
				try {
					process.kill(deps.child.pid!, 0);
					// Child still alive — force settle with timeout error.
					const timeoutErr = `Child Pi produced no new output for ${deps.responseTimeoutMs}ms; killed but did not exit within ${SAFETY_SETTLE_MS}ms (possible zombie).`;
					void deps.getSettle()({
						exitCode: null,
						stdout: deps.stdoutTail.value(),
						stderr: deps.stderrTail.value(),
						error: timeoutErr,
						exitStatus: {
							exitCode: null,
							cancelled: deps.state.getAbortRequested(),
							timedOut: true,
							killed: deps.state.getHardKilled(),
							cleanupErrors: deps.cleanupErrors,
							finalDrainMs: deps.finalDrainMs,
							crashClass: "timeout",
						},
					});
				} catch {
					// ESRCH / EPERM — child is already gone. The 'exit'/'close' handler
					// will fire shortly (or already fired in a race). Let it settle normally.
				}
			}, SAFETY_SETTLE_MS);
			safetyTimer.unref();
		}, deps.responseTimeoutMs);
		noResponseTimer.unref();
	};
	const clearNoResponseTimer = (): void => {
		if (noResponseTimer) clearTimeout(noResponseTimer);
		noResponseTimer = undefined;
	};
	const clearFinalDrainTimers = (): void => {
		if (finalDrainTimer) clearTimeout(finalDrainTimer);
		if (hardKillTimer) clearTimeout(hardKillTimer);
		finalDrainTimer = undefined;
		hardKillTimer = undefined;
	};

	return {
		restartNoResponseTimer,
		clearNoResponseTimer,
		clearFinalDrainTimers,
		armFinalDrain(): void {
			// F12: alongside the 5 s ceiling timer, start a polling watcher
			// that fires the drain early if stdout goes quiet for `quietMs`
			// after the final assistant event. Heavy children that emit a
			// stopReason=stop message_end and then sit idle will exit in
			// ~quietMs (default 800 ms) instead of up to up to 5 s. unref() so
			// the poller never holds the event loop on shutdown.
			// NOTE: The polling watcher is NOT explicitly cleared on process exit.
			// This is safe because: (1) it's unref()'d, so it won't prevent exit;
			// (2) the `settled || childExited` guard at the top prevents firing
			// after the child has exited; (3) sending SIGTERM to an already-
			// exiting process is harmless. The `finalDrainQuietMs` config allows
			// disabling this behavior (set >= finalDrainMs, e.g., 10000).
			const quietMs = deps.input.finalDrainQuietMs ?? DEFAULT_CHILD_PI.finalDrainQuietMs;
			if (quietMs < (deps.input.finalDrainMs ?? DEFAULT_CHILD_PI.finalDrainMs)) {
				pollHandle = setInterval(() => {
					if (deps.state.getSettled() || deps.state.getChildExited()) {
						if (pollHandle) {
							clearInterval(pollHandle);
							pollHandle.unref();
						}
						pollHandle = undefined;
						return;
					}
					const sinceLast = performance.now() - deps.state.getLastStdoutActivityMonotonicMs();
					if (sinceLast >= quietMs) {
						if (pollHandle) {
							clearInterval(pollHandle);
							pollHandle.unref();
						}
						pollHandle = undefined;
						// Trigger the same drain path as the 5 s timer:
						// mark forced, fire final_drain lifecycle, SIGTERM.
						deps.state.setForcedFinalDrain(true);
						deps.state.setFinalDrainFiredMonotonicMs(performance.now());
						deps.input.onLifecycleEvent?.({
							type: "final_drain",
							pid: deps.child.pid,
							ts: new Date().toISOString(),
							reason: "stdout-quiet",
						});
						try {
							deps.child.kill(process.platform === "win32" ? undefined : "SIGTERM");
						} catch (error) {
							logInternalError("child-pi.quiet-drain-term", error, `pid=${deps.child.pid}`);
						}
						// Mark for hard kill fallback so the existing timer is
						// still reaped if it ever fires later.
						hardKillTimer = setTimeout(() => {
							if (deps.state.getSettled() || deps.state.getChildExited()) return;
							try {
								deps.state.setHardKilled(true);
								deps.input.onLifecycleEvent?.({
									type: "hard_kill",
									pid: deps.child.pid,
									ts: new Date().toISOString(),
								});
								deps.child.kill(process.platform === "win32" ? undefined : "SIGKILL");
							} catch (error) {
								logInternalError("child-pi.quiet-drain-hard-kill", error, `pid=${deps.child.pid}`);
							}
						}, deps.hardKillMs);
						hardKillTimer.unref();
						// Cancel the 5 s ceiling so we don't double-fire.
						if (finalDrainTimer) {
							clearTimeout(finalDrainTimer);
							finalDrainTimer = undefined;
						}
					}
				}, 200);
				pollHandle.unref();
			}
			finalDrainTimer = setTimeout(() => {
				if (deps.state.getSettled() || deps.state.getChildExited()) return;
				deps.state.setForcedFinalDrain(true);
				deps.state.setFinalDrainFiredMonotonicMs(performance.now()); // Phase-0 diagnostic: race timing.
				deps.input.onLifecycleEvent?.({
					type: "final_drain",
					pid: deps.child.pid,
					ts: new Date().toISOString(),
				});
				try {
					deps.child.kill(process.platform === "win32" ? undefined : "SIGTERM");
				} catch (error) {
					logInternalError("child-pi.final-drain-term", error, `pid=${deps.child.pid}`);
				}
				hardKillTimer = setTimeout(() => {
					if (deps.state.getSettled() || deps.state.getChildExited()) return;
					try {
						deps.state.setHardKilled(true);
						deps.input.onLifecycleEvent?.({
							type: "hard_kill",
							pid: deps.child.pid,
							ts: new Date().toISOString(),
						});
						deps.child.kill(process.platform === "win32" ? undefined : "SIGKILL");
					} catch (error) {
						logInternalError("child-pi.final-drain-kill", error, `pid=${deps.child.pid}`);
					}
				}, deps.hardKillMs);
				hardKillTimer.unref();
			}, deps.finalDrainMs);
			finalDrainTimer.unref();
		},
		hasFinalDrainTimer(): boolean {
			return finalDrainTimer !== undefined;
		},
		armCancelHardKill(): void {
			// 3.5 — fast-escalate to SIGKILL within 200ms on explicit cancel
			// so /team-cancel completes round-trip well under the operator
			// expectation. The standard finalDrainMs / HARD_KILL_MS paths
			// are for graceful drain, not user-initiated cancel.
			cancelHardKillTimer = setTimeout(() => {
				if (deps.state.getSettled() || deps.state.getChildExited()) return;
				try {
					deps.state.setHardKilled(true);
					deps.child.kill(process.platform === "win32" ? undefined : "SIGKILL");
				} catch (error) {
					logInternalError("child-pi.cancel-fast-kill", error, `pid=${deps.child.pid}`);
				}
			}, 200);
			cancelHardKillTimer.unref();
		},
		clearAll(): void {
			// R6-F1: clear ALL six timer constructs. cancelHardKill was previously
			// a local const inside abort() — unreachable from clearChildPiTimeouts —
			// so repeated cancels on short-lived children accumulated 200 ms timers.
			clearNoResponseTimer();
			if (safetyTimer) clearTimeout(safetyTimer);
			safetyTimer = undefined;
			clearFinalDrainTimers();
			if (cancelHardKillTimer) clearTimeout(cancelHardKillTimer);
			cancelHardKillTimer = undefined;
			if (pollHandle) {
				clearInterval(pollHandle);
				pollHandle.unref();
			}
			pollHandle = undefined;
		},
	};
}
