import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverRunLockFiles, sweepStaleLocks } from "../../../../src/state/coordination/locks.ts";

/**
 * US-002 (2026-09-22): structured stale-lock sweep. Locks whose holder died
 * without releasing lingered until some future acquirer hit the stale-steal
 * path. sweepStaleLocks applies the SAME proof as acquire time — stale AND
 * holder-dead — so a live holder is never disturbed.
 *
 * The lock format read here is the one writeLock produces: JSON with a pid.
 * Fixtures write it directly so the test controls liveness deterministically.
 */

const DEFAULT_STALE_MS = 60_000; // any value; fixtures set createdAt explicitly

function writeLockFile(dir: string, pid: number, ageMs: number): string {
	fs.mkdirSync(dir, { recursive: true });
	const lockPath = path.join(dir, "run.lock");
	fs.writeFileSync(lockPath, JSON.stringify({ pid, token: "t", createdAt: new Date(Date.now() - ageMs).toISOString() }));
	return lockPath;
}

test("US-002: a dead-holder stale lock is swept", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "us002-"));
	try {
		// PID 2^31-1 is essentially never a live process; combine with staleness.
		const lockPath = writeLockFile(path.join(root, "team_dead"), 2_147_483_647, DEFAULT_STALE_MS + 60_000);
		const { removed } = sweepStaleLocks([lockPath], { staleMs: DEFAULT_STALE_MS });
		assert.deepEqual(removed, [lockPath]);
		assert.equal(fs.existsSync(lockPath), false, "the dead lock must be gone");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("US-002: a LIVE holder's lock is never swept (even if old)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "us002-"));
	try {
		// Our own PID is definitely alive; make it older than the stale window so
		// only the liveness proof protects it.
		const lockPath = writeLockFile(path.join(root, "team_live"), process.pid, DEFAULT_STALE_MS + 60_000);
		const { removed } = sweepStaleLocks([lockPath], { staleMs: DEFAULT_STALE_MS });
		assert.deepEqual(removed, [], "a live holder must not be swept");
		assert.ok(fs.existsSync(lockPath), "live lock must remain");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("US-002: a FRESH lock is never swept (not yet stale)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "us002-"));
	try {
		const lockPath = writeLockFile(path.join(root, "team_fresh"), 2_147_483_647, 10);
		const { removed } = sweepStaleLocks([lockPath], { staleMs: DEFAULT_STALE_MS });
		assert.deepEqual(removed, [], "a fresh lock must not be swept even with a dead pid");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("US-002: sweep is idempotent (second pass finds nothing)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "us002-"));
	try {
		const lockPath = writeLockFile(path.join(root, "team_idem"), 2_147_483_647, DEFAULT_STALE_MS + 60_000);
		const first = sweepStaleLocks([lockPath], { staleMs: DEFAULT_STALE_MS });
		const second = sweepStaleLocks([lockPath], { staleMs: DEFAULT_STALE_MS });
		assert.equal(first.removed.length, 1);
		assert.equal(second.removed.length, 0, "second sweep must be a no-op");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("US-002: discoverRunLockFiles finds run.lock under each run dir, bounded", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "us002-"));
	try {
		writeLockFile(path.join(root, "team_a"), process.pid, 10);
		writeLockFile(path.join(root, "team_b"), process.pid, 10);
		fs.mkdirSync(path.join(root, "team_c"), { recursive: true }); // no lock
		const found = discoverRunLockFiles(root);
		assert.equal(found.length, 2, `expected 2 lock files, got ${found.join(",")}`);
		assert.ok(found.every((p) => p.endsWith(path.join("run.lock"))));
		// Missing root → empty, no throw.
		assert.deepEqual(discoverRunLockFiles(path.join(root, "nope")), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("US-002: end-to-end — discover + sweep leaves only the live lock", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "us002-"));
	try {
		const dead = writeLockFile(path.join(root, "team_dead"), 2_147_483_647, DEFAULT_STALE_MS + 60_000);
		const live = writeLockFile(path.join(root, "team_live"), process.pid, DEFAULT_STALE_MS + 60_000);
		const { removed } = sweepStaleLocks(discoverRunLockFiles(root), { staleMs: DEFAULT_STALE_MS });
		assert.deepEqual(removed, [dead]);
		assert.equal(fs.existsSync(dead), false);
		assert.ok(fs.existsSync(live), "live lock survives the full sweep");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
