/**
 * Tests for orphan-worker-registry.ts.
 *
 * Covers:
 *   - registerWorker (writes to JSON, dedupes by PID)
 *   - unregisterWorker (removes entry)
 *   - cleanupOrphanWorkers (kills stale, keeps current session, prunes dead)
 *
 * Uses __test_setRegistryPath to redirect to a temp file so tests
 * don't touch the real user registry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupOrphanWorkers,
	registerWorker,
	unregisterWorker,
	__test_setRegistryPath,
} from "../../src/runtime/orphan-worker-registry.ts";

function mkdtemp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p: string): void {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function writeRawRegistry(entries: unknown[]): void {
	const p = path.join(REGISTRY_FILE, "..", "orphan-workers.json");
	fs.writeFileSync(p, JSON.stringify(entries));
}

let REGISTRY_FILE = "";

test.beforeEach(() => {
	const tmp = mkdtemp("pi-crew-test-oreg-");
	REGISTRY_FILE = path.join(tmp, "orphan-workers.json");
	__test_setRegistryPath(REGISTRY_FILE);
});

test.afterEach(() => {
	rmrf(path.dirname(REGISTRY_FILE));
});

// === registerWorker ===

test("registerWorker writes entry to JSON file", () => {
	registerWorker(12345, "session-A", "run-1", 99999);
	const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
	assert.equal(raw.length, 1);
	assert.equal(raw[0].pid, 12345);
	assert.equal(raw[0].sessionId, "session-A");
	assert.equal(raw[0].runId, "run-1");
	assert.equal(raw[0].parentPid, 99999);
	assert.ok(typeof raw[0].registeredAt === "number");
});

test("registerWorker is idempotent (dedupes by PID)", () => {
	registerWorker(100, "session-A", "run-1", 50);
	registerWorker(100, "session-B", "run-2", 60); // same PID, replaces

	const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
	assert.equal(raw.length, 1);
	assert.equal(raw[0].sessionId, "session-B", "replaced with newer entry");
	assert.equal(raw[0].parentPid, 60);
});

test("registerWorker rejects invalid PIDs", () => {
	registerWorker(0, "session", "run", 1);
	registerWorker(-1, "session", "run", 1);
	registerWorker(NaN, "session", "run", 1);
	assert.ok(!fs.existsSync(REGISTRY_FILE), "no file written for invalid PIDs");
});

test("registerWorker tolerates invalid parentPid (stores 0)", () => {
	registerWorker(100, "session", "run", NaN);
	const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
	assert.equal(raw[0].parentPid, 0);
});

// === unregisterWorker ===

test("unregisterWorker removes the entry", () => {
	registerWorker(100, "session-A", "run-1", 50);
	registerWorker(200, "session-A", "run-2", 50);
	unregisterWorker(100);

	const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
	assert.equal(raw.length, 1);
	assert.equal(raw[0].pid, 200);
});

test("unregisterWorker is a no-op for unknown PID", () => {
	registerWorker(100, "session-A", "run-1", 50);
	unregisterWorker(999);
	const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
	assert.equal(raw.length, 1);
});

test("unregisterWorker rejects invalid PIDs", () => {
	registerWorker(100, "session-A", "run-1", 50);
	unregisterWorker(0);
	unregisterWorker(-1);
	unregisterWorker(NaN);
	const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
	assert.equal(raw.length, 1);
});

// === cleanupOrphanWorkers ===

test("cleanupOrphanWorkers handles missing registry file", () => {
	// No registerWorker called, file doesn't exist
	const result = cleanupOrphanWorkers("session-A");
	assert.equal(result.scanned, 0);
	assert.equal(result.killed, 0);
	assert.equal(result.pruned, 0);
	assert.equal(result.kept, 0);
});

test("cleanupOrphanWorkers prunes dead PIDs from registry", () => {
	// Register a PID that doesn't exist (very high number)
	registerWorker(999_999_999, "session-A", "run-dead", 999_999_998);

	const result = cleanupOrphanWorkers("session-B");
	assert.equal(result.scanned, 1);
	assert.equal(result.pruned, 1, "dead PID pruned");
	assert.equal(result.killed, 0);
	assert.equal(result.kept, 0);

	// Registry should be empty now
	const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
	assert.equal(raw.length, 0);
});

test("cleanupOrphanWorkers keeps current session's workers (concurrent session safe)", async () => {
	const tmp = mkdtemp("pi-crew-sleep-");
	try {
		// Spawn a real long-running sleep process to have an alive PID
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: false,
			stdio: "ignore",
		});
		const livePid = child.pid!;
		// Use current process's PID as "parent" so the parent-alive check
		// triggers (which would normally keep the entry). Then verify the
		// current-session check kicks in FIRST.
		registerWorker(livePid, "session-MINE", "run-1", process.pid);

		const result = cleanupOrphanWorkers("session-MINE");
		assert.equal(result.scanned, 1);
		assert.equal(result.kept, 1, "current session worker kept");
		assert.equal(result.killed, 0);

		// Cleanup: kill the sleep process
		child.kill();
	} finally {
		rmrf(tmp);
	}
});

test("cleanupOrphanWorkers uses SIGKILL (not SIGTERM) on stale workers", async () => {
	const tmp = mkdtemp("pi-crew-sigtest-");
	try {
		// Write a script to a file named background-runner.ts so the
		// verifyIsBackgroundWorker check passes (requires arg ending in .ts).
		// The script traps SIGTERM but dies on SIGKILL.
		const scriptPath = path.join(tmp, "background-runner.ts");
		fs.writeFileSync(
			scriptPath,
			`process.on("SIGTERM", () => { /* ignore */ });
