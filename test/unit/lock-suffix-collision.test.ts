/**
 * Regression test for P0 finding C-02: lock mechanism suffix collision.
 *
 * Two lock mechanisms previously used the SAME `.lock` suffix:
 *   - event-log.ts: mkdir-based lock → `${eventsPath}.lock/` (a DIRECTORY)
 *   - locks.ts:     O_EXCL-based lock → `${filePath}.lock`   (a FILE)
 *
 * If both derived from the same base path, stale reclaim (rmSync recursive)
 * on one could delete the other. The fix gives them distinct suffixes:
 *   - event-log: `.mkdirlock` (directory)
 *   - file-lock: `.flock`     (file)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { appendEvent, readEvents, withEventLogLockSync } from "../../src/state/event-log/event-log.ts";
import { withFileLockSync } from "../../src/state/locks.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-lock-suffix-"));
}

describe("C-02: distinct lock suffixes prevent mechanism collision", () => {
	describe("Test 1: both locks coexist without deleting each other", () => {
		it("event-log creates .mkdirlock directory, file-lock creates .flock file", () => {
			const dir = tmpDir();
			const base = path.join(dir, "events.jsonl");
			try {
				// Acquire event-log lock — should create a DIRECTORY with .mkdirlock suffix
				let eventLockDirExists = false;
				const eventResult = withEventLogLockSync(base, () => {
					eventLockDirExists = fs.existsSync(`${base}.mkdirlock`);
					// While holding the event-log lock, acquire the file lock
					let flockExists = false;
					const fileResult = withFileLockSync(base, () => {
						flockExists = fs.existsSync(`${base}.flock`);
						return "file-ok";
					});
					assert.equal(fileResult, "file-ok");
					assert.ok(flockExists, ".flock file must exist during withFileLockSync");
					return "event-ok";
				});
				assert.equal(eventResult, "event-ok");
				assert.ok(eventLockDirExists, ".mkdirlock directory must exist during withEventLogLockSync");

				// After both locks are released, neither artifact should remain
				assert.ok(!fs.existsSync(`${base}.mkdirlock`), ".mkdirlock dir should be cleaned up");
				assert.ok(!fs.existsSync(`${base}.flock`), ".flock file should be cleaned up");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("the old .lock suffix is NOT used by either mechanism", () => {
			const dir = tmpDir();
			const base = path.join(dir, "shared.jsonl");
			try {
				withEventLogLockSync(base, () => {
					withFileLockSync(base, () => {
						// Neither mechanism should create anything with .lock suffix
						assert.ok(!fs.existsSync(`${base}.lock`), "no .lock artifact should exist");
						assert.ok(fs.existsSync(`${base}.mkdirlock`), ".mkdirlock dir must exist");
						assert.ok(fs.existsSync(`${base}.flock`), ".flock file must exist");
						return undefined;
					});
					return undefined;
				});
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("Test 2: stale reclaim of .mkdirlock does NOT touch .flock", () => {
		it("event-log stale reclaim removes only .mkdirlock directory", () => {
			const dir = tmpDir();
			const base = path.join(dir, "events.jsonl");
			try {
				// Plant a stale .mkdirlock directory (simulating a crashed holder)
				const mkdirlockDir = `${base}.mkdirlock`;
				fs.mkdirSync(mkdirlockDir);
				fs.writeFileSync(path.join(mkdirlockDir, "pid"), String(999999), "utf-8");
				// Backdate mtime to exceed staleMs
				const oldMtime = new Date(Date.now() - 60000);
				fs.utimesSync(mkdirlockDir, oldMtime, oldMtime);

				// Also plant a .flock file that should be LEFT ALONE
				const flockFile = `${base}.flock`;
				const flockContent = JSON.stringify({
					kind: "file",
					pid: 999999,
					createdAt: new Date().toISOString(),
					token: "should-survive",
				});
				fs.writeFileSync(flockFile, flockContent, "utf-8");

				// withEventLogLockSync should reclaim the stale .mkdirlock and proceed
				const result = withEventLogLockSync(base, () => "reclaimed", {
					staleMs: 100,
					timeoutMs: 5000,
				});
				assert.equal(result, "reclaimed");

				// The stale .mkdirlock should be cleaned up (replaced by a fresh one that
				// is then released at the end of the lock scope)
				// The .flock file MUST still exist untouched
				assert.ok(fs.existsSync(flockFile), ".flock file must survive event-log stale reclaim — this is the C-02 bug");
				assert.equal(fs.readFileSync(flockFile, "utf-8"), flockContent, ".flock content must be unchanged");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("Test 3: event-log functionality still works after suffix change", () => {
		it("appendEvent writes and readEvents reads back correctly", () => {
			const dir = tmpDir();
			const eventsPath = path.join(dir, "events.jsonl");
			try {
				const event = appendEvent(eventsPath, {
					type: "task.started",
					runId: "test-run-c02",
					taskId: "task-1",
					message: "regression test event",
				});
				assert.ok(event.metadata?.seq, "event should have a sequence number");

				const events = readEvents(eventsPath);
				assert.equal(events.length, 1, "should read back exactly 1 event");
				assert.equal(events[0].type, "task.started");
				assert.equal(events[0].runId, "test-run-c02");
				assert.equal(events[0].taskId, "task-1");
				assert.equal(events[0].message, "regression test event");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("multiple appends get monotonic sequence numbers", () => {
			const dir = tmpDir();
			const eventsPath = path.join(dir, "events.jsonl");
			try {
				const e1 = appendEvent(eventsPath, { type: "task.started", runId: "r" });
				const e2 = appendEvent(eventsPath, { type: "task.completed", runId: "r" });
				assert.ok(e2.metadata!.seq > e1.metadata!.seq, "seq must be monotonic");

				const events = readEvents(eventsPath);
				assert.equal(events.length, 2);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
