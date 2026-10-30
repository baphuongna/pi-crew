/**
 * FIX-1 (live catch, run team_20261030044630_3935473bc4886682): unit tests for
 * the extracted run interrupt guard (startRunInterruptGuard in
 * src/runtime/foreground-control.ts — colocated with the request producer).
 *
 * Root cause being pinned: the guard used to live ONLY inside background-
 * runner's detached main(), so INLINE runs (the owner session executing
 * executeBackgroundRun in-process) never consumed foreground-control.json
 * interrupt requests — two requests in that run sat acknowledged:false while
 * the worker ran ≥75s post-cancel.
 *
 * These tests exercise the REAL guard (no harness re-implementation — the
 * false-confirmation lesson from interrupt-guard-ack.test.ts's header):
 *   1. inline-mode wiring (what executeBackgroundRun mounts): ack + event +
 *      onInterrupt exactly once, and NO process.exitCode mutation.
 *   2. stop() clears the interval: a post-stop request is never consumed.
 *   3. SCOPED-KILL pin: a registered sibling child survives an inline-mode
 *      interrupt (inline mode must NEVER terminateActiveChildPiProcesses —
 *      it would murder sibling runs' children in the same host process).
 *   4. detached wrapper regression: startInterruptGuard (background-runner)
 *      STILL sweeps every registered child and sets exitCode 130 after the
 *      extraction — byte-identical detached behavior.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
// Static import is fine in-process: background-runner is entry-guarded
// (shouldRunMainAsEntry) — importing it must NOT run a team.
import { startInterruptGuard } from "../../../src/runtime/background-runner.ts";
import { registerActiveChild, unregisterActiveChild } from "../../../src/runtime/child-pi/child-pi-kill.ts";
import { startRunInterruptGuard } from "../../../src/runtime/foreground-control.ts";
import { flushEventLogBuffer } from "../../../src/state/event-log/event-log.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) saved[key] = process.env[key];
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

interface Fixture {
	stateRoot: string;
	eventsPath: string;
	controlPath: string;
	cleanup: () => Promise<void>;
}

async function makeFixture(prefix: string): Promise<Fixture> {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const eventsPath = path.join(stateRoot, "events.jsonl");
	fs.writeFileSync(eventsPath, "", "utf-8");
	return {
		stateRoot,
		eventsPath,
		controlPath: path.join(stateRoot, "foreground-control.json"),
		cleanup: async () => {
			await removeDirWithRetry(stateRoot);
		},
	};
}

function writeRequest(controlPath: string, id: string): void {
	fs.writeFileSync(
		controlPath,
		JSON.stringify(
			{ requests: [{ type: "interrupt", acknowledged: false, id, createdAt: new Date().toISOString(), reason: "test" }] },
			null,
			2,
		),
		"utf-8",
	);
}

function readAck(controlPath: string): boolean | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as { requests?: Array<{ acknowledged?: boolean }> };
		return parsed.requests?.at(-1)?.acknowledged;
	} catch {
		return undefined;
	}
}

async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

function readEvents(eventsPath: string): Array<Record<string, unknown>> {
	try {
		return fs
			.readFileSync(eventsPath, "utf-8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

test("inline-mode guard: acks the request, appends async.interrupt_detected, fires onInterrupt once, never sets exitCode", async () => {
	const fixture = await makeFixture("pi-crew-ig-inline-");
	try {
		let interrupts = 0;
		let stopGuard: (() => void) | undefined;
		// 25ms interval for a fast, deterministic test; the exitCode snapshot
		// pins that the INLINE wiring never takes process-wide actions.
		const exitCodeBefore = process.exitCode;
		withEnv({ PI_CREW_INTERRUPT_GUARD_INTERVAL_MS: "25" }, () => {
			stopGuard = startRunInterruptGuard({
				manifest: { runId: "ig-inline", stateRoot: fixture.stateRoot, eventsPath: fixture.eventsPath },
				// Exactly what executeBackgroundRun passes in inline mode.
				eventMessage: "Inline background run detected foreground interrupt — aborting run ig-inline.",
				onInterrupt: () => {
					interrupts += 1;
				},
			});
		});
		assert.ok(stopGuard, "guard must be mounted");
		try {
			writeRequest(fixture.controlPath, "ig-1");
			assert.ok(
				await waitFor(() => readAck(fixture.controlPath) === true, 2000),
				`request must be acknowledged (got ${readAck(fixture.controlPath)})`,
			);
			await flushEventLogBuffer();
			const events = readEvents(fixture.eventsPath);
			assert.ok(
				events.some((e) => e.type === "async.interrupt_detected" && e.runId === "ig-inline"),
				`async.interrupt_detected must be appended (events=${JSON.stringify(events.map((e) => e.type))})`,
			);
			assert.equal(interrupts, 1, "onInterrupt must fire exactly once");
			// Give the once-gate several more ticks to (wrongly) re-fire.
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(interrupts, 1, "once-per-request gate must hold across ticks");
			assert.equal(process.exitCode, exitCodeBefore, "inline mode must NOT set process.exitCode");
		} finally {
			stopGuard?.();
		}
	} finally {
		await fixture.cleanup();
	}
});

test("stop() clears the interval: a request written AFTER stop is never consumed (no leaked interval)", async () => {
	const fixture = await makeFixture("pi-crew-ig-stop-");
	let interrupts = 0;
	let stopGuard: (() => void) | undefined;
	withEnv({ PI_CREW_INTERRUPT_GUARD_INTERVAL_MS: "25" }, () => {
		stopGuard = startRunInterruptGuard({
			manifest: { runId: "ig-stop", stateRoot: fixture.stateRoot, eventsPath: fixture.eventsPath },
			onInterrupt: () => {
				interrupts += 1;
			},
		});
	});
	assert.ok(stopGuard);
	writeRequest(fixture.controlPath, "ig-2");
	assert.ok(await waitFor(() => readAck(fixture.controlPath) === true, 2000), "first request must be consumed while the guard is live");
	stopGuard();
	// Post-stop request: the interval is cleared, so this must stay
	// unacknowledged forever (well, for 500ms ≈ 20 missed ticks).
	writeRequest(fixture.controlPath, "ig-3");
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.notEqual(readAck(fixture.controlPath), true, "post-stop request must NOT be acknowledged — interval must be cleared");
	assert.equal(interrupts, 1, "post-stop request must not fire onInterrupt");
	await fixture.cleanup();
});

function spawnSleeper(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	assert.ok(child.pid, "sleeper must have a pid");
	return child;
}

function isAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("SCOPED-KILL pin: inline-mode interrupt does NOT kill a registered sibling child (no global sweep)", async () => {
	const fixture = await makeFixture("pi-crew-ig-scoped-");
	const sibling = spawnSleeper();
	let stopGuard: (() => void) | undefined;
	try {
		// A child belonging to ANOTHER run in the same process — exactly what
		// terminateActiveChildPiProcesses() would murder.
		registerActiveChild(sibling.pid!, sibling);
		const controller = new AbortController();
		withEnv({ PI_CREW_INTERRUPT_GUARD_INTERVAL_MS: "25" }, () => {
			stopGuard = startRunInterruptGuard({
				manifest: { runId: "ig-run-a", stateRoot: fixture.stateRoot, eventsPath: fixture.eventsPath },
				// Exactly the inline wiring executeBackgroundRun mounts: abort
				// ONLY this run's controller.
				onInterrupt: () => {
					controller.abort();
				},
			});
		});
		assert.ok(stopGuard);
		writeRequest(fixture.controlPath, "ig-4");
		assert.ok(await waitFor(() => controller.signal.aborted, 2000), "run A's controller must be aborted by the interrupt");
		// The sibling child must STILL be alive — inline mode never sweeps.
		assert.ok(isAlive(sibling.pid), "sibling child must survive an INLINE interrupt (scoped kill, not global sweep)");
	} finally {
		stopGuard?.();
		unregisterActiveChild(sibling.pid!);
		try {
			sibling.kill("SIGKILL");
		} catch {
			/* best-effort */
		}
		await fixture.cleanup();
	}
});

