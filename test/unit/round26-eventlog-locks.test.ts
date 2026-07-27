/**
 * Round 26 lock-correctness fixes (BUG 3/4/5 in withEventLogLockSync):
 *
 * BUG 3: a crash between mkdir and pidFile write left a lock dir with NO
 *   pidFile. Stale detection could only read pidFile → permanent wedge.
 *   Fix: reclaim the dir if its mtime exceeds staleMs, regardless of pidFile.
 *
 * BUG 4: mtime check was nested inside `if (!alive)`. A recycled PID kept
 *   alive=true → mtime never checked → permanent wedge.
 *   Fix: mtime checked FIRST for ALL holders.
 *
 * BUG 5: release was an UNCONDITIONAL rmSync. If our fn outlived staleMs and
 *   another process stole the lock, our finally deleted the STEALER's dir.
 *   Fix: verify pidFile still records OUR pid before removing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { withEventLogLockSync } from "../../src/state/event-log.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-r26-locks-"));
}
function eventsPath(dir: string): string {
	return path.join(dir, "events.jsonl");
}
function lockDirFor(events: string): string {
	return `${events}.mkdirlock`;
}

describe("Round 26 BUG 3: orphan lock dir without pidFile is reclaimed by mtime", () => {
	it("reclaims a lock dir with no pidFile once mtime exceeds staleMs", () => {
		const dir = tmpDir();
		const events = eventsPath(dir);
		try {
			const ld = lockDirFor(events);
			// Simulate crash-after-mkdir: lock dir exists, NO pidFile.
			fs.mkdirSync(ld);
			// Backdate the dir's mtime to older than staleMs (50ms).
			const oldMtime = new Date(Date.now() - 1000);
			fs.utimesSync(ld, oldMtime, oldMtime);
			// withEventLogLockSync should reclaim it and proceed (fast).
			const start = Date.now();
			const result = withEventLogLockSync(events, () => "ok", {
				staleMs: 50,
				timeoutMs: 2000,
			});
			const elapsed = Date.now() - start;
			assert.equal(result, "ok");
			assert.ok(elapsed < 1500, `should reclaim quickly, took ${elapsed}ms`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Round 26 BUG 4: recycled PID handled by independent mtime check", () => {
	it("reclaims a lock held by a 'live' recycled PID when mtime is stale", () => {
		const dir = tmpDir();
		const events = eventsPath(dir);
		try {
			const ld = lockDirFor(events);
			fs.mkdirSync(ld);
			// Write a pidFile pointing at OUR OWN pid (definitely "alive" via
			// kill(pid,0)), simulating a recycled PID that now belongs to an
			// unrelated live process. With BUG 4 this would wedge forever because
			// alive=true blocked the mtime check.
			fs.writeFileSync(path.join(ld, "pid"), String(process.pid), "utf-8");
			// Backdate mtime past staleMs.
			const oldMtime = new Date(Date.now() - 1000);
			fs.utimesSync(ld, oldMtime, oldMtime);
			const start = Date.now();
			const result = withEventLogLockSync(events, () => "ok", {
				staleMs: 50,
				timeoutMs: 2000,
			});
			const elapsed = Date.now() - start;
			assert.equal(result, "ok");
			assert.ok(elapsed < 1500, `should reclaim despite 'live' pid, took ${elapsed}ms`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Round 26 BUG 5: PID-guarded release does not delete a stealer's dir", () => {
	it("does NOT remove the lock dir when pidFile records a different (stealer's) pid", () => {
		const dir = tmpDir();
		const events = eventsPath(dir);
		try {
			const ld = lockDirFor(events);
			// We hold the lock, writing our pidFile normally.
			// Then inside fn(), simulate a steal: replace pidFile with a different pid
			// AND re-create the dir as if a stealer took it.
			const stealerPid = 999999; // an unlikely real pid
			const result = withEventLogLockSync(
				events,
				() => {
					// Simulate the stealer stealing: overwrite pidFile.
					fs.writeFileSync(path.join(ld, "pid"), String(stealerPid), "utf-8");
					return "ran";
				},
				{ staleMs: 5000, timeoutMs: 2000 },
			);
			assert.equal(result, "ran");
			// After release, the dir should STILL EXIST (we did not delete the
			// stealer's dir because pidFile no longer matches our pid).
			assert.ok(fs.existsSync(ld), "stealer's lock dir must survive our guarded release");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes the lock dir normally when pidFile still records our pid", () => {
		const dir = tmpDir();
		const events = eventsPath(dir);
		try {
			const ld = lockDirFor(events);
			const result = withEventLogLockSync(events, () => "ran", {
				staleMs: 5000,
				timeoutMs: 2000,
			});
			assert.equal(result, "ran");
			assert.ok(!fs.existsSync(ld), "our own lock dir should be cleaned up");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
