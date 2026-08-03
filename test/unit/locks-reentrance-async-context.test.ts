/**
 * ST-14 regression test — withFileLockSync re-entrance guard is per-async-context.
 *
 * Prior to this fix, withFileLockSync used the process-global fileLockHeldByUs
 * map for re-entrance detection (same bug class as H-1, already fixed for
 * withRunLockSync). A re-entrance hit/miss decision made in one async context
 * could leak into another, causing incorrect lock elision.
 *
 * After the fix, re-entrance is tracked via AsyncLocalStorage (fileLockSyncCtx)
 * scoped to the current async context. A call from a DIFFERENT async context
 * no longer sees the held set — it acquires the on-disk lock normally.
 *
 * This test verifies:
 *   1. True nested call in the SAME async context still bypasses (no deadlock).
 *   2. A call from a DIFFERENT async context does NOT bypass — each context
 *      independently acquires the on-disk .flock lock.
 *   3. ST-3 cross-tier coordination is preserved: withFileLockAsync holding
 *      the .flock causes withFileLockSync (from any context) to bypass via
 *      fileLockHeldByUs (deadlock prevention).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { withFileLockAsync, withFileLockSync } from "../../src/state/coordination/locks.ts";

function mkTmp(): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st14-reentrance-"));
	return {
		dir,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

/**
 * Run a synchronous callback in a fresh async context. Each `setTimeout`
 * callback executes in a distinct async resource, so two callbacks scheduled
 * separately do NOT share AsyncLocalStorage state.
 */
function runInNewAsyncContext<T>(fn: () => T): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		setTimeout(() => {
			try {
				resolve(fn());
			} catch (error) {
				reject(error);
			}
		}, 0);
	});
}

test("ST-14: nested withFileLockSync in the SAME async context bypasses (re-entrance preserved)", async () => {
	const { dir, cleanup } = mkTmp();
	try {
		const target = path.join(dir, "same-ctx.json");
		const flockPath = `${target}.flock`;
		let innerFlockExisted = false;

		// Run in a distinct async context to avoid any interference from the
		// test runner's context.
		const result = await runInNewAsyncContext(() =>
			withFileLockSync(
				target,
				() => {
					// Nested call in the SAME async context — must bypass.
					// If it tried to re-acquire, it would EEXIST on its own lock.
					return withFileLockSync(
						target,
						() => {
							innerFlockExisted = fs.existsSync(flockPath);
							return "inner-ok";
						},
						{ staleMs: 1000 },
					);
				},
				{ staleMs: 1000 },
			),
		);

		assert.equal(result, "inner-ok");
		assert.ok(innerFlockExisted, "flock must exist during re-entrant inner call");
		assert.ok(!fs.existsSync(flockPath), "flock cleaned up after release");
	} finally {
		cleanup();
	}
});

test("ST-14: re-entrance in one async context does NOT elide the lock in another", async () => {
	const { dir, cleanup } = mkTmp();
	try {
		const target = path.join(dir, "cross-ctx.json");
		const flockPath = `${target}.flock`;
		let acquiredA = false;
		let acquiredB = false;
		let flockDuringA = false;
		let flockDuringB = false;

		// Context A: acquire the lock in one async context.
		await runInNewAsyncContext(() => {
			const r = withFileLockSync(
				target,
				() => {
					flockDuringA = fs.existsSync(flockPath);
					acquiredA = true;
					return "a";
				},
				{ staleMs: 1000 },
			);
			assert.equal(r, "a");
		});

		// Lock must be released after context A.
		assert.ok(!fs.existsSync(flockPath), "flock released after context A");

		// Context B: acquire the SAME lock from a DIFFERENT async context.
		// Re-entrance from context A must NOT leak — context B must acquire
		// independently (not bypass).
		await runInNewAsyncContext(() => {
			const r = withFileLockSync(
				target,
				() => {
					flockDuringB = fs.existsSync(flockPath);
					acquiredB = true;
					return "b";
				},
				{ staleMs: 1000 },
			);
			assert.equal(r, "b");
		});

		assert.ok(acquiredA, "context A must have entered the critical section");
		assert.ok(acquiredB, "context B must have entered the critical section");
		assert.ok(flockDuringA, "context A: flock must exist during CS (proves real acquisition)");
		assert.ok(flockDuringB, "context B: flock must exist during CS (proves real acquisition)");
		assert.ok(!fs.existsSync(flockPath), "flock released after context B");
	} finally {
		cleanup();
	}
});