setInterval(() => {}, 1000);`,
		);
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, [scriptPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const livePid = child.pid!;

		// Register with dead parent (so it gets killed) and old timestamp.
		const past = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
		const entries = [
			{
				pid: livePid,
				sessionId: "session-OLD",
				runId: "run-1",
				parentPid: 999_998, // dead
				registeredAt: past,
				parentPidStartTime: 0,
				startTime: 0,
			},
		];
		fs.writeFileSync(REGISTRY_FILE, JSON.stringify(entries));

		const result = cleanupOrphanWorkers("session-NEW");
		assert.equal(result.scanned, 1);
		assert.equal(result.killed, 1, "stale worker killed (SIGKILL)");;

		// Give the OS a moment to deliver the signal.
		await new Promise((r) => setTimeout(r, 100));
		let stillAlive = true;
		try {
			process.kill(livePid, 0);
		} catch {
			stillAlive = false;
		}
		assert.equal(stillAlive, false, "process should be dead after SIGKILL");
	} finally {
		rmrf(tmp);
	}
});

test("cleanupOrphanWorkers keeps workers with alive parentPid (concurrent session protection)", async () => {
	// Use current process's PID as both "parent" and "worker alive"
	// (test process is alive). This simulates: another pi session is
	// still running, with a long-lived worker.
	const tmp = mkdtemp("pi-crew-concurrent-");
	try {
		const { spawn } = await import("node:child_process");
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ stdio: "ignore" },
		);
		const livePid = child.pid!;
		// Register: sessionId=OTHER, parentPid=process.pid (still alive)
		const past = Date.now() - 25 * 60 * 60 * 1000; // very old
		const entries = [
			{
				pid: livePid,
				sessionId: "session-OTHER",
				runId: "run-1",
				parentPid: process.pid, // alive!
				registeredAt: past,
				parentPidStartTime: 0,
				startTime: 0,
			},
		];
		fs.writeFileSync(REGISTRY_FILE, JSON.stringify(entries));

		const result = cleanupOrphanWorkers("session-MINE");
		assert.equal(result.scanned, 1);
		assert.equal(result.kept, 1, "alive parent → keep worker");
		assert.equal(result.killed, 0);

		child.kill();
	} finally {
		rmrf(tmp);
	}
});

test("cleanupOrphanWorkers tolerates corrupt registry file", () => {
	fs.writeFileSync(REGISTRY_FILE, "this is not JSON");
	const result = cleanupOrphanWorkers("session-A");
	assert.equal(result.scanned, 0);
	assert.equal(result.killed, 0);
});

test("cleanupOrphanWorkers prunes registry entries that no longer match the schema", () => {
	// Mix of valid and invalid entries
	const mixed = [
		{ pid: 999_999_999, sessionId: "s", runId: "r", registeredAt: 1, parentPidStartTime: 0, startTime: 0 }, // missing parentPid → pruned as schema-invalid
		null,
		"string",
		{ pid: 100, sessionId: "s", runId: "r", parentPid: 50, registeredAt: Date.now(), parentPidStartTime: 0, startTime: 0 }, // valid + live (we'll kill it)
	];
	fs.writeFileSync(REGISTRY_FILE, JSON.stringify(mixed));

	const result = cleanupOrphanWorkers("session-MINE");
	// Valid entry (PID 100) is alive, but sessionId="s" != "session-MINE" and
	// parentPid=50 is dead → should be killed.
	// The schema-invalid entry (PID 999_999_999) is dead, will be pruned.
	assert.ok(result.scanned >= 1, "at least the valid entry scanned");
	assert.ok(result.pruned >= 1, "invalid entry pruned");
});

test("cleanupOrphanWorkers prunes (not kills) when startTime mismatches (PID recycling detection)", async () => {
	const tmp = mkdtemp("pi-crew-recycle-");
	try {
		// Spawn a long-running process so the PID stays alive during cleanup.
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
			detached: false,
			stdio: "ignore",
		});
		const livePid = child.pid!;

		// Write a registry entry with a startTime that is guaranteed NOT to match
		// the real process startTime. This simulates PID recycling: the OS gave
		// this PID to a new process after our entry was written.
		const past = Date.now() - 25 * 60 * 60 * 1000; // 25h ago (stale)
		const entries = [
			{
				pid: livePid,
				sessionId: "session-OTHER",
				runId: "run-1",
				parentPid: 999_998, // dead parent
				registeredAt: past,
				startTime: 999999999, // Clearly fake — won't match the real startTime
				parentPidStartTime: 0,
			},
		];
		fs.writeFileSync(REGISTRY_FILE, JSON.stringify(entries));

		const result = cleanupOrphanWorkers("session-MINE");

		// PID is alive but startTime doesn't match → prune (not kill).
		// The mismatch signals PID recycling, so we remove the entry without
		// sending SIGKILL to avoid killing the wrong process.
		assert.equal(result.scanned, 1);
		assert.equal(result.pruned, 1, "mismatched startTime → prune (not kill)");
		assert.equal(result.killed, 0, "PID recycling detected — did not kill");

		// Verify the process is still alive (we pruned the entry, not the process).
		let stillAlive = true;
		try {
			process.kill(livePid, 0);
		} catch {
			stillAlive = false;
		}
		assert.equal(stillAlive, true, "process should still be running");
	} finally {
		rmrf(tmp);
	}
});
