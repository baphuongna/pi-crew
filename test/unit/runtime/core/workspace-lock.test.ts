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
import {
	acquireWorkspaceLock,
	reclaimStaleLocks,
	refreshWorkspaceLockHeartbeat,
	type StartTimeResolver,
	workspaceLockPath,
} from "../../../../src/runtime/workspace-lock.ts";
import { clearProjectRootCache } from "../../../../src/utils/paths.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

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
	afterEach(async () => {
		await removeDirWithRetry(cwd);
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
	afterEach(async () => {
		await removeDirWithRetry(cwd);
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
	afterEach(async () => {
		await removeDirWithRetry(cwd);
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

	it("R7-C2 (wave-2b): non-numeric heartbeat is a CORRUPT lockfile, not an immortal lock", async () => {
		// A hand-edited/corrupt lockfile with heartbeat: "not-a-number" used to
		// make `now - lock.heartbeat` NaN and every staleness comparison false —
		// nothing could ever steal the lock. readLock now type-validates the
		// heartbeat (non-finite → corrupt → steal path), same as unparseable JSON.
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		const now = 1_000_000;
		fs.mkdirSync(path.dirname(workspaceLockPath(cwd)), { recursive: true });
		fs.writeFileSync(
			workspaceLockPath(cwd),
			JSON.stringify({
				pid: FIXED_PID,
				startTime: 1000,
				heartbeat: "not-a-number",
				goalId: "corrupt_goal",
				acquiredAt: new Date(now).toISOString(),
			}),
		);
		const handle = await acquireWorkspaceLock(cwd, "goal_rescuer", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			now: () => now,
			heartbeatStaleMs: 60_000,
			pollMs: 5,
		});
		const contents = JSON.parse(fs.readFileSync(workspaceLockPath(cwd), "utf-8"));
		assert.equal(contents.goalId, "goal_rescuer", "corrupt-heartbeat lock must be stealable");
		handle.release();
	});
});

describe("workspace-lock contention policy", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(async () => {
		await removeDirWithRetry(cwd);
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

describe("refreshWorkspaceLockHeartbeat (WI-2 / DR-02 R4-3)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(async () => {
		await removeDirWithRetry(cwd);
	});

	it("re-stamps ONLY the heartbeat of a lock still owned by goalId+pid, preserving every other field", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		let now = 1_000_000;
		const handle = await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			now: () => now,
			pollMs: 5,
		});
		const lockPath = workspaceLockPath(cwd);
		const before = JSON.parse(fs.readFileSync(lockPath, "utf-8"));

		now += 15_000; // one refresh interval later
		const refreshed = refreshWorkspaceLockHeartbeat(lockPath, "goal_a", { pid: FIXED_PID, now: () => now });
		assert.equal(refreshed, true, "refresh must succeed while goal_a owns the lock");

		const after = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		assert.equal(after.heartbeat, 1_015_000, "heartbeat must be re-stamped at the injected now");
		assert.equal(after.pid, before.pid, "pid preserved");
		assert.equal(after.startTime, before.startTime, "startTime preserved");
		assert.equal(after.goalId, before.goalId, "goalId preserved");
		assert.equal(after.acquiredAt, before.acquiredAt, "acquiredAt preserved");
		assert.deepEqual(
			Object.keys(after).sort(),
			["acquiredAt", "goalId", "heartbeat", "pid", "startTime"],
			"file format (field set) identical",
		);
		handle.release();
	});

	it("does NOT clobber a lock reclaimed by another goal (goalId mismatch → false, file untouched)", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});
		const lockPath = workspaceLockPath(cwd);
		// Simulate the lock being force-reclaimed + re-acquired by goal_other (same pid — the
		// goalId guard alone must refuse the refresh, mirroring safeRelease's ownership check).
		const reclaimedContents = {
			pid: FIXED_PID,
			startTime: 1000,
			heartbeat: 9_999_999,
			goalId: "goal_other",
			acquiredAt: new Date(9_999_999).toISOString(),
		};
		fs.writeFileSync(lockPath, JSON.stringify(reclaimedContents));

		const refreshed = refreshWorkspaceLockHeartbeat(lockPath, "goal_a", { pid: FIXED_PID, now: () => 5_000_000 });
		assert.equal(refreshed, false, "refresh must refuse a lock owned by another goal");
		assert.deepEqual(
			JSON.parse(fs.readFileSync(lockPath, "utf-8")),
			reclaimedContents,
			"the new owner's lockfile must be byte-for-byte untouched",
		);
	});

	it("does NOT refresh a lock whose pid differs (pid mismatch → false)", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});
		const lockPath = workspaceLockPath(cwd);
		const before = fs.readFileSync(lockPath, "utf-8");
		const refreshed = refreshWorkspaceLockHeartbeat(lockPath, "goal_a", { pid: 77777, now: () => 5_000_000 });
		assert.equal(refreshed, false, "refresh must refuse a lock owned by a different pid");
		assert.equal(fs.readFileSync(lockPath, "utf-8"), before, "lockfile untouched");
	});

	it("returns false for a missing lockfile and creates nothing", () => {
		const missing = path.join(cwd, ".crew", "state", "workspace-locks", "missing.lock");
		assert.equal(refreshWorkspaceLockHeartbeat(missing, "goal_x"), false);
		assert.ok(!fs.existsSync(missing), "refresh must never create a lockfile");
	});

	// W6 fix (refresh-clobber-steal): the refresh write used to be an
	// unconditional temp+rename. A concurrent stale-steal (the module's own
	// unlink→O_EXCL→verify protocol) landing between the refresher's read and
	// its rename was silently CLOBBERED — and the post-write re-read saw the
	// refresher's own content, so the clobber was undetectable (dual-owner
	// window; onOwnershipLost never fired for the old holder). The refresh is
	// now a compare-and-swap on the observed file identity + bytes: it can
	// never replace a file it did not observe at read time.
	it("does NOT clobber a lock stolen mid-refresh (identity CAS — W6 regression, brief PoC)", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});
		const lockPath = workspaceLockPath(cwd);

		// The stealer (goal_b) completes the module's own stale-steal protocol —
		// unlink + O_EXCL create + post-claim verify — inside A's refresh window,
		// deterministically interposed via the documented opts.now seam (the
		// production call evaluates it between the ownership validation and the
		// rename; with the fix it also lands BEFORE the pre-rename CAS check).
		let stealDone = false;
		const steal = (): void => {
			fs.unlinkSync(lockPath);
			const fd = fs.openSync(lockPath, "wx");
			try {
				fs.writeFileSync(
					fd,
					JSON.stringify({
						pid: FIXED_PID,
						startTime: 1000,
						heartbeat: 9_999_999,
						goalId: "goal_b",
						acquiredAt: new Date(9_999_999).toISOString(),
					}),
				);
			} finally {
				fs.closeSync(fd);
			}
			const claim = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
			if (claim.goalId !== "goal_b") throw new Error("stealer post-claim verification failed");
			stealDone = true;
		};

		const refreshed = refreshWorkspaceLockHeartbeat(lockPath, "goal_a", {
			pid: FIXED_PID,
			now: () => {
				if (!stealDone) steal();
				return 5_000_000;
			},
		});

		assert.equal(stealDone, true, "steal must have landed inside the refresh window");
		assert.equal(refreshed, false, "refresh must refuse to clobber the stealer's verified claim");
		const after = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		assert.equal(after.goalId, "goal_b", "B's verified claim must survive A's refresh");
		assert.equal(after.heartbeat, 9_999_999, "B's heartbeat must be untouched");
		// A refused refresh must clean up its temp file — no litter in the locks dir.
		const leftovers = fs.readdirSync(path.dirname(lockPath)).filter((e) => e.endsWith(".tmp"));
		assert.equal(leftovers.length, 0, "refused refresh must leave no temp files");
		// A's NEXT heartbeat tick must keep failing (A no longer owns the lock) —
		// this is what stops A's loop via onOwnershipLost instead of the old
		// blind true-forever behavior.
		assert.equal(
			refreshWorkspaceLockHeartbeat(lockPath, "goal_a", { pid: FIXED_PID, now: () => 5_100_000 }),
			false,
			"A's subsequent refresh must keep failing after the steal",
		);
	});

	it("control: refresh by the current holder still succeeds after unrelated same-dir churn", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			pollMs: 5,
		});
		const lockPath = workspaceLockPath(cwd);
		const refreshed = refreshWorkspaceLockHeartbeat(lockPath, "goal_a", { pid: FIXED_PID, now: () => 6_000_000 });
		assert.equal(refreshed, true, "current holder's refresh must succeed (CAS passes on unchanged identity+bytes)");
		const after = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		assert.equal(after.goalId, "goal_a");
		assert.equal(after.heartbeat, 6_000_000);
	});
});

