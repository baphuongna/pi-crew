/**
 * Round 26 lock-correctness fixes (BUG 1/2 in locks.ts):
 *
 * BUG 1: acquireLockWithRetry did two separate readFileSync calls
 *   (isLockStale + isLockHolderAlive). Between them the lock could transition
 *   stale→fresh, and we'd forcibly rm a NEW holder's freshly-acquired lock.
 *   Fix: readLockSnapshot() does a single stat+read for both checks.
 *
 * BUG 2: withFileLockSync had a pre-acquisition cleanup that stat'd the TARGET
 *   file and deleted the .lock if the target was missing. This was racy
 *   (concurrent holder creating the target) and actively wrong for callers
 *   passing a path already ending in .lock (config.ts). Fix: removed entirely;
 *   acquireLockWithRetry's staleMs-based steal handles genuine orphans.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { withFileLockSync } from "../../src/state/coordination/locks.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-r26-filelock-"));
}

describe("Round 26 BUG 1: acquireLockWithRetry uses a single-snapshot read", () => {
	it("steals a stale lock (older than staleMs) and proceeds", () => {
		const dir = tmpDir();
		const target = path.join(dir, "target.json");
		try {
			// Plant a stale lock: write a lock file with an old createdAt + a dead pid.
			const lockFile = `${target}.flock`;
			const oldPid = 999999; // almost certainly dead
			const payload = JSON.stringify({
				token: "old-dead",
				pid: oldPid,
				createdAt: new Date(Date.now() - 60000).toISOString(),
			});
			fs.writeFileSync(lockFile, payload, "utf-8");
			// withFileLockSync should steal it and run the callback.
			const result = withFileLockSync(target, () => "stolen-ok", {
				staleMs: 1000,
			});
			assert.equal(result, "stolen-ok");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does NOT steal a lock that is fresh AND held by a live process (blocks until it goes stale)", () => {
		const dir = tmpDir();
		const target = path.join(dir, "target2.json");
		try {
			// Plant a FRESH lock held by a LIVE pid (us). The single-snapshot read
			// must see fresh+alive → canSteal=false → it must WAIT, not immediately
			// steal. It only proceeds once the lock naturally ages past staleMs.
			const lockFile = `${target}.flock`;
			const start = Date.now();
			const payload = JSON.stringify({
				token: "fresh-live",
				pid: process.pid,
				createdAt: new Date(start).toISOString(),
			});
			fs.writeFileSync(lockFile, payload, "utf-8");
			// With staleMs=300, the lock is fresh at t=0 and must block until ~t=300
			// before the snapshot reports it stale. If the TOCTOU bug were present,
			// a separate read could split and steal immediately (< 50ms). Verify it
			// blocks for at least ~staleMs before proceeding.
			const result = withFileLockSync(target, () => "eventually-ok", {
				staleMs: 300,
			});
			const elapsed = Date.now() - start;
			assert.equal(result, "eventually-ok");
			assert.ok(
				elapsed >= 250,
				`should block until stale (~300ms), took ${elapsed}ms — may have stolen a fresh live lock (TOCTOU regression?)`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Round 26 BUG 2: removed racy pre-acquisition target cleanup", () => {
	it("withFileLockSync proceeds even when the target file does not exist yet (first-time create)", () => {
		// Previously, a missing target triggered a .lock deletion BEFORE acquire.
		// Now the target's existence is irrelevant to lock acquisition; the
		// callback may create the file inside the lock. We just verify it works.
		const dir = tmpDir();
		const target = path.join(dir, "brand-new.json");
		try {
			assert.ok(!fs.existsSync(target), "precondition: target absent");
			const result = withFileLockSync(target, () => {
				fs.writeFileSync(target, "{}", "utf-8");
				return "created";
			});
			assert.equal(result, "created");
			assert.ok(fs.existsSync(target), "callback created the target inside the lock");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("withFileLockSync works when the path passed already ends in .lock (config.ts pattern)", () => {
		// config.ts passes `filePath + ".lock"` to withFileLockSync. This must
		// not deadlock or misbehave (the old cleanup deleted a fresh holder's
		// lock because the ".lock"-suffixed "target" never existed).
		const dir = tmpDir();
		const base = path.join(dir, "config.json");
		const passedPath = `${base}.lock`; // mimics config.ts
		try {
			const result = withFileLockSync(passedPath, () => "config-ok", {
				staleMs: 1000,
			});
			assert.equal(result, "config-ok");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
