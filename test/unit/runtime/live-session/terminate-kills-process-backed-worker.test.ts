/**
 * WI-5 (SDD-4) — terminateLiveAgentsForRun vs process-backed (child-pi-style) workers.
 *
 * Plan UNCERTAIN (pi-crew-upgrade-plan-2026-09-29 §1 W-D): "terminateLiveAgentsForRun
 * có kill được child-pi worker không". Architecture answer (verified by reading src):
 * real child-pi workers never call registerLiveAgent() — they are killed via
 * killProcessPid() (SIGTERM→SIGKILL on the process group) from the background-runner
 * SIGTERM cascade (terminateActiveChildPiProcesses), cancel/lifecycle
 * killProcessPid(asyncPid), and the stale reconciler (heartbeat/checkpoint pid).
 * What terminateLiveAgentsForRun CAN terminate is a registered live agent whose
 * session wraps a worker process and exposes `pid` — the same property
 * evictStaleLiveAgentHandles already reads for liveness probes.
 *
 * These tests prove the terminate path actually signals that process at the right
 * pid for the right run. Red-first: before the fix, abort()+dispose() alone left
 * the worker process alive; terminateLiveAgent now falls back to killProcessPid.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import test, { describe, it } from "node:test";
import {
	clearLiveAgentsForTest,
	getLiveAgent,
	listLiveAgents,
	registerLiveAgent,
	terminateLiveAgentsForRun,
} from "../../../../src/runtime/live-session/live-agent-manager.ts";
import { sleepSync } from "../../../../src/utils/sleep.ts";

type SessionParam = Parameters<typeof registerLiveAgent>[0]["session"];

/** Upper bound for waiting on a worker's exit after SIGTERM (SIGKILL escalates at 3s). */
const EXIT_WAIT_MS = 8_000;

/** Spawn a keepalive "worker" in its own process group (mirrors child-pi setsid spawn). */
function spawnWorker(): { child: ChildProcess; pid: number; exited: Promise<string | null> } {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000);"], {
		stdio: "ignore",
		detached: true,
	});
	assert.ok(child.pid !== undefined && child.pid > 0, "worker spawned with a pid");
	const pid = child.pid;
	const exited = new Promise<string | null>((resolve) => {
		child.once("exit", (_code, signal) => resolve(signal ?? null));
	});
	// Wait until the process is observable (kill(pid, 0) succeeds).
	const deadline = Date.now() + 2_000;
	for (;;) {
		try {
			process.kill(pid, 0);
			break;
		} catch (error) {
			if (Date.now() > deadline) throw error;
			sleepSync(5);
		}
	}
	return { child, pid, exited };
}

/** Hard cleanup so a failing assertion cannot leak worker processes. */
function killHard(child: ChildProcess): void {
	try {
		if (child.pid) process.kill(-child.pid, "SIGKILL");
	} catch {
		/* process group already gone */
	}
	try {
		child.kill("SIGKILL");
	} catch {
		/* process already dead */
	}
}

