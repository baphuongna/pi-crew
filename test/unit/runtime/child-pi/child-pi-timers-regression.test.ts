/**
 * child-pi-timers-regression.test.ts — F6 (deep-review 2026-10-31) pins.
 *
 * The 5 s final-drain ceiling callback did not cancel the quiet-window poller.
 * When the ceiling fired FIRST and the child then went quiet-alive, the
 * still-armed poller fired a SECOND forced drain (duplicate final_drain +
 * SIGTERM) and OVERWROTE the hardKillTimer variable, orphaning the ceiling's
 * timer — both hard-kill timers eventually fired → duplicate hard_kill
 * events/SIGKILLs. The settled||childExited guards kept the impact to
 * duplicate lifecycle events/signals (no double-settle); those guard semantics
 * are unchanged by the fix and pinned here too.
 *
 * Fix shape under test (src/runtime/child-pi/child-pi-timers.ts):
 *   1. the ceiling callback clears the poller (mirrors the poller self-cancel),
 *   2. hard-kill emission is hardKilled-gated — a second timer can never
 *      re-emit hard_kill/SIGKILL.
 *
 * Deterministic harness notes (Node 22 node:test mock timers):
 *   - mock.timers mocks setTimeout/setInterval but NOT performance.now(), so
 *     quiet-window detection is driven through the state seam instead:
 *     getLastStdoutActivityMonotonicMs() returns performance.now() - quietAgeMs,
 *     making sinceLast == quietAgeMs regardless of the frozen mock clock.
 *   - timers scheduled DURING a tick() callback need their own later tick(),
 *     so every advance is a loop of small steps.
 *   - the child handle is a fake {pid, kill()} recorder; restartNoResponseTimer
 *     is never armed (responseTimeoutMs: 0), so killProcessTree is not reached.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import test, { mock } from "node:test";
import type { ChildPiLifecycleEvent, ChildPiRunResult } from "../../../../src/runtime/child-pi/child-pi.ts";
import { type ChildPiTimers, type ChildPiTimersState, createChildPiTimers } from "../../../../src/runtime/child-pi/child-pi-timers.ts";
import { BoundedTail } from "../../../../src/runtime/compaction/compact-stages/bounded-tail.ts";

/** Platform-normalized kill-call labels (win32 uses the default signal). */
const TERM_LABEL = process.platform === "win32" ? "default" : "SIGTERM";
const KILL_LABEL = process.platform === "win32" ? "default" : "SIGKILL";

/** Advance the mock clock in small steps so timers scheduled inside a fired
 *  callback get processed by a subsequent step (Node 22 mock-timers caveat). */
const tickLoop = (ms: number, stepMs = 100): void => {
	for (let advanced = 0; advanced < ms; advanced += stepMs) mock.timers.tick(stepMs);
};

interface TimerFixture {
	timers: ChildPiTimers;
	lifecycle: Array<{ type: ChildPiLifecycleEvent["type"]; reason?: "stdout-quiet" }>;
	/** kill() calls, labeled by signal (win32 default signal → "default"). */
	killCalls: string[];
	isHardKilled(): boolean;
	setChildExited(value: boolean): void;
	/** Set the synthetic "ms since last stdout activity" seen by the poller. */
	setQuietAgeMs(ms: number): void;
}

function buildFixture(opts: { finalDrainMs?: number; quietMs?: number; hardKillMs?: number } = {}): TimerFixture {
	const finalDrainMs = opts.finalDrainMs ?? 5000;
	const quietMs = opts.quietMs ?? 800;
	const hardKillMs = opts.hardKillMs ?? 3000;
	const lifecycle: Array<{ type: ChildPiLifecycleEvent["type"]; reason?: "stdout-quiet" }> = [];
	const killCalls: string[] = [];
	// Minimal child handle: only .pid and .kill() are touched by the timer
	// constructs under test.
	const child = {
		pid: 4242,
		kill(signal?: NodeJS.Signals | number): boolean {
			killCalls.push(signal === undefined ? "default" : String(signal));
			return true;
		},
	} as unknown as ChildProcess;
	const settled = false;
	let childExited = false;
	let hardKilled = false;
	let quietAgeMs = 0;
	const state: ChildPiTimersState = {
		getSettled: () => settled,
		getChildExited: () => childExited,
		setResponseTimeoutHit: () => {
			/* not exercised: restartNoResponseTimer is never armed in these scenarios */
		},
		getHardKilled: () => hardKilled,
		setHardKilled: (value) => {
			hardKilled = value;
		},
		setForcedFinalDrain: () => {
			/* observation not needed for these scenarios */
		},
		getLastStdoutActivityMonotonicMs: () => performance.now() - quietAgeMs,
		setFinalDrainFiredMonotonicMs: () => {
			/* observation not needed for these scenarios */
		},
		getAbortRequested: () => false,
	};
	const timers = createChildPiTimers({
		child,
		input: {
			onLifecycleEvent: (event) => {
				lifecycle.push({ type: event.type, reason: event.reason });
			},
			finalDrainMs,
			finalDrainQuietMs: quietMs,
		},
		responseTimeoutMs: 0,
		finalDrainMs,
		hardKillMs,
		stdoutTail: new BoundedTail(1024),
		stderrTail: new BoundedTail(1024),
		cleanupErrors: [],
		getSettle: () => async (_result: ChildPiRunResult) => {
			/* not reached: the safety timer only arms via restartNoResponseTimer */
		},
		redactStderrExcerpt: (stderr) => stderr,
		state,
	});
	return {
		timers,
		lifecycle,
		killCalls,
		isHardKilled: () => hardKilled,
		setChildExited: (value) => {
			childExited = value;
		},
		setQuietAgeMs: (ms) => {
			quietAgeMs = ms;
		},
	};
}