test("detached wrapper regression: startInterruptGuard (background-runner) still sweeps registered children and sets exitCode=130", async () => {
	const fixture = await makeFixture("pi-crew-ig-detached-");
	const victim = spawnSleeper();
	let stopGuard: (() => void) | undefined;
	const exitCodeBefore = process.exitCode;
	try {
		registerActiveChild(victim.pid!, victim);
		const controller = new AbortController();
		withEnv({ PI_CREW_INTERRUPT_GUARD_INTERVAL_MS: "25" }, () => {
			stopGuard = startInterruptGuard(
				{ runId: "ig-detached", stateRoot: fixture.stateRoot, eventsPath: fixture.eventsPath },
				controller,
				() => {
					/* stopParentGuard stub */
				},
			);
		});
		assert.ok(stopGuard);
		writeRequest(fixture.controlPath, "ig-5");
		assert.ok(await waitFor(() => controller.signal.aborted, 2000), "detached guard must abort the runner controller");
		assert.equal(process.exitCode, 130, "detached guard must keep setting exitCode=130 (byte-identical behavior)");
		assert.ok(
			await waitFor(() => !isAlive(victim.pid), 4000),
			"detached guard must STILL terminate all registered children (extraction regression pin)",
		);
		await flushEventLogBuffer();
		const events = readEvents(fixture.eventsPath);
		assert.ok(
			events.some(
				(e) =>
					e.type === "async.interrupt_detected" &&
					typeof e.message === "string" &&
					e.message.includes("killing child processes and exiting"),
			),
			"detached event message must be preserved verbatim",
		);
	} finally {
		stopGuard?.();
		unregisterActiveChild(victim.pid!);
		try {
			victim.kill("SIGKILL");
		} catch {
			/* best-effort */
		}
		// The detached guard legitimately set exitCode=130 — restore the test
		// process's exit code so the FILE doesn't exit 130.
		process.exitCode = exitCodeBefore;
		await fixture.cleanup();
	}
});

