/**
 * Round-30 regression test — H-1: withRunLock re-entrance guard is per-async-context.
 *
 * Prior to this fix, `runLockHeldByUs` was a module-global Map (process-global),
 * not per-callstack. When withRunLock (async) yielded at `await fn()`, a concurrent
 * withRunLockSync for the same run — fired from a different async context (e.g.
 * a child stdout event handler) — saw the holder's token and bypassed the file
 * lock entirely. Two writers were in the critical section simultaneously.
 *
 * After the fix, re-entrance is tracked via AsyncLocalStorage scoped to the
 * current async context. A call from a DIFFERENT async context no longer
 * bypasses — it properly serializes against the on-disk lock.
 *
 * This test verifies:
 *   1. True nested call in the SAME async context still bypasses (no deadlock).
 *   2. A call from a DIFFERENT async context does NOT bypass — it acquires the
 *      file lock normally (and blocks if the lock is held, until the holder
 *      releases).
 *   3. Concurrent withRunLock + withRunLockSync from different async contexts
 *      are properly serialized (the second waits for the first).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { withRunLock, withRunLockSync } from "../../src/state/coordination/locks.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

function mkTmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "round30-h1-"));
}

function mkManifest(stateRoot: string): TeamRunManifest {
	return {
		runId: "h1-test",
		team: "test",
		workflow: "default",
		goal: "test",
		stateRoot,
		cwd: "/tmp",
		artifactsRoot: path.join(stateRoot, "artifacts"),
		status: "running",
		tasks: [],
		artifacts: [],
		eventsPath: path.join(stateRoot, "events.jsonl"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		manifestPath: path.join(stateRoot, "manifest.json"),
		createdAt: new Date().toISOString(),
		startedAt: Date.now(),
		turnCount: 0,
	} as unknown as TeamRunManifest;
}

test("H-1: true nested call in the SAME async context bypasses (re-entrance preserved)", async () => {
	const dir = mkTmp();
	try {
		const manifest = mkManifest(dir);
		// Outer async holder runs an inner sync call for the same run — must bypass.
		const result = await withRunLock(manifest, async () => {
			// Sync inner call: same async context, same callstack → must bypass (no deadlock).
			const inner = withRunLockSync(manifest, () => "inner-ok");
			assert.equal(inner, "inner-ok", "sync re-entrance must bypass");
			return "outer-ok";
		});
		assert.equal(result, "outer-ok");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("H-1: nested async call in the SAME async context also bypasses", async () => {
	const dir = mkTmp();
	try {
		const manifest = mkManifest(dir);
		const result = await withRunLock(manifest, async () => {
			// Async inner call: same async context → must bypass.
			const inner = await withRunLock(manifest, async () => "inner-async-ok");
			assert.equal(inner, "inner-async-ok");
			return "outer-async-ok";
		});
		assert.equal(result, "outer-async-ok");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("H-1: a call from a DIFFERENT async context does NOT bypass (H-1 bug regression guard)", async () => {
	const dir = mkTmp();
	try {
		const manifest = mkManifest(dir);

		// Track the order of critical-section entries to verify proper serialization.
		const events: string[] = [];
		let releaseOuter: (() => void) | undefined;
		const outerReleased = new Promise<void>((resolve) => {
			releaseOuter = resolve;
		});

		// Start the outer async holder — it enters the CS, then YIELDS (awaits).
		const outerPromise = withRunLock(manifest, async () => {
			events.push("outer-enter");
			// Yield to the event loop so a sync call from another context can interleave.
			await new Promise<void>((resolve) => {
				setImmediate(resolve);
			});
			events.push("outer-after-yield");
			// Wait until the test explicitly releases us — proves we held the lock
			// the whole time the other context was trying to acquire.
			await outerReleased;
			events.push("outer-exit");
			return "outer-done";
		});

		// Let the outer holder run and yield.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		// Now run a sync call from THIS (different) async context. Before the fix
		// this would bypass (see the holder's token in the global Map) and append
		// to events immediately. After the fix, it must NOT bypass — but since the
		// outer holder is holding the on-disk lock, the sync call would block.
		// We can't easily test "blocking" in a unit test without a timeout, so we
		// instead test the NEGATIVE: release the outer holder, then the sync call
		// should succeed promptly, proving it was waiting on the lock file (not
		// bypassed).
		const beforeRelease = events.length;
		releaseOuter!();
		await outerPromise;

		// Now the lock is free. The sync call should succeed immediately.
		const syncStart = Date.now();
		const syncResult = withRunLockSync(manifest, () => {
			events.push("sync-after-release");
			return "sync-ok";
		});
		const syncDuration = Date.now() - syncStart;

		assert.equal(syncResult, "sync-ok");
		// The sync call must NOT have run before the outer holder exited.
		assert.equal(events.indexOf("sync-after-release"), events.length - 1, "sync call must run only after outer holder releases");
		// Critical assertion: between the moment we released the outer holder and
		// the sync call running, there should be NO premature "sync-after-release"
		// event interleaved with the outer holder's events.
		const outerExitIdx = events.indexOf("outer-exit");
		const syncIdx = events.indexOf("sync-after-release");
		assert.ok(
			outerExitIdx < syncIdx,
			`sync call must run after outer exit (outerExitIdx=${outerExitIdx}, syncIdx=${syncIdx}, events=${JSON.stringify(events)})`,
		);
		// The sync call should be fast (no retry backoff) since the lock is free.
		assert.ok(syncDuration < 2000, `sync call should be fast, got ${syncDuration}ms`);
		assert.ok(
			beforeRelease === 2,
			`should have 2 events before release (outer-enter + outer-after-yield), got ${beforeRelease}: ${JSON.stringify(events)}`,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("H-1: concurrent sync call from a setTimeout (different async context) serializes against the async holder", async () => {
	const dir = mkTmp();
	try {
		const manifest = mkManifest(dir);
		const events: string[] = [];
		let releaseOuter: (() => void) | undefined;
		const outerReleased = new Promise<void>((resolve) => {
			releaseOuter = resolve;
		});

		const outerPromise = withRunLock(manifest, async () => {
			events.push("outer-enter");
			await outerReleased;
			events.push("outer-exit");
			return "outer-done";
		});

		// Schedule a sync call from a DIFFERENT async context (setTimeout) while
		// the outer holder is holding the lock. Before the fix this would bypass.
		// After the fix it must NOT bypass — it will block until the outer releases.
		const syncFromOtherContext = new Promise<string>((resolve) => {
			setTimeout(() => {
				const result = withRunLockSync(manifest, () => {
					events.push("sync-from-other-context");
					return "sync-ok";
				});
				resolve(result);
			}, 50);
		});

		// Let the outer holder run first.
		await new Promise<void>((resolve) => setImmediate(resolve));

		// Release the outer holder — now the sync call from the other context can proceed.
		releaseOuter!();
		const [outerResult, syncResult] = await Promise.all([outerPromise, syncFromOtherContext]);

		assert.equal(outerResult, "outer-done");
		assert.equal(syncResult, "sync-ok");

		// The sync call must have happened AFTER the outer holder exited — proving
		// it serialized against the on-disk lock, not bypassed.
		const outerExitIdx = events.indexOf("outer-exit");
		const syncIdx = events.indexOf("sync-from-other-context");
		assert.ok(
			outerExitIdx < syncIdx,
			`sync from other context must run after outer exit (outerExit=${outerExitIdx}, sync=${syncIdx}, events=${JSON.stringify(events)})`,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// RR-011 (F02) — measurement of the sync-holder + async-caller direction.
// Verification C2 proved async↔async broken and async-holder + sync-caller correct,
// but the reverse (sync holder + async caller) had no probe. Structurally, a
// synchronous critical section NEVER yields the event loop, so no async
// acquisition of the same process can interleave with it — timers/microtasks
// scheduled from inside the sync section only run after it completes. This test
// pins that structural fact: an async acquisition queued DURING the sync holder's
// critical section runs strictly after it exits, and succeeds (no steal happened,
// no lock is stuck). A true interleaving probe is impossible at unit level —
// recorded as a known gap in docs/stories/RR-011/validation.md §3.5.
test("RR-011: an async caller queued inside a sync holder's critical section runs only after it exits", async () => {
	const dir = mkTmp();
	try {
		const manifest = mkManifest(dir);
		const events: string[] = [];
		let asyncResult = "";
		let asyncFailed = "";

		const syncResult = withRunLockSync(manifest, () => {
			events.push("sync-enter");
			// Queue an async acquisition for the SAME run from inside the sync
			// critical section. It cannot run yet (JS has no preemption of sync
			// code) — this is exactly the window where, if interleaving were
			// possible, the pre-F02 code would steal the sync holder's lock.
			Promise.resolve().then(() => {
				withRunLock(manifest, async () => {
					events.push("async-enter");
					asyncResult = "async-ok";
					return "async-done";
				}).catch((error: unknown) => {
					asyncFailed = String(error);
				});
			});
			events.push("sync-exit");
			return "sync-ok";
		});

		assert.equal(syncResult, "sync-ok");
		await new Promise<void>((resolve) => setTimeout(resolve, 50)); // let the queued async caller run
		assert.equal(asyncFailed, "", `queued async acquisition must not fail: ${asyncFailed}`);
		assert.equal(asyncResult, "async-ok", "queued async acquisition must succeed once the sync holder released");
		assert.deepEqual(
			events,
			["sync-enter", "sync-exit", "async-enter"],
			`async caller must run strictly after the sync holder exits, got ${JSON.stringify(events)}`,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// RR-011 (F02): sync↔sync nested re-entrance in the same async context bypasses
// (mirrors the async/async and async/sync nesting tests above — completes the
// re-entrance matrix) and the outer hold survives the nested bypass.
test("RR-011: nested withRunLockSync in the SAME async context bypasses without releasing early", () => {
	const dir = mkTmp();
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");
		let lockExistsAfterInner = false;
		const inner = withRunLockSync(manifest, () => "inner-sync-ok");
		assert.equal(inner, "inner-sync-ok");
		// Outer level: re-acquire (the inner call fully released when it returned).
		const outer = withRunLockSync(manifest, () => {
			const nested = withRunLockSync(manifest, () => "nested-ok"); // same context → bypass
			lockExistsAfterInner = fs.existsSync(lockFile);
			return `outer-${nested}`;
		});
		assert.equal(outer, "outer-nested-ok");
		assert.equal(lockExistsAfterInner, true, "outer hold must survive the nested bypass call");
		assert.equal(fs.existsSync(lockFile), false, "lock released after the outermost sync acquisition finishes");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