describe("heartbeat refresh vs staleness (WI-2 regression: live goal must not be force-stolen)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(async () => {
		await removeDirWithRetry(cwd);
	});

	it("WITHOUT refresh: a held lock goes stale after 60s and a second acquire force-steals it (existing behavior pinned)", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000); // pid stays ALIVE with matching startTime the whole test —
		// the steal below must be attributable to the heartbeat clause alone.
		let now = 1_000_000;
		const handleA = await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			now: () => now,
			heartbeatStaleMs: 60_000,
			pollMs: 5,
		});

		// Goal runs >60s WITHOUT any heartbeat refresh (the WI-2 bug).
		now += 120_000;

		const handleB = await acquireWorkspaceLock(cwd, "goal_b", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			now: () => now,
			heartbeatStaleMs: 60_000,
			pollMs: 5,
		});
		const contents = JSON.parse(fs.readFileSync(workspaceLockPath(cwd), "utf-8"));
		assert.equal(contents.goalId, "goal_b", "stale-heartbeat lock is force-stolen even though the pid is alive (pinned)");
		handleB.release();
		handleA.release(); // no-op — its lock was reclaimed
		assert.ok(!fs.existsSync(workspaceLockPath(cwd)));
	});

	it("WITH periodic refresh: a goal running >60s keeps its lock — second acquire does NOT steal", async () => {
		const { resolver, set } = mockStartTimes();
		set(FIXED_PID, 1000);
		let now = 1_000_000;
		const handleA = await acquireWorkspaceLock(cwd, "goal_a", {
			startTimeResolver: resolver,
			pid: FIXED_PID,
			now: () => now,
			heartbeatStaleMs: 60_000,
			pollMs: 5,
		});

		// Simulate the goal loop's 15s refresh cadence over 3 minutes of goal time
		// (12 refreshes — heartbeat never older than 15s ≪ 60s threshold).
		for (let tick = 0; tick < 12; tick++) {
			now += 15_000;
			const refreshed = refreshWorkspaceLockHeartbeat(workspaceLockPath(cwd), "goal_a", { pid: FIXED_PID, now: () => now });
			assert.equal(refreshed, true, `refresh #${tick + 1} must succeed while goal_a owns the lock`);
		}
		// now = 1_180_000: the goal has "run" 180s, but its heartbeat is 15s old.

		// A second goal on the same cwd must see a LIVE lock: with failOnWorkspaceBusy it
		// throws "workspace busy" instead of force-stealing (queue mode would just wait).
		await assert.rejects(
			acquireWorkspaceLock(cwd, "goal_b", {
				startTimeResolver: resolver,
				pid: FIXED_PID,
				now: () => now,
				heartbeatStaleMs: 60_000,
				failOnWorkspaceBusy: true,
				pollMs: 5,
			}),
			/workspace busy/,
			"a live refreshed lock must NOT be reclaimed as stale",
		);
		const contents = JSON.parse(fs.readFileSync(workspaceLockPath(cwd), "utf-8"));
		assert.equal(contents.goalId, "goal_a", "goal_a still owns the lock after running >60s with refresh");
		handleA.release();
		assert.ok(!fs.existsSync(workspaceLockPath(cwd)));
	});
});