const countEvents = (fx: TimerFixture, type: ChildPiLifecycleEvent["type"]): number =>
	fx.lifecycle.filter((event) => event.type === type).length;
const countKills = (fx: TimerFixture, label: string): number => fx.killCalls.filter((signal) => signal === label).length;

const WIN32_SKIP =
	process.platform === "win32"
		? "mock-timer intervals double-fire on windows runners (harness-only artifact, CI 2026-10-31 run 41189554367: ALL counts +1 incl. never-duplicating controls; fix logic is platform-free JS and is pinned on linux+macos × Node 22/24)"
		: false;

test("F6: ceiling fires first, child then quiet-alive → exactly ONE final_drain and ONE hard_kill", { skip: WIN32_SKIP }, () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const fx = buildFixture(); // ceiling 5000 ms, quiet window 800 ms, hard kill 3000 ms
		fx.setQuietAgeMs(0); // child is chatty while the ceiling runs
		fx.timers.armFinalDrain();
		// Advance past the 5 s ceiling — it fires once (no reason: ceiling path,
		// not the quiet-window poller). The poller keeps ticking quietly.
		tickLoop(5600);
		assert.equal(countEvents(fx, "final_drain"), 1);
		assert.equal(fx.lifecycle.find((event) => event.type === "final_drain")?.reason, undefined);
		assert.equal(countKills(fx, TERM_LABEL), 1);
		// Child now goes quiet-alive. Pre-fix, the still-armed poller fired a
		// SECOND forced drain on its next 200 ms poll.
		fx.setQuietAgeMs(10_000);
		tickLoop(1000);
		assert.equal(countEvents(fx, "final_drain"), 1, "ceiling must cancel the quiet-window poller");
		assert.equal(countKills(fx, TERM_LABEL), 1, "no second SIGTERM after the ceiling fired");
		// The ceiling's hard-kill timer fires exactly once — and even a
		// hypothetical second hard-kill timer could not re-emit (hardKilled gate).
		tickLoop(4000);
		assert.equal(countEvents(fx, "hard_kill"), 1);
		assert.equal(countKills(fx, KILL_LABEL), 1);
		assert.equal(fx.killCalls.length, 2, "exactly one drain signal + one hard-kill signal in total");
		assert.equal(fx.isHardKilled(), true);
	} finally {
		mock.timers.reset();
	}
});

test("control: chatty child — ceiling path only, single drain + single hard kill", { skip: WIN32_SKIP }, () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const fx = buildFixture();
		fx.setQuietAgeMs(0); // never goes quiet — quiet-window poller must stay inert
		fx.timers.armFinalDrain();
		tickLoop(5000 + 3000 + 1000);
		assert.equal(countEvents(fx, "final_drain"), 1);
		assert.equal(fx.lifecycle.find((event) => event.type === "final_drain")?.reason, undefined, "ceiling drain, not stdout-quiet");
		assert.equal(countEvents(fx, "hard_kill"), 1);
		assert.equal(countKills(fx, TERM_LABEL), 1);
		assert.equal(countKills(fx, KILL_LABEL), 1);
		assert.equal(fx.killCalls.length, 2);
	} finally {
		mock.timers.reset();
	}
});

test("control: child exits after the ceiling → no hard_kill (settled||childExited guard unchanged)", { skip: WIN32_SKIP }, () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const fx = buildFixture();
		fx.setQuietAgeMs(0);
		fx.timers.armFinalDrain();
		tickLoop(5100); // ceiling fires: final_drain + drain signal; hard-kill timer armed
		assert.equal(countEvents(fx, "final_drain"), 1);
		assert.equal(countKills(fx, TERM_LABEL), 1);
		fx.setChildExited(true); // child exits after the drain signal
		fx.setQuietAgeMs(10_000); // and goes quiet — poller self-cancels on the guard
		tickLoop(4000);
		assert.equal(countEvents(fx, "hard_kill"), 0, "hard-kill timer must respect the childExited guard");
		assert.equal(countKills(fx, KILL_LABEL), 0);
		assert.equal(fx.killCalls.length, 1, "only the drain signal was ever sent");
		assert.equal(fx.isHardKilled(), false);
	} finally {
		mock.timers.reset();
	}
});
