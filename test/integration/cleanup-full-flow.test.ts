/**
 * Integration tests for the full cleanup flow.
 *
 * Simulates a crashed session by setting up orphan temp dirs and orphan
 * worker entries, then runs the complete cleanup sequence to verify all
 * layers work together correctly.
 *
 * This tests the integration between:
 *   - cleanupOrphanTempDirs (Layer 4)
 *   - cleanupLegacyOrphanTempDirs (Layer 5)
 *   - cleanupOrphanWorkers (orphan worker registry)
 *   - createdTempDirs tracking
 *
 * Note: True end-to-end tests (spawn + SIGKILL parent + verify cleanup
 * in new session) require multi-process coordination and are handled
 * separately in the e2e test suite.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test_setRegistryPath, cleanupOrphanWorkers, registerWorker } from "../../src/runtime/orphan-worker-registry.ts";
import {
	__test_getTrackedTempDirs,
	__test_resetTrackedTempDirs,
	cleanupLegacyOrphanTempDirs,
	cleanupOrphanTempDirs,
	createSafeTempDir,
} from "../../src/runtime/pi-args.ts";

function mkdtemp(prefix: string): string {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		dir = fs.realpathSync(dir);
	} catch {
		/* keep */
	}
	return dir;
}

function rmrf(p: string): void {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

// Track spawned child processes for cleanup
const spawnedPids: number[] = [];
test.after(() => {
	for (const pid of spawnedPids) {
		try {
			process.kill(pid, 9);
		} catch {
			/* already dead */
		}
	}
});

function touchDir(dir: string, ageMs: number): void {
	fs.mkdirSync(dir, { recursive: true });
	const past = new Date(Date.now() - ageMs);
	fs.utimesSync(dir, past, past);
}

let REGISTRY_FILE = "";

test.beforeEach(() => {
	const tmp = mkdtemp("pi-crew-test-ifull-");
	REGISTRY_FILE = path.join(tmp, "orphan-workers.json");
	__test_setRegistryPath(REGISTRY_FILE);
	__test_resetTrackedTempDirs();
});

test.afterEach(() => {
	rmrf(path.dirname(REGISTRY_FILE));
});

/**
 * Run the full cleanup sequence against custom temp directories.
 */
function runFullCleanup(
	userTmpDir: string,
	legacyTmpDir: string,
	currentSessionId: string,
): {
	tempResult: { scanned: number; cleaned: number; failed: number };
	legacyResult: { scanned: number; cleaned: number; failed: number };
	workerResult: {
		scanned: number;
		killed: number;
		pruned: number;
		kept: number;
	};
} {
	const now = Date.now();
	const tempResult = cleanupOrphanTempDirs(now, userTmpDir);
	const legacyResult = cleanupLegacyOrphanTempDirs(now, legacyTmpDir);
	const workerResult = cleanupOrphanWorkers(currentSessionId);
	return { tempResult, legacyResult, workerResult };
}

test("full cleanup flow: orphan temp dirs + legacy /tmp + orphan workers", () => {
	const userTmp = mkdtemp("pi-crew-test-user-");
	const legacyTmp = mkdtemp("pi-crew-test-legacy-");

	// Setup: Layer 4 orphan temp dir (old, should be cleaned)
	const layer4Old = path.join(userTmp, "pi-crew-layer4-old");
	touchDir(layer4Old, 25 * 60 * 60 * 1000);

	// Setup: Layer 4 orphan temp dir (fresh, should be kept)
	const layer4Fresh = path.join(userTmp, "pi-crew-layer4-fresh");
	touchDir(layer4Fresh, 1 * 60 * 60 * 1000);

	// Setup: a tracked dir that should be preserved even if old
	const tracked = createSafeTempDir(userTmp, "pi-crew-tracked-");
	touchDir(tracked, 25 * 60 * 60 * 1000);

	// Setup: legacy /tmp orphan (old, no .crew/, should be cleaned)
	const legacyOld = path.join(legacyTmp, "pi-crew-legacy-old");
	touchDir(legacyOld, 25 * 60 * 60 * 1000);

	// Setup: legacy /tmp orphan with .crew/ (should be kept by Layer 3 semantics)
	const legacyWithCrew = path.join(legacyTmp, "pi-crew-legacy-crew");
	touchDir(legacyWithCrew, 25 * 60 * 60 * 1000);
	fs.mkdirSync(path.join(legacyWithCrew, ".crew"), { recursive: true });

	// Setup: orphan worker (stale, dead parent, should be killed)
	const fakeWorkerDir = mkdtemp("pi-crew-worker-");
	const fakeWorkerScript = path.join(fakeWorkerDir, "background-runner.ts");
	fs.writeFileSync(fakeWorkerScript, "setInterval(() => {}, 1000);");

	const worker = spawn(process.execPath, [fakeWorkerScript], {
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	});
	const workerPid = worker.pid!;
	spawnedPids.push(workerPid);

	// Register with dead parent (registered 2 hours ago so it's stale)
	registerWorker(workerPid, "session-DEAD", "run-dead", 999999, {
		registeredAt: Date.now() - 2 * 60 * 60 * 1000,
	});

	// Run full cleanup with custom paths
	const result = runFullCleanup(userTmp, legacyTmp, "session-NEW");

	// Verify temp cleanup (Layer 4)
	// tracked dir is protected (in-use), so only layer4Old gets cleaned
	assert.equal(result.tempResult.scanned, 3, "Layer 4 scanned 3 dirs");
	assert.equal(result.tempResult.cleaned, 1, "Layer 4 cleaned old non-tracked dir");
	assert.equal(result.tempResult.failed, 0);
	assert.ok(!fs.existsSync(layer4Old), "old layer4 dir removed");
	assert.ok(fs.existsSync(layer4Fresh), "fresh layer4 dir kept");
	assert.ok(fs.existsSync(tracked), "tracked dir kept (in-use)");

	// Verify legacy cleanup (Layer 5)
	assert.equal(result.legacyResult.scanned, 2, "Layer 5 scanned 2 dirs");
	assert.equal(result.legacyResult.cleaned, 1, "Layer 5 cleaned legacy old");
	assert.ok(!fs.existsSync(legacyOld), "legacy old removed");
	assert.ok(fs.existsSync(legacyWithCrew), "legacy with .crew/ kept");

	// Verify worker cleanup
	assert.equal(result.workerResult.scanned, 1, "worker registry scanned 1");
	assert.equal(result.workerResult.killed, 1, "stale worker killed");

	// Cleanup worker process
	try {
		worker.kill();
	} catch {
		/* ignore */
	}
	rmrf(userTmp);
	rmrf(legacyTmp);
	rmrf(fakeWorkerDir);
});

test("full cleanup flow: concurrent session protection", () => {
	const fakeWorkerDir = mkdtemp("pi-crew-worker-conc-");
	const fakeWorkerScript = path.join(fakeWorkerDir, "background-runner.ts");
	fs.writeFileSync(fakeWorkerScript, "setInterval(() => {}, 1000);");

	const worker = spawn(process.execPath, [fakeWorkerScript], {
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	});
	const workerPid = worker.pid!;
	spawnedPids.push(workerPid);

	// Register with current process as parent (alive)
	registerWorker(workerPid, "session-CONCURRENT", "run-concurrent", process.pid);

	// Run cleanup with "same session" — should keep the worker
	const result = cleanupOrphanWorkers("session-CONCURRENT");

	assert.equal(result.scanned, 1, "scanned 1 worker");
	assert.equal(result.kept, 1, "concurrent session worker kept");
	assert.equal(result.killed, 0, "no workers killed");
	assert.equal(result.pruned, 0, "no workers pruned");

	// Cleanup
	try {
		worker.kill();
	} catch {
		/* ignore */
	}
	rmrf(fakeWorkerDir);
});

test("full cleanup flow: tracked temp dirs protected from Layer 4", () => {
	const tmp = mkdtemp("pi-crew-test-tracked-");

	// Create two dirs: one tracked (old), one not tracked (old)
	const tracked = createSafeTempDir(tmp, "pi-crew-tracked-");
	const untracked = path.join(tmp, "pi-crew-untracked-old");
	touchDir(untracked, 25 * 60 * 60 * 1000);

	const now = Date.now();
	const past = new Date(now - 25 * 60 * 60 * 1000);
	fs.utimesSync(tracked, past, past);

	// Verify tracked is in the set
	assert.ok(__test_getTrackedTempDirs().includes(tracked), "tracked dir in set");

	// Run Layer 4 cleanup - tracked should be protected, untracked should be cleaned
	const result = cleanupOrphanTempDirs(now, tmp);

	assert.equal(result.scanned, 2, "Layer 4 scanned 2 dirs");
	assert.equal(result.cleaned, 1, "Layer 4 cleaned untracked only");
	assert.ok(fs.existsSync(tracked), "tracked dir preserved");
	assert.ok(!fs.existsSync(untracked), "untracked dir removed");

	rmrf(tmp);
});

test("full cleanup flow: dead worker pruned, not killed", async () => {
	const fakeWorkerDir = mkdtemp("pi-crew-test-reuse-");
	const fakeWorkerScript = path.join(fakeWorkerDir, "background-runner.ts");
	fs.writeFileSync(fakeWorkerScript, "setInterval(() => {}, 1000);");

	// Spawn the fake worker
	const fakeWorker = spawn(process.execPath, [fakeWorkerScript], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const fakeWorkerPid = fakeWorker.pid!;
	spawnedPids.push(fakeWorkerPid);

	// Register the fake worker with a dead parent
	registerWorker(fakeWorkerPid, "session-DEAD", "run-dead", 999998);

	// Kill the fake worker process so it becomes a dead PID
	fakeWorker.kill();

	// Wait for the process to exit
	await new Promise<void>((resolve) => {
		fakeWorker.on("exit", () => resolve());
		setTimeout(resolve, 1000); // fallback timeout
	});

	// Run cleanup - the dead worker should be pruned, not killed
	const result = cleanupOrphanWorkers("session-NEW");

	// The fake worker should be pruned (dead PID removed from registry)
	assert.equal(result.scanned, 1, "scanned 1 worker");
	assert.equal(result.pruned, 1, "dead worker pruned");
	assert.equal(result.killed, 0, "no workers killed");

	rmrf(fakeWorkerDir);
});
