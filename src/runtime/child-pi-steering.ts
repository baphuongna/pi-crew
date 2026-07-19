/**
 * child-pi-steering.ts — Turn-count-based steering controller for child Pi.
 *
 * Extracted from child-pi.ts (H-7 decomposition, step 5). Zero behavior change.
 *
 * The controller encapsulates the steering state machine:
 *   - Tracks turn count from `turn_end` events.
 *   - At `maxTurns`: triggers soft-limit steer (append advisory to steering file).
 *   - At `maxTurns + graceTurns`: triggers hard abort via killProcessTree.
 *
 * The hardAbortInitiated flag prevents the no-response timer from being
 * restarted after the hard-abort fires (CP-1 fix — see UPGRADE_REVIEW.md).
 */

import * as fs from "node:fs";
import { logInternalError } from "../utils/internal-error.ts";
import { killProcessTree } from "./child-pi-kill.ts";

/** Action emitted by the controller when a `turn_end` event is processed. */
export type SteeringAction =
	| { kind: "steer" }
	| { kind: "hardAbort"; pid: number; child: import("node:child_process").ChildProcess }
	| { kind: "none" };

/**
 * State machine for turn-count-based steering.
 *
 * Usage:
 *   const controller = new ChildPiSteeringController(maxTurns, graceTurns);
 *   // In onJsonEvent, when event.type === "turn_end":
 *   const action = controller.onTurnEnd(child.pid, child, input.steeringFile);
 *   if (action.kind === "hardAbort") killProcessTree(action.pid, action.child);
 *   // In all restartNoResponseTimer sites:
 *   if (!controller.isHardAbortInitiated()) restartNoResponseTimer();
 */
export class ChildPiSteeringController {
	private turnCount = 0;
	private softLimitReached = false;
	private hardAbortInitiatedFlag = false;
	private readonly maxTurns: number | undefined;
	private readonly graceTurns: number | undefined;

	constructor(maxTurns: number | undefined, graceTurns: number | undefined) {
		this.maxTurns = maxTurns;
		// FIX (Issue #1): Bound graceTurns to prevent the hard abort condition from
		// never triggering when an arbitrarily large value is passed.
		this.graceTurns = graceTurns !== undefined && graceTurns > 1000 ? 1000 : graceTurns;
	}

	/** Called on each `turn_end` event. Returns the action to take (if any). */
	onTurnEnd(
		pid: number | undefined,
		child: import("node:child_process").ChildProcess | undefined,
		steeringFile: string | undefined,
	): SteeringAction {
		this.turnCount += 1;
		// Soft limit: first turn at or beyond maxTurns → deliver "wrap up" advisory.
		if (this.maxTurns !== undefined && !this.softLimitReached && this.turnCount >= this.maxTurns) {
			this.softLimitReached = true;
			// C8: deliver the "wrap up" advisory by appending to the steering JSONL
			// file the child polls (PI_CREW_STEERING_FILE). The child is spawned with
			// stdio:["ignore",...], so child.stdin is null and the old stdin branch was
			// dead code that only spammed logs on every soft-limit hit. Advisory only —
			// the hard-abort below at maxTurns + graceTurns is the real enforcement, so
			// a failed write must NOT kill the worker.
			if (steeringFile) {
				try {
					fs.appendFileSync(
						steeringFile,
						JSON.stringify({
							type: "steer",
							message: "You have reached your turn limit. Wrap up immediately — provide your final answer now.",
						}) + "\n",
						"utf-8",
					);
				} catch (err) {
					logInternalError("child-pi.steer-write-failed", err instanceof Error ? err : new Error(String(err)), `pid=${pid}`);
				}
			}
			return { kind: "steer" };
		}
		// Hard abort: turn count reached maxTurns + graceTurns after soft limit was hit.
		if (this.maxTurns !== undefined && this.softLimitReached && this.turnCount >= this.maxTurns + (this.graceTurns ?? 5)) {
			// CP-1: escalate to killProcessTree (same as abort/noResponseTimer paths) and
			// set flag so onJsonEvent stops restarting the no-response timer.
			this.hardAbortInitiatedFlag = true;
			if (pid !== undefined && child) {
				killProcessTree(pid, child);
				return { kind: "hardAbort", pid, child };
			}
			return { kind: "none" };
		}
		return { kind: "none" };
	}

	/**
	 * Returns true once the hard-abort has been initiated. Callers (onJsonEvent,
	 * onStdoutLine, stdout/stderr data handlers) should skip restartNoResponseTimer
	 * when this returns true to avoid masking a SIGTERM-ignoring child.
	 */
	isHardAbortInitiated(): boolean {
		return this.hardAbortInitiatedFlag;
	}

	/**
	 * Returns true once the soft-limit steer has been delivered (the worker has
	 * been notified to wrap up). Used by runChildPi's settle path to distinguish
	 * a graceful-abort from a parent-abort.
	 */
	isSoftLimitReached(): boolean {
		return this.softLimitReached;
	}

	/** Current turn count (incremented on each `turn_end` event). */
	getTurnCount(): number {
		return this.turnCount;
	}

	/** Max turns configured (undefined = no limit). */
	getMaxTurns(): number | undefined {
		return this.maxTurns;
	}

	/** Grace turns configured (after soft limit before hard abort). */
	getGraceTurns(): number | undefined {
		return this.graceTurns;
	}
}