async function waitForExit(exited: Promise<string | null>, what: string): Promise<string | null> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			exited,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} did not exit within ${EXIT_WAIT_MS}ms`)), EXIT_WAIT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Session wrapper around a REAL worker process. abort() models a wrapper that
 * cancels only the in-flight request (SDK-like semantics) — the backing process
 * keeps running until terminate's last-resort kill signals it.
 */
function workerSession(pid: number): SessionParam {
	return {
		steer: async () => undefined,
		prompt: async () => undefined,
		abort: async () => undefined,
		dispose: () => undefined,
		pid,
	} as unknown as SessionParam;
}

test.afterEach(() => clearLiveAgentsForTest());

describe("terminateLiveAgentsForRun — process-backed (child-pi-style) workers", () => {
	it("kills the backing worker process of the terminated run (signal reaches the worker pid)", async () => {
		const { child, pid, exited } = spawnWorker();
		try {
			const handle = registerLiveAgent({
				agentId: "proc-agent",
				taskId: "t-proc",
				runId: "run-proc",
				workspaceId: "ws",
				session: workerSession(pid),
				status: "running",
			});
			const count = await terminateLiveAgentsForRun("run-proc", "failed");
			assert.equal(count, 1);
			assert.equal(handle.status, "failed");
			assert.equal(getLiveAgent("proc-agent"), undefined, "handle removed from the registry");
			const signal = await waitForExit(exited, "worker of run-proc");
			// win32 has no POSIX signals: process.kill(pid, SIGTERM) terminates the
			// process but Node reports a natural exit code with signal=null. The
			// worker parks until killed, so ANY exit here means the terminate path
			// reached the backing pid (CI 2026-10-03, unit 2/4 · windows).
			const allowed = process.platform === "win32" ? [null, "SIGTERM", "SIGKILL"] : ["SIGTERM", "SIGKILL"];
			assert.ok((allowed as (string | null)[]).includes(signal), `worker was signalled (got ${signal ?? "natural exit code"})`);
		} finally {
			killHard(child);
		}
	});

	it("only kills workers of the target run — other runs' workers stay alive and registered", async () => {
		const w1 = spawnWorker();
		const w2 = spawnWorker();
		try {
			registerLiveAgent({
				agentId: "a-x",
				taskId: "t-x",
				runId: "run-x",
				workspaceId: "ws",
				session: workerSession(w1.pid),
				status: "running",
			});
			const kept = registerLiveAgent({
				agentId: "a-y",
				taskId: "t-y",
				runId: "run-y",
				workspaceId: "ws",
				session: workerSession(w2.pid),
				status: "running",
			});
			const count = await terminateLiveAgentsForRun("run-x", "failed");
			assert.equal(count, 1);
			await waitForExit(w1.exited, "worker of run-x");
			// run-y worker untouched: still running (kill(pid,0) succeeds) and still registered.
			assert.doesNotThrow(() => process.kill(w2.pid, 0), "run-y worker is still alive");
			assert.equal(w2.child.exitCode, null, "run-y worker has not exited");
			assert.equal(getLiveAgent("a-y"), kept, "run-y handle stays registered");
			assert.ok(listLiveAgents().some((a) => a.agentId === "a-y"));
		} finally {
			killHard(w1.child);
			killHard(w2.child);
		}
	});

	it("pin: in-process sessions (no pid) terminate via abort+dispose without any process kill", async () => {
		let aborted = 0;
		let disposed = 0;
		const session = {
			steer: async () => undefined,
			prompt: async () => undefined,
			abort: async () => {
				aborted++;
			},
			dispose: () => {
				disposed++;
			},
		};
		registerLiveAgent({
			agentId: "sdk-agent",
			taskId: "t-sdk",
			runId: "run-sdk",
			workspaceId: "ws",
			session,
			status: "running",
		});
		const count = await terminateLiveAgentsForRun("run-sdk", "completed");
		assert.equal(count, 1);
		assert.equal(aborted, 1, "abort() called once");
		assert.equal(disposed, 1, "dispose() called once");
		assert.equal(getLiveAgent("sdk-agent"), undefined);
	});

	it("guard: a session exposing the host pid (pid === process.pid) is never signalled", async () => {
		// If this guard regresses, killProcessPid(process.pid) SIGTERMs this test
		// runner's own process group and the suite dies loudly at this test.
		registerLiveAgent({
			agentId: "self-agent",
			taskId: "t-self",
			runId: "run-self",
			workspaceId: "ws",
			session: workerSession(process.pid),
			status: "running",
		});
		const count = await terminateLiveAgentsForRun("run-self", "failed");
		assert.equal(count, 1);
		assert.equal(getLiveAgent("self-agent"), undefined);
		// Reaching this line means the runner survived the terminate call.
	});
});