test("acked-interrupt silence: an already-acknowledged interrupt never triggers the unknown-request warn", async () => {
	const fixture = await makeFixture("pi-crew-ig-ackwarn-");
	try {
		let stopGuard: (() => void) | undefined;
		const warns: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warns.push(args.map(String).join(" "));
		};
		try {
			withEnv({ PI_CREW_INTERRUPT_GUARD_INTERVAL_MS: "25" }, () => {
				stopGuard = startRunInterruptGuard({
					manifest: { runId: "ig-ackwarn", stateRoot: fixture.stateRoot, eventsPath: fixture.eventsPath },
					onInterrupt: () => {},
				});
			});
			assert.ok(stopGuard, "guard must be mounted");
			// Pre-acked request: the guard must consume it silently (no warn) —
			// pre-fix this warned "Ignoring unknown foreground control request:
			// interrupt" on every tick after an ack (verifier-flagged cosmetic).
			fs.writeFileSync(
				fixture.controlPath,
				JSON.stringify(
					{ requests: [{ type: "interrupt", acknowledged: true, id: "ig-pre", createdAt: new Date().toISOString(), reason: "test" }] },
					null,
					2,
				),
				"utf-8",
			);
			// Plenty of ticks to (wrongly) warn.
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(warns.length, 0, `acked interrupt must not warn (warns=${JSON.stringify(warns)})`);
			// A genuinely unknown type still warns (regression pin for the branch).
			fs.writeFileSync(
				fixture.controlPath,
				JSON.stringify({ requests: [{ type: "nonsense", acknowledged: false }] }, null, 2),
				"utf-8",
			);
			assert.ok(await waitFor(() => warns.length > 0, 2000), "unknown request type must still warn");
		} finally {
			console.warn = originalWarn;
			stopGuard?.();
		}
	} finally {
		await fixture.cleanup();
	}
});
