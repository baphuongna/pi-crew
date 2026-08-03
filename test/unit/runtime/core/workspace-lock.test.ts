/**
 * Unit tests for workspace-lock.ts (P1g).
 *
 * RFC: research-findings/goal-workflow/13-VISION-RFC.md v0.5 §P1g + D10.
 *
 * Process start times are MOCKED via the injected startTimeResolver so no real
 * process spawn is needed (and PID recycling can be simulated deterministically).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { acquireWorkspaceLock, reclaimStaleLocks, type StartTimeResolver, workspaceLockPath } from "../../../../src/runtime/workspace-lock.ts";
import { clearProjectRootCache } from "../../../../src/utils/paths.ts";

function makeTmpCwd(): string {
	clearProjectRootCache(); // findRepoRoot has a global cache — clear so each tmpdir resolves correctly.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wslock-"));
	fs.mkdirSync(path.join(cwd, ".crew", "state", "workspace-locks"), {
		recursive: true,
	});
	return cwd;
}

/** A mock startTime resolver backed by a mutable pid→startTime map. */
function mockStartTimes(): {
	resolver: StartTimeResolver;
	map: Map<number, number>;
	set: (pid: number, t: number) => void;
} {
	const map = new Map<number, number>();
	const resolver: StartTimeResolver = (pid: number) => map.get(pid);
	return { resolver, map, set: (pid, t) => map.set(pid, t) };
}

const FIXED_PID = 12345;

describe("workspace-lock lockfile location + contents", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("writes the lockfile under .crew/state/workspace-locks/<sha256>.lock", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		const handle = await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});
		const expected = workspaceLockPath(cwd);
		assert.ok(
			expected.includes(path.join(".crew", "state", "workspace-locks")),
			`lock path should be under .crew/state/workspace-locks/, got ${expected}`,
		);
		assert.ok(fs.existsSync(expected), "lockfile must exist after acquire");
		assert.ok(expected.endsWith(".lock"));
		assert.notEqual(handle.lockPath, expected.length > 0 ? "" : "x"); // sanity
		assert.equal(handle.lockPath, expected);

		const contents = JSON.parse(fs.readFileSync(expected, "utf-8"));
		assert.equal(contents.pid, FIXED_PID);
		assert.equal(contents.startTime, 1000);
		assert.equal(contents.goalId, "goal_a");
		assert.equal(typeof contents.heartbeat, "number");
		assert.equal(typeof contents.acquiredAt, "string");
		handle.release();
		assert.ok(!fs.existsSync(expected), "lockfile removed on release");
	});

	it("release() is a no-op when the lock was already reclaimed by another goal", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		const handle = await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});
		// Simulate the lock being reclaimed & re-acquired by a different goal (e.g. via stale reclaim).
		const lockPath = workspaceLockPath(cwd);
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				pid: 99999,
				startTime: 5000,
				heartbeat: Date.now(),
				goalId: "goal_other",
				acquiredAt: new Date().toISOString(),
			}),
		);
		// Stale handle's release must NOT delete the new owner's lock.
		handle.release();
		assert.ok(fs.existsSync(lockPath), "new owner's lock must survive a stale handle release");
	});
});

describe("workspace-lock PID-recycling detection (startTime mismatch)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("reclaims a lock whose pid's current startTime differs from the lockfile (PID recycled)", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		// goal_a acquires with startTime=1000.
		const handleA = await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});

		// Simulate PID recycling: the same pid now reports a different startTime.
		set(FIXED_PID, 2000);

		// goal_b should reclaim goal_a's now-stale lock and acquire.
		const handleB = await acquireWorkspaceLock(cwd, "goal_b", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});
		const contents = JSON.parse(fs.readFileSync(workspaceLockPath(cwd), "utf-8"));
		assert.equal(contents.goalId, "goal_b", "stale lock should be reclaimed by goal_b");
		assert.equal(contents.startTime, 2000);

		handleB.release();
		// handleA's release must be a no-op (its lock was reclaimed).
		handleA.release();
		assert.ok(!fs.existsSync(workspaceLockPath(cwd)));
	});
});

