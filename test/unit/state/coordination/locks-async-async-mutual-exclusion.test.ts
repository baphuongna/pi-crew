import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { withFileLockAsync } from "../../../../src/state/coordination/locks.ts";

/**
 * ST-3-FIX regression test.
 *
 * THE BUG: withFileLockAsync's cross-tier bypass checked
 * `fileLockHeldByUs.has(lockFile)`, but withFileLockAsync ALSO registers itself
 * in `fileLockHeldByUs` when it acquires the on-disk .flock. So a SECOND
 * concurrent ASYNC caller for the same file saw the FIRST async caller's hold
 * and bypassed BOTH the in-process promise chain AND the on-disk lock → the two
 * critical sections ran simultaneously (async↔async mutual exclusion broken).
 *
 * THE FIX: withFileLockAsync's bypass now consults `fileSyncLockHeldByUs`
 * (SYNC-only set). A concurrent async caller no longer sees another async
 * caller's hold, so it properly serializes via the promise chain + on-disk
 * .flock. Sync↔async deadlock prevention is preserved (async still bypasses when
 * a SYNC lock is held).
 *
 * DETERMINISM NOTE: we gate caller 2 on caller 1 having ENTERED its critical
 * section (via a deferred). This is the exact window where the pre-fix bypass
 * fired — caller 1 has set `fileLockHeldByUs` while awaiting inside `fn()`. A
 * naive `Promise.all([a, b])` without the gate may or may not catch the bug
 * depending on microtask scheduling, so we make it explicit.
 */

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("ST-3-FIX: two concurrent withFileLockAsync callers for the SAME file are mutually excluded", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-async-mutex-"));
	const target = path.join(cwd, "mailbox.json");

	// Track how many critical sections run simultaneously.
	let current = 0;
	let maxConcurrent = 0;
	const order: string[] = [];

	const aEntered = createDeferred<void>();

	const critical = async (label: string): Promise<string> => {
		current++;
		maxConcurrent = Math.max(maxConcurrent, current);
		order.push(`${label}-enter`);
		if (label === "a") aEntered.resolve();
		// Hold the critical section long enough that, without mutual exclusion,
		// the second caller would overlap the first.
		await sleep(40);
		order.push(`${label}-exit`);
		current--;
		return label;
	};

	// Fire caller 1 and wait until it is INSIDE its critical section.
	const p1 = withFileLockAsync(target, () => critical("a"));
	await aEntered.promise;

	// NOW fire caller 2 while caller 1 is still holding the lock. Before the
	// fix, caller 2's preamble saw fileLockHeldByUs.has(lockFile)=true and
	// bypassed everything → critical("b") ran concurrently with critical("a").
	const p2 = withFileLockAsync(target, () => critical("b"));

	const [a, b] = await Promise.all([p1, p2]);

	assert.equal(a, "a");
	assert.equal(b, "b");
	// Core assertion: the two critical sections never overlapped.
	assert.equal(maxConcurrent, 1, `async↔async mutual exclusion must hold — maxConcurrent should be 1, got ${maxConcurrent}`);
	// Sanity: enter/exit pairs are contiguous (no interleaving).
	const joined = order.join(",");
	assert.ok(joined === "a-enter,a-exit,b-enter,b-exit", `critical sections must not interleave, got: ${joined}`);

	fs.rmSync(cwd, { recursive: true, force: true });
});

test("ST-3-FIX: three concurrent withFileLockAsync callers for the SAME file are serialized", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-async-mutex3-"));
	const target = path.join(cwd, "shared.json");

	let current = 0;
	let maxConcurrent = 0;
	const entered: string[] = [];

	const firstEntered = createDeferred<void>();

	const critical = async (label: string): Promise<string> => {
		current++;
		maxConcurrent = Math.max(maxConcurrent, current);
		entered.push(label);
		if (label === "first") firstEntered.resolve();
		await sleep(25);
		current--;
		return label;
	};

	// Fire the first caller and gate the rest on it entering the critical section.
	const p1 = withFileLockAsync(target, () => critical("first"));
	await firstEntered.promise;
	// Fire two more concurrently while the first holds the lock.
	const p2 = withFileLockAsync(target, () => critical("second"));
	const p3 = withFileLockAsync(target, () => critical("third"));

	const results = await Promise.all([p1, p2, p3]);

	assert.deepEqual(results.sort(), ["first", "second", "third"]);
	assert.equal(
		maxConcurrent,
		1,
		`async↔async mutual exclusion must hold for 3 callers — maxConcurrent should be 1, got ${maxConcurrent}`,
	);

	fs.rmSync(cwd, { recursive: true, force: true });
});
