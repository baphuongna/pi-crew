/**
 * crew-broker-lock-busy-retry.test.ts — Table-driven unit tests for the
 * run.lock busy-retry degradation (src/runtime/broker/protocol/lock-busy.ts).
 *
 * RR-023 F4 contract (module level; the CrewBroker-class behavior is pinned
 * separately in crew-broker-lock-contention.test.ts):
 *  1. isRunLockBusyError classifies ONLY the exact locks.ts busy identity
 *     (`Run '<basename>' is locked by another operation.`) — anchored, exact.
 *  2. Any NON-busy error propagates unchanged after exactly one attempt.
 *  3. A persistently busy lock exhausts the delay schedule and answers the
 *     typed {ok:false} degradation — never throws, never retries forever.
 *  4. The default schedule is pinned ([50,100,200,400,800]).
 *  5. A holder that releases mid-schedule is absorbed: fn runs exactly once
 *     and the outcome is {ok:true} with the body's value.
 *
 * The live cross-process holder is simulated exactly the way production sees
 * it (same discipline as crew-broker-lock-contention.test.ts): a FRESH
 * run.lock file carrying an ALIVE pid. The sync acquire path uses
 * treatOwnPidAsStealable=false, so the holder is never stolen.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	DEFAULT_LOCK_BUSY_RETRY_DELAYS_MS,
	isRunLockBusyError,
	withRunLockBusyRetry,
} from "../../../../src/runtime/broker/protocol/lock-busy.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

/** withRunLockSync only consumes manifest.stateRoot (lockPath derivation). */
function stateRootManifest(dir: string): TeamRunManifest {
	return { stateRoot: dir } as unknown as TeamRunManifest;
}

/** Fresh run.lock with an ALIVE pid + unknown-to-this-process token: the
 *  exact on-disk shape a live cross-process holder leaves behind. */
function writeLiveLock(stateRoot: string): void {
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.writeFileSync(
		path.join(stateRoot, "run.lock"),
		JSON.stringify({ kind: "run", pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() }),
	);
}

function tempStateRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// isRunLockBusyError — message-identity classification
// ---------------------------------------------------------------------------

test("isRunLockBusyError matches only the exact locks.ts busy identity (table)", () => {
	const accept = ["Run 'run.lock' is locked by another operation.", "Run 'anything.lock' is locked by another operation."];
	for (const message of accept) {
		assert.equal(isRunLockBusyError(new Error(message)), true, `must classify: ${message}`);
	}
	const reject = [
		"Run 'run.lock' is locked by another operation", // missing trailing period
		"Run 'run.lock' is locked by another operation. extra", // trailing garbage
		"prefix: Run 'run.lock' is locked by another operation.", // leading garbage (^ anchored)
		"run 'run.lock' is locked by another operation.", // lowercase r
		"Run '' is locked by another operation.", // empty basename ([^']+ needs >=1)
		"Run 'run.lock' is locked by another process.", // different wording
		"EBUSY: resource busy", // generic OS error
		"",
	];
	for (const message of reject) {
		assert.equal(isRunLockBusyError(new Error(message)), false, `must NOT classify: ${JSON.stringify(message)}`);
	}
});

test("isRunLockBusyError rejects non-Error throwables", () => {
	for (const bad of [
		undefined,
		null,
		"Run 'x' is locked by another operation.",
		{ message: "Run 'x' is locked by another operation." },
	]) {
		assert.equal(isRunLockBusyError(bad), false);
	}
});

test("DEFAULT_LOCK_BUSY_RETRY_DELAYS_MS schedule is pinned", () => {
	assert.deepEqual(DEFAULT_LOCK_BUSY_RETRY_DELAYS_MS, [50, 100, 200, 400, 800]);
});

// ---------------------------------------------------------------------------
// withRunLockBusyRetry — outcome table
// ---------------------------------------------------------------------------

test("withRunLockBusyRetry: uncontended body succeeds on the first attempt", async () => {
	const stateRoot = tempStateRoot("pi-crew-lb-ok-");
	try {
		let runs = 0;
		const outcome = await withRunLockBusyRetry(stateRootManifest(stateRoot), [10], () => {
			runs += 1;
			return "value-1";
		});
		assert.deepEqual(outcome, { ok: true, value: "value-1" });
		assert.equal(runs, 1);
		assert.equal(fs.existsSync(path.join(stateRoot, "run.lock")), false, "lock must be released after the body");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("withRunLockBusyRetry: NON-busy errors propagate immediately (single attempt)", async () => {
	const stateRoot = tempStateRoot("pi-crew-lb-boom-");
	try {
		let attempts = 0;
		await assert.rejects(
			withRunLockBusyRetry(stateRootManifest(stateRoot), [10, 10, 10], () => {
				attempts += 1;
				throw new Error("real fault — must not be retried");
			}),
			/real fault/,
		);
		assert.equal(attempts, 1, "no retry budget spent on a non-busy error");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("withRunLockBusyRetry: persistently busy lock exhausts the schedule → typed degradation", async () => {
	const stateRoot = tempStateRoot("pi-crew-lb-busy-");
	try {
		writeLiveLock(stateRoot);
		let runs = 0;
		const startedAt = Date.now();
		const outcome = await withRunLockBusyRetry(stateRootManifest(stateRoot), [5, 5], () => {
			runs += 1;
			return "never";
		});
		// 3 acquire attempts (initial + after each of the 2 delays), then the
		// undefined delay terminates with the typed busy degradation.
		assert.deepEqual(outcome, {
			ok: false,
			message: "run.lock busy (bounded retry budget exhausted): Run 'run.lock' is locked by another operation.",
		});
		assert.equal(runs, 0, "the body never ran while the holder was live");
		assert.ok(Date.now() - startedAt >= 10, "the delay schedule was actually awaited");
		assert.equal(fs.existsSync(path.join(stateRoot, "run.lock")), true, "the live holder's lock is left untouched (never stolen)");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("withRunLockBusyRetry: holder releasing mid-schedule is absorbed (fn runs exactly once)", async () => {
	const stateRoot = tempStateRoot("pi-crew-lb-release-");
	try {
		writeLiveLock(stateRoot);
		// Holder releases 15ms in; the single 40ms delay outlives the hold.
		const releaseTimer = setTimeout(() => fs.rmSync(path.join(stateRoot, "run.lock"), { force: true }), 15);
		let runs = 0;
		const outcome = await withRunLockBusyRetry(stateRootManifest(stateRoot), [40], () => {
			runs += 1;
			return 42;
		});
		clearTimeout(releaseTimer);
		assert.deepEqual(outcome, { ok: true, value: 42 });
		assert.equal(runs, 1, "retry re-attempted the acquire, not a partially-run body");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("withRunLockBusyRetry: empty delay schedule degrades after the first busy attempt", async () => {
	const stateRoot = tempStateRoot("pi-crew-lb-empty-");
	try {
		writeLiveLock(stateRoot);
		const outcome = await withRunLockBusyRetry(stateRootManifest(stateRoot), [], () => "never");
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.match(outcome.message, /bounded retry budget exhausted/);
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
