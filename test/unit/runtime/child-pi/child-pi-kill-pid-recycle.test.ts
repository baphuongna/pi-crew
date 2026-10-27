/**
 * child-pi-kill-pid-recycle.test.ts — fix-wave 16 (E1) pins.
 *
 * killProcessPid arms a hard-kill timer (HARD_KILL_MS) for EXTERNAL pid-only
 * callers that never registered an OwnedProcess (live-session agents, cancel
 * paths on stale pids). Between the SIGTERM at entry and that timer the pid can
 * exit and be RECYCLED by an unrelated process; the pre-wave timer signalled
 * kill(-pid)/kill(pid) blindly. E1 baselines the pid's /proc starttime at kill
 * entry and skips the hard kill when the timer's re-read proves a DIFFERENT
 * incarnation now owns the pid.
 *
 * The /proc reader is swapped via the `__test` seam — no real pid-reuse race:
 *   - (r1) mismatch    → NO SIGKILL (group or absolute) + a warn log; the
 *                        entry SIGTERM is unchanged,
 *   - (r2) match       → SIGKILL still attempted (pre-wave behavior),
 *   - (r3) no baseline → SIGKILL still attempted (the Windows//proc-less POSIX
 *                        degradation shape: readProcIdentity → undefined).
 *
 * The fixture child is spawned detached (its own group leader) so the entry
 * group SIGTERM reaches only that child; by timer time it is already gone, so
 * the "proceed" cases exercise the ESRCH-logged path exactly as production
 * would for a pid that died during the grace window.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import test from "node:test";
import { HARD_KILL_MS } from "../../../../src/runtime/child-pi/child-pi-constants.ts";
import { __test, clearHardKillTimer, killProcessPid } from "../../../../src/runtime/child-pi/child-pi-kill.ts";
import type { ProcIdentity } from "../../../../src/runtime/process/reap-group.ts";

const selfUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** Spawn a detached sleeping node — its own group leader, dies on SIGTERM. */
function spawnGroupLeaderChild(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	return child;
}

/** Record every process.kill call (pass-through to the real one) across an async window. */
function installKillSpy(): { calls: Array<{ pid: number; signal: unknown }>; restore: () => void } {
	const original = process.kill;
	const calls: Array<{ pid: number; signal: unknown }> = [];
	process.kill = ((pid: number, signal?: string | number) => {
		calls.push({ pid, signal });
		return original.call(process, pid, signal as NodeJS.Signals);
	}) as typeof process.kill;
	return {
		calls,
		restore: () => {
			process.kill = original;
		},
	};
}

/** Capture console.error lines (logInternalError emits warn/error there). */
function captureConsoleError(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
	return {
		lines,
		restore: () => {
			console.error = original;
		},
	};
}

const identity = (pid: number, starttime: string): ProcIdentity => ({ pid, pgid: pid, starttime, uid: selfUid() });

/** Wait past the hard-kill timer so its callback has definitely run. */
const waitForTimer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, HARD_KILL_MS + 500));

/** Best-effort fixture teardown: guarantee the detached child cannot leak. */
async function cleanupFixture(child: ChildProcess, pid: number): Promise<void> {
	clearHardKillTimer(pid);
	child.once("error", () => {
		/* already-exited children can still emit spawn-context errors late */
	});
	try {
		process.kill(-pid, 0);
		process.kill(-pid, "SIGKILL");
	} catch {
		/* group already gone — nothing to clean */
	}
	await new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		child.once("exit", () => resolve());
		const giveUp = setTimeout(() => resolve(), 1000);
		giveUp.unref();
	});
}

test("(r1) starttime mismatch in the hard-kill timer ⇒ no SIGKILL, warn logged, entry SIGTERM unchanged", {
	skip: process.platform === "win32",
}, async () => {
	const child = spawnGroupLeaderChild();
	const pid = child.pid;
	assert.ok(pid && pid > 1, "fixture child must have a pid");
	let reads = 0;
	__test.setReadProcIdentity(() => {
		reads++;
		// Entry read (baseline) = "111"; timer re-read = "222" — a recycled pid.
		return identity(pid, reads <= 1 ? "111" : "222");
	});
	const spy = installKillSpy();
	const consoleCap = captureConsoleError();
	try {
		killProcessPid(pid);
		await waitForTimer();
		const sigkills = spy.calls.filter((call) => call.signal === "SIGKILL");
		assert.deepEqual(sigkills, [], "a recycled pid must NOT receive SIGKILL (group or absolute)");
		const sigterms = spy.calls.filter((call) => call.signal === "SIGTERM");
		assert.ok(sigterms.length >= 1, "the entry SIGTERM is deliberately NOT gated by E1");
		assert.ok(
			consoleCap.lines.some((line) => line.includes("child-pi.sigkill-pid-recycled")),
			`expected a pid-recycle warning, got: ${JSON.stringify(consoleCap.lines)}`,
		);
		assert.ok(reads >= 2, "the timer must have re-read the identity");
	} finally {
		spy.restore();
		consoleCap.restore();
		__test.setReadProcIdentity(undefined);
		await cleanupFixture(child, pid);
	}
});

test("(r2) starttime unchanged ⇒ SIGKILL still attempted (pre-wave behavior)", { skip: process.platform === "win32" }, async () => {
	const child = spawnGroupLeaderChild();
	const pid = child.pid;
	assert.ok(pid && pid > 1);
	__test.setReadProcIdentity(() => identity(pid, "111"));
	const spy = installKillSpy();
	try {
		killProcessPid(pid);
		await waitForTimer();
		const sigkills = spy.calls.filter((call) => call.signal === "SIGKILL");
		assert.ok(sigkills.length >= 1, "an unchanged starttime must NOT suppress the hard kill");
	} finally {
		spy.restore();
		__test.setReadProcIdentity(undefined);
		await cleanupFixture(child, pid);
	}
});

test("(r3) no baseline readable (Windows//proc-less POSIX shape) ⇒ timer behavior unchanged", {
	skip: process.platform === "win32",
}, async () => {
	const child = spawnGroupLeaderChild();
	const pid = child.pid;
	assert.ok(pid && pid > 1);
	__test.setReadProcIdentity(() => undefined);
	const spy = installKillSpy();
	try {
		killProcessPid(pid);
		await waitForTimer();
		const sigkills = spy.calls.filter((call) => call.signal === "SIGKILL");
		assert.ok(sigkills.length >= 1, "without a baseline there is nothing to compare — the hard kill must proceed");
	} finally {
		spy.restore();
		__test.setReadProcIdentity(undefined);
		await cleanupFixture(child, pid);
	}
});