describe("reclaimStaleLocks", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = makeTmpCwd();
	});
	afterEach(async () => {
		await removeDirWithRetry(cwd);
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

// ---------------------------------------------------------------------------
// R3-M-B1 / FS4 (Wave-3): ownership verification after stale-steal claims and
// heartbeat refreshes — a claim only succeeds when the lockfile provably holds
// the claimer's goalId+pid; refresh never silently clobbers a foreign lock.
// ---------------------------------------------------------------------------

describe("Wave-3 ownership verification (R3-M-B1/FS4)", () => {
	it("stale-steal claim verifies the lockfile holds OUR goalId+pid afterwards", async () => {
		const cwd = makeTmpCwd();
		try {
			const lockPath = workspaceLockPath(cwd);
			// A stale foreign lock (ancient heartbeat + mtime).
			const stale = {
				goalId: "goal_dead",
				pid: 999_999,
				startTime: undefined,
				acquiredAt: new Date(0).toISOString(),
				heartbeat: 1000,
			};
			fs.writeFileSync(lockPath, JSON.stringify(stale));
			fs.utimesSync(lockPath, new Date(0), new Date(0));
			const resolver: StartTimeResolver = () => undefined;
			const handle = await acquireWorkspaceLock(cwd, "goal_new", { startTimeResolver: resolver, pollMs: 5 });
			assert.ok(handle);
			const onDisk = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { goalId: string; pid: number };
			assert.equal(onDisk.goalId, "goal_new", "claimed lock provably owned (goalId)");
			assert.equal(onDisk.pid, process.pid, "claimed lock provably owned (pid)");
		} finally {
			await removeDirWithRetry(cwd);
		}
	});

	it("refresh on our lock updates the heartbeat and returns true; the lock keeps our identity", async () => {
		const cwd = makeTmpCwd();
		try {
			const resolver: StartTimeResolver = () => undefined;
			await acquireWorkspaceLock(cwd, "goal_keep", { startTimeResolver: resolver, pollMs: 5 });
			const lockPath = workspaceLockPath(cwd);
			const before = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { heartbeat: number; goalId: string };
			const ok = refreshWorkspaceLockHeartbeat(lockPath, "goal_keep", { now: () => before.heartbeat + 5000 });
			assert.equal(ok, true);
			const after = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { heartbeat: number; goalId: string };
			assert.equal(after.heartbeat, before.heartbeat + 5000, "heartbeat re-stamped");
			assert.equal(after.goalId, "goal_keep", "identity preserved");
		} finally {
			await removeDirWithRetry(cwd);
		}
	});

	it("refresh-mismatch returns false and NEVER writes (missing lock, foreign owner)", async () => {
		const cwd = makeTmpCwd();
		try {
			const lockPath = workspaceLockPath(cwd);
			assert.equal(refreshWorkspaceLockHeartbeat(lockPath, "goal_x"), false, "missing lockfile → false");
			const foreign = JSON.stringify({ goalId: "goal_other", pid: 1, acquiredAt: new Date().toISOString(), heartbeat: Date.now() });
			fs.writeFileSync(lockPath, foreign);
			assert.equal(refreshWorkspaceLockHeartbeat(lockPath, "goal_x"), false, "foreign owner → false");
			assert.equal(fs.readFileSync(lockPath, "utf-8"), foreign, "foreign lockfile never clobbered");
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});

// runGoalLoop wiring pin (R3-M-B1): ownership-lost → goal blocked + event + exit.
it("runGoalLoop wiring pin: onOwnershipLost blocks the goal and emits goal.workspace_lock_lost", () => {
	const src = fs.readFileSync(path.join(import.meta.dirname, "../../../../src/runtime/goal-workflow/goal-loop-runner.ts"), "utf-8");
	const wiringIdx = src.indexOf("onOwnershipLost: () => {");
	assert.ok(wiringIdx > -1, "runGoalLoop must wire onOwnershipLost");
	const blockedIdx = src.indexOf('safeSetStatus(store, goal.goalId, "blocked"', wiringIdx);
	const eventIdx = src.indexOf("goal.workspace_lock_lost", wiringIdx);
	assert.ok(blockedIdx > -1, "ownership lost sets goal blocked");
	assert.ok(eventIdx > -1, "ownership lost emits goal.workspace_lock_lost event");
});
