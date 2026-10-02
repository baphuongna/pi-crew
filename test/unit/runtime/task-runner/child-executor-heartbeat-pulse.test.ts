import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { createRunManifest, loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/**
 * NEW-4 / G25 (SDD-4 WI-4): child-executor only persisted worker heartbeats
 * on stdout events (onStdoutLine/onJsonEvent). A turn that stays silent for
 * longer than the stale windows (observed live: 12m27s — heartbeat gradient
 * deadMs=300s, reconciler NO_PID_HEARTBEAT_STALE_MS=300s) froze
 * heartbeat.lastSeenAt while the worker process was alive and mid-turn, so
 * the reconciler/watchers repaired (killed) a healthy worker.
 *
 * Fix under test: a liveness pulse inside runChildProcessTask that touches
 * the heartbeat on an interval while the attempt's worker process is alive —
 * independent of stdout events. Red-first: [pulse-1] fails on the pre-fix
 * source with a clean assertion (heartbeat frozen at dispatch time during a
 * 4s silent window), [pulse-4]'s structural pins fail on the pre-fix source
 * because the wiring does not exist.
 */

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as const;
const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as const;
const agent = {
	name: "a",
	description: "",
	source: "test",
	filePath: "a",
	systemPrompt: "test",
} as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("[pulse-1] alive-but-silent worker keeps heartbeat fresh during the silent window (no stdout events)", async () => {
	let cwd = createTrackedTempDir("pi-crew-heartbeat-pulse-");
	// Canonicalize to long-name form matching production code
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	const saved: Record<string, string | undefined> = {
		PI_CREW_ALLOW_MOCK: process.env.PI_CREW_ALLOW_MOCK,
		PI_TEAMS_MOCK_CHILD_PI: process.env.PI_TEAMS_MOCK_CHILD_PI,
		PI_TEAMS_MOCK_STEER_WINDOW_MS: process.env.PI_TEAMS_MOCK_STEER_WINDOW_MS,
		PI_CREW_HEARTBEAT_PULSE_MS: process.env.PI_CREW_HEARTBEAT_PULSE_MS,
	};
	// json-slow-success sleeps SILENT_WINDOW_MS before emitting anything —
	// the worker is in flight (runWorker pending) but produces zero stdout
	// events during the window. Pulse cadence shrunk to 250ms via the test
	// seam so the window fits in a unit-test budget.
	const SILENT_WINDOW_MS = 5000;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-slow-success";
	process.env.PI_TEAMS_MOCK_STEER_WINDOW_MS = String(SILENT_WINDOW_MS);
	process.env.PI_CREW_HEARTBEAT_PULSE_MS = "250";
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({
			cwd,
			team: team as never,
			workflow: workflow as never,
			goal: "heartbeat-pulse",
		});
		const task = created.tasks[0]!;
		// Pre-seed a stale heartbeat (crash-resume shape): before dispatch,
		// the last time this worker was seen is far in the past.
		const staleHeartbeat = {
			workerId: task.id,
			lastSeenAt: "2026-01-01T00:00:00.000Z",
			alive: true,
		};
		const dispatchTs = Date.now();
		const running = runTeamTask({
			manifest: created.manifest,
			tasks: [{ ...task, heartbeat: staleHeartbeat }],
			task: { ...task, heartbeat: staleHeartbeat },
			step: workflow.steps[0] as never,
			agent: agent as never,
			executeWorkers: true,
			runtimeKind: "child-process",
			workspaceId: cwd,
		});
		// Poll through the silent window. By T+4500ms the mock has emitted
		// NOTHING (first stdout lands at T+5000ms), so any heartbeat advance
		// below must come from the liveness pulse, not from stdout events.
		// (persistHeartbeat's 1s throttle bounds disk writes, so disk freshness
		// trails the pulse cadence by up to ~1s — the ≥dispatchTs+1000 bar
		// leaves >2s of margin against timer jitter under test concurrency.)
		let observed: { lastSeenAt?: string } | undefined;
		for (let elapsed = 0; elapsed < 4500; elapsed += 100) {
			await sleep(100);
			const loaded = loadRunManifestById(cwd, created.manifest.runId);
			observed = { lastSeenAt: loaded?.tasks[0]?.heartbeat?.lastSeenAt };
		}
		const lastSeenMs = observed?.lastSeenAt ? new Date(observed.lastSeenAt).getTime() : Number.NaN;
		// No stdout yet: the attempt transcript must not exist (or be empty)
		// at observation time — proves the freshness did not come from events.
		const transcriptPath = path.join(created.manifest.artifactsRoot, "transcripts", `${task.id}.attempt-0.jsonl`);
		let transcriptBytes = 0;
		try {
			transcriptBytes = fs.statSync(transcriptPath).size;
		} catch {
			/* not created yet — expected during the silent window */
		}
		assert.ok(transcriptBytes === 0, `no stdout expected during silent window, transcript=${transcriptBytes}B`);
		// RED on pre-fix code: lastSeenAt stays frozen at dispatch time
		// (well under dispatchTs+1000). GREEN with the pulse: touched every
		// 250ms while the attempt is in flight, so ≥ dispatchTs+1000.
		assert.ok(
			Number.isFinite(lastSeenMs) && lastSeenMs >= dispatchTs + 1000,
			`heartbeat must advance during the silent window: lastSeenAt=${observed?.lastSeenAt} (dispatchTs=${dispatchTs})`,
		);
		await running;
		// Post-completion sanity: the run completed and the final heartbeat
		// is fresh (stdout path still works — the pulse does not replace it).
		const final = loadRunManifestById(cwd, created.manifest.runId);
		const finalTask = final?.tasks[0];
		assert.equal(finalTask?.status, "completed");
		assert.ok(finalTask?.heartbeat?.lastSeenAt);
		assert.ok(new Date(finalTask.heartbeat.lastSeenAt).getTime() >= dispatchTs);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[pulse-2] pulse touches only while the recorded pid is alive (real process, no stdout)", async () => {
	const { startWorkerHeartbeatPulse } = await import("../../../../src/runtime/task-runner/child-executor.ts");
	const { checkProcessLiveness } = await import("../../../../src/runtime/process-status.ts");
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
	assert.ok(child.pid, "spawned helper must have a pid");
	try {
		let touches = 0;
		const pulse = startWorkerHeartbeatPulse({
			intervalMs: 80,
			isAlive: () => checkProcessLiveness(child.pid).alive,
			touch: () => {
				touches += 1;
			},
		});
		try {
			// Alive and completely silent (stdio ignore → no stdout at all):
			// the pulse must keep touching.
			await sleep(400);
			assert.ok(touches >= 2, `expected ≥2 touches while alive+silent, got ${touches}`);
			// Kill the process → pid dead → pulse must STOP touching.
			child.kill("SIGKILL");
			await sleep(300);
			const afterDeath = touches;
			await sleep(300);
			assert.equal(touches, afterDeath, `pulse must not touch a dead pid (before=${afterDeath}, after=${touches})`);
		} finally {
			pulse.stop();
		}
		// stop() clears the timer: no further touches even though a new live
		// pid could appear (isAlive returns true below — proving the timer,
		// not the predicate, is what stopped).
		let aliveTouches = 0;
		const stopped = startWorkerHeartbeatPulse({
			intervalMs: 60,
			isAlive: () => true,
			touch: () => {
				aliveTouches += 1;
			},
		});
		stopped.stop();
		await sleep(250);
		assert.equal(aliveTouches, 0, "stop() must clear the interval");
	} finally {
		if (child.pid) {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}
	}
});

test("[pulse-3] pulse is disable-safe and survives a throwing touch", async () => {
	const { startWorkerHeartbeatPulse } = await import("../../../../src/runtime/task-runner/child-executor.ts");
	// intervalMs ≤ 0 → disabled, never touches, stop() is a no-op.
	let touches = 0;
	const disabled = startWorkerHeartbeatPulse({
		intervalMs: 0,
		isAlive: () => true,
		touch: () => {
			touches += 1;
		},
	});
	disabled.stop();
	await sleep(200);
	assert.equal(touches, 0, "disabled pulse must never touch");

	// A throwing touch (e.g. persist failure) must not kill the host timer —
	// the pulse keeps ticking and the next touch still runs.
	let calls = 0;
	const surviving = startWorkerHeartbeatPulse({
		intervalMs: 60,
		isAlive: () => true,
		touch: () => {
			calls += 1;
			if (calls === 1) throw new Error("persist blew up");
		},
	});
	try {
		await sleep(300);
		assert.ok(calls >= 2, `pulse must survive a throwing touch, calls=${calls}`);
	} finally {
		surviving.stop();
	}
});

test("[pulse-4] structural (source-contract): runChildProcessTask wires the pulse with finally cleanup", () => {
	// WHY STRUCTURAL: mirrors [char-core5-11] — the PI_TEAMS_MOCK mock has no
	// real spawn (onSpawn never fires), so the pid-corroborated wiring of the
	// pulse around the REAL runWorker call cannot be driven at unit level.
	// Lock the contract that (1) the pulse starts around the runWorker await,
	// (2) onSpawn feeds the attempt pid into the liveness predicate,
	// (3) the finally block that clears the wall-clock timeout also stops the
	// pulse — same cleanup block as the R3 listener-leak contract.
	const src = readFileSync("src/runtime/task-runner/child-executor.ts", "utf-8");
	assert.match(src, /startWorkerHeartbeatPulse\(\{/, "pulse must be started around runWorker");
	const pulseStartIdx = src.indexOf("startWorkerHeartbeatPulse({");
	const runWorkerIdx = src.indexOf("childResult = await runWorker({");
	assert.ok(pulseStartIdx > 0 && runWorkerIdx > pulseStartIdx, "pulse must start before the runWorker await");
	assert.match(src, /attemptWorkerPid\s*=\s*pid/, "onSpawn must feed the attempt pid to the pulse predicate");
	const stopIdx = src.indexOf("heartbeatPulse.stop()");
	const clearTimeoutIdx = src.indexOf("if (timeoutHandle) clearTimeout(timeoutHandle)");
	assert.ok(stopIdx > 0 && clearTimeoutIdx > 0 && stopIdx > runWorkerIdx, "pulse.stop() must come after the runWorker await");
	// Same finally block: stop() sits within a few lines after the timeout
	// clear (both are per-attempt cleanup in the finally).
	assert.ok(Math.abs(stopIdx - clearTimeoutIdx) < 400, "pulse.stop() must live in the same finally block as clearTimeout");
});