test("ST-14: concurrent async contexts both independently acquire (parallel setTimeout)", async () => {
	const { dir, cleanup } = mkTmp();
	try {
		const target = path.join(dir, "concurrent.json");
		const flockPath = `${target}.flock`;
		const acquisitions: string[] = [];

		// Launch two withFileLockSync calls from two independent async contexts.
		// setTimeout callbacks fire sequentially (withFileLockSync is synchronous),
		// but they have distinct AsyncLocalStorage contexts — so re-entrance
		// tracking from one must NOT leak to the other.
		const p1 = runInNewAsyncContext(() => {
			return withFileLockSync(
				target,
				() => {
					assert.ok(fs.existsSync(flockPath), "ctx 1: flock must exist");
					acquisitions.push("ctx1");
					return "r1";
				},
				{ staleMs: 1000 },
			);
		});

		const p2 = runInNewAsyncContext(() => {
			return withFileLockSync(
				target,
				() => {
					assert.ok(fs.existsSync(flockPath), "ctx 2: flock must exist");
					acquisitions.push("ctx2");
					return "r2";
				},
				{ staleMs: 1000 },
			);
		});

		const [r1, r2] = await Promise.all([p1, p2]);

		assert.equal(r1, "r1");
		assert.equal(r2, "r2");
		assert.equal(acquisitions.length, 2, "both contexts must have acquired the lock");
		assert.ok(!fs.existsSync(flockPath), "flock released after both");
	} finally {
		cleanup();
	}
});

test("ST-14: ST-3 cross-tier bypass preserved — withFileLockAsync hold elides withFileLockSync", async () => {
	const { dir, cleanup } = mkTmp();
	try {
		const target = path.join(dir, "cross-tier.json");
		const flockPath = `${target}.flock`;
		let releaseAsync: (() => void) | undefined;
		const asyncReleased = new Promise<void>((resolve) => {
			releaseAsync = resolve;
		});
		let syncBypassed = false;

		// Context A: withFileLockAsync acquires the on-disk .flock and YIELDS.
		// This sets fileLockHeldByUs (process-global, cross-tier coordination).
		const asyncPromise = withFileLockAsync(target, async () => {
			// Yield so a sync caller from another context can interleave.
			await new Promise<void>((resolve) => setImmediate(resolve));
			// Wait for the test to release us.
			await asyncReleased;
			return "async-done";
		});

		// Let the async holder acquire and yield.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		// Verify the async holder has the on-disk .flock.
		assert.ok(fs.existsSync(flockPath), "async holder must have .flock on disk");

		// Context B: withFileLockSync from a DIFFERENT async context (setTimeout).
		// With the ST-3 cross-tier bypass, this should bypass via fileLockHeldByUs
		// (the async holder set it) — NOT deadlock on the on-disk lock.
		// This proves the cross-tier coordination is preserved after ST-14.
		await runInNewAsyncContext(() => {
			withFileLockSync(
				target,
				() => {
					syncBypassed = true;
					return "sync-ok";
				},
				{ staleMs: 1000 },
			);
		});

		assert.ok(syncBypassed, "withFileLockSync must bypass when withFileLockAsync holds (cross-tier)");

		// Release the async holder and verify clean completion.
		releaseAsync!();
		const asyncResult = await asyncPromise;
		assert.equal(asyncResult, "async-done");
		assert.ok(!fs.existsSync(flockPath), "flock released after async holder exits");
	} finally {
		cleanup();
	}
});
