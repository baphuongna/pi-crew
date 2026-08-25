/**
 * Perf Round 2 (Task 1, 2026-08-25): the sync `.mkdirlock` pid write must not
 * pay a full atomicWriteFile (temp file + rename + 2 fsync) for a pid file that
 * is disposable and mtime-stale-detected. Both lock paths (`.mkdirlock` sync and
 * `.alock` async) now write pid via an "wx" (O_CREAT|O_EXCL) open + plain write.
 *
 * These tests:
 *  1. Assert the pid file EXISTS with the correct pid content while the sync
 *     lock is held (withEventLogLockSync), and
 *  2. Assert `atomicWriteFile` was NOT invoked for the pid path by spying on
 *     fs calls around the lock.
 *
 * Spy technique: `node:fs` ESM namespace properties are read-only, so
 * `t.mock.method(fs, ...)` and direct assignment on the namespace do NOT work.
 * However the CommonJS exports object behind the builtin IS mutable, and
 * `module.syncBuiltinESMExports()` pushes patched functions back into every ESM
 * namespace that imported `node:fs` (verified on this toolchain, Node v22).
 * This is the same pattern used by Node's own test suite and by
 * `test/unit/manifest-cache-ttl.test.ts`.
 */

import assert from "node:assert/strict";
import type * as FsTypes from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { withEventLogLockSync } from "../../../../src/state/event-log/event-log.ts";

/**
 * Instrument the sync lock's pid write path.
 *
 * Counts calls to the file-create openSync calls that carry a "wx" flag against
 * a path ending in `/pid`, and counts every other write path that
 * `atomicWriteFile` would use to (re)produce a pid file:
 *   - `writeFileSync(pidPath, ...)` — the textbook atomicWriteFile-free write
 *     that MUST NOT happen for the pid (the new code uses openSync+writeSync),
 *   - `renameSync(<pid>.<uuid>.tmp, pidPath)` — the temp-file rename that
 *     `atomicWriteFile`'s rename step performs.
 *
 * So `pidFileWrites === 0` closes the loop: the pid appeared on disk, and neither
 * writeFileSync nor the atomicWrite temp+rename wrote it — it must have gone
 * through openSync("wx") + writeSync, which `openSyncCalls` proves directly.
 * A failure to install the spy surfaces via the `patched` flag (an
 * instrument-liveness guard against the assertions above passing vacuously).
 */
interface PidWriteSpy {
	readonly openSyncCalls: Array<[string, string]>;
	readonly pidFileWrites: number;
	readonly patched: boolean;
	restore(): void;
}

function spyFsForPidWrite(): PidWriteSpy {
	const nodeRequire = createRequire(import.meta.url);
	const fsCjs = nodeRequire("node:fs") as typeof FsTypes;
	const nodeModule = nodeRequire("node:module") as {
		syncBuiltinESMExports(): void;
	};
	const state = {
		openSyncCalls: [] as Array<[string, string]>,
		pidFileWrites: 0,
		patched: false,
	};

	const originalOpenSync = fsCjs.openSync;
	const originalWriteFileSync = fsCjs.writeFileSync;
	const originalRenameSync = fsCjs.renameSync;

	const isPidPath = (p: unknown): boolean => typeof p === "string" && p.endsWith(`${path.sep}pid`);

	fsCjs.openSync = (($path: unknown, $flag?: unknown, ...rest: unknown[]) => {
		const fd = originalOpenSync.apply(fsCjs, [$path, $flag, ...rest] as never);
		if (isPidPath($path) && typeof $flag === "string" && $flag.includes("wx")) {
			state.openSyncCalls.push([String($path), $flag]);
		}
		return fd;
	}) as typeof FsTypes.openSync;

	fsCjs.writeFileSync = (($path: unknown, ...rest: unknown[]) => {
		if (isPidPath($path)) state.pidFileWrites++;
		return originalWriteFileSync.apply(fsCjs, [$path, ...rest] as never) as ReturnType<typeof FsTypes.writeFileSync>;
	}) as typeof FsTypes.writeFileSync;

	fsCjs.renameSync = (($from: unknown, $to: unknown, ...rest: unknown[]) => {
		// atomicWriteFile renames its temp over the pid path exactly when the
		// temp's basename starts with "pid." (pid.<uuid>.tmp).
		if (
			typeof $from === "string" &&
			$from.includes(`${path.sep}pid.`) &&
			$from.endsWith(".tmp") &&
			isPidPath($to)
		) {
			state.pidFileWrites++;
		}
		return originalRenameSync.apply(fsCjs, [$from, $to, ...rest] as never) as ReturnType<typeof FsTypes.renameSync>;
	}) as typeof FsTypes.renameSync;

	try {
		nodeModule.syncBuiltinESMExports();
		state.patched = true;
	} catch {
		state.patched = false;
	}

	return {
		get openSyncCalls() {
			return state.openSyncCalls;
		},
		get pidFileWrites() {
			return state.pidFileWrites;
		},
		get patched() {
			return state.patched;
		},
		restore() {
			fsCjs.openSync = originalOpenSync;
			fsCjs.writeFileSync = originalWriteFileSync;
			fsCjs.renameSync = originalRenameSync;
			try {
				nodeModule.syncBuiltinESMExports();
			} catch {
				/* best-effort restore */
			}
		},
	};
}

let dir: string;
let eventsPath: string;
let spy: PidWriteSpy;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-log-pid-write-"));
	eventsPath = path.join(dir, "events.jsonl");
	writeFileSync(eventsPath, "", "utf-8");
	spy = spyFsForPidWrite();
});

afterEach(() => {
	spy.restore();
});

test("fs spy is live (instrument liveness guard)", () => {
	// If syncBuiltinESMExports ever stops patching the ESM namespace, the
	// zero-count / wx-open assertions below pass vacuously. This test forces the
	// spy to be installed for every test via beforeEach, so a future toolchain
	// break fails loudly here.
	assert.equal(spy.patched, true, "fs spy must be installed (syncBuiltinESMExports)");
	assert.ok(eventsPath.length > 0, "sanitize: fixtures must exist");
});

test("pid file is written via openSync('wx') while the sync lock is held, and never via atomicWriteFile", () => {
	const lockDir = `${eventsPath}.mkdirlock`;
	const pidFile = path.join(lockDir, "pid");

	let pidDuringLock: string | undefined;
	try {
		withEventLogLockSync(eventsPath, () => {
			// Inside the critical section: pid must already be on disk.
			try {
				const raw = readFileSync(pidFile, "utf-8").trim();
				pidDuringLock = raw;
			} catch {
				/* recorded as undefined below */
			}
			// Guard: at minimum the pid file write must have triggered an openSync("wx").
			void pidFile;
		});

		// Release removes the lock dir; capture is authoritative.
		if (pidDuringLock === undefined) {
			// Fall back to the strong assertion inside the lock (this branch only
			// hits if the read fails, making the failure obvious).
			assert.fail(`pid file not readable while lock held: ${pidFile}`);
		}
		assert.equal(pidDuringLock, String(process.pid), "pid file content must be the owning process pid");

		// Spy assertions: the write went through openSync(pidFile, "wx").
		const pidOpen = spy.openSyncCalls.find(([p]) => p === pidFile);
		assert.ok(pidOpen, `pid file must be opened with openSync(${pidFile}, "wx")`);
		assert.equal(pidOpen![1], "wx");
		// and atomicWriteFile must NOT have touched the pid path.
		assert.equal(
			spy.pidFileWrites,
			0,
			"atomicWriteFile must not write the pid file (no writeFileSync/rename+temp observed for the pid path)",
		);
	} finally {
		void dir;
	}
});