describe("workspace-lock heartbeat staleness", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("reclaims a lock whose heartbeat is older than the threshold", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		let now = 1_000_000;
		// goal_a acquires; heartbeat stamped at t=1_000_000.
		const handleA = await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			now: () => now,
			heartbeatStaleMs: 60_000,
			pollMs: 5,
		});

		// Advance time beyond the heartbeat threshold (startTime unchanged → only heartbeat fires).
		now += 120_000;

		// goal_b reclaims the stale lock.
		const handleB = await acquireWorkspaceLock(cwd, "goal_b", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			now: () => now,
			heartbeatStaleMs: 60_000,
			pollMs: 5,
		});
		const contents = JSON.parse(fs.readFileSync(workspaceLockPath(cwd), "utf-8"));
		assert.equal(contents.goalId, "goal_b", "heartbeat-stale lock reclaimed by goal_b");
		handleB.release();
		handleA.release();
	});
});

describe("workspace-lock contention policy", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("default: concurrent goals on the same cwd SERIALIZE (queue then proceed on release)", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		const handleA = await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});

		let bResolved = false;
		const bPromise = acquireWorkspaceLock(cwd, "goal_b", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		}).then((h) => {
			bResolved = true;
			return h;
		});

		// While goal_a holds the lock, goal_b must remain queued.
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(bResolved, false, "goal_b must wait while goal_a holds the lock");

		handleA.release();
		const handleB = await bPromise;
		assert.equal(bResolved, true, "goal_b acquires after goal_a releases");
		const contents = JSON.parse(fs.readFileSync(workspaceLockPath(cwd), "utf-8"));
		assert.equal(contents.goalId, "goal_b");
		handleB.release();
	});

	it("failOnWorkspaceBusy:true → throws instead of queueing", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});
		await assert.rejects(
			() =>
				acquireWorkspaceLock(cwd, "goal_b", {
					startTimeResolver: resolver,
					pid: FIXED_PID,
					failOnWorkspaceBusy: true,
					pollMs: 5,
				}),
			/workspace busy/,
			"failOnWorkspaceBusy must throw when the workspace is held",
		);
	});
});

describe("reclaimStaleLocks", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("reclaims stale locks (old heartbeat) and leaves live locks untouched", () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		const dir = path.join(cwd, ".crew", "state", "workspace-locks");
		const now = 5_000_000;

		// Stale lock: heartbeat way past threshold.
		fs.writeFileSync(
			path.join(dir, "stale.lock"),
			JSON.stringify({
				pid: FIXED_PID,
				startTime: 1000,
				heartbeat: now - 120_000,
				goalId: "old_goal",
				acquiredAt: new Date(now - 120_000).toISOString(),
			}),
		);
		// Live lock: heartbeat fresh.
		fs.writeFileSync(
			path.join(dir, "live.lock"),
			JSON.stringify({
				pid: FIXED_PID,
				startTime: 1000,
				heartbeat: now - 1_000,
				goalId: "live_goal",
				acquiredAt: new Date(now - 1_000).toISOString(),
			}),
		);

		const reclaimed = reclaimStaleLocks(dir, {
			startTimeResolver: resolver,
			now: () => now,
			heartbeatStaleMs: 60_000,
		});
		assert.equal(reclaimed.length, 1);
		assert.ok(reclaimed[0].endsWith("stale.lock"));
		assert.ok(!fs.existsSync(path.join(dir, "stale.lock")), "stale lock deleted");
		assert.ok(fs.existsSync(path.join(dir, "live.lock")), "live lock preserved");
	});

	it("reclaims a recycled-PID lock via startTime mismatch", () => {
		const { resolver, set } = mockStartTimes();
		// Lock recorded startTime=1000 but the pid now reports 9999.
		set(FIXED_PID, 9999);
		const dir = path.join(cwd, ".crew", "state", "workspace-locks");
		const now = Date.now();
		fs.writeFileSync(
			path.join(dir, "recycled.lock"),
			JSON.stringify({
				pid: FIXED_PID,
				startTime: 1000,
				heartbeat: now,
				goalId: "recycled_goal",
				acquiredAt: new Date(now).toISOString(),
			}),
		);
		const reclaimed = reclaimStaleLocks(dir, {
			startTimeResolver: resolver,
			now: () => now,
		});
		assert.equal(reclaimed.length, 1, "recycled-PID lock should be reclaimed");
		assert.ok(!fs.existsSync(path.join(dir, "recycled.lock")));
	});

	it("returns [] for a missing directory", () => {
		assert.deepEqual(reclaimStaleLocks("/nonexistent/dir/xyz"), []);
	});
});
