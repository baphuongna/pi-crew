/**
 * RR-011 (F02) regression tests — withRunLock async↔async mutual exclusion.
 *
 * THE BUG (verified 2026-09-17, docs/archive/2026-09-17-pi-crew-review-verification.md §4 F02):
 * `acquireLockWithRetryAsync` read the lock snapshot with `treatOwnPidAsStealable: true`,
 * so a SECOND independent async context in the same process could STEAL a lock whose
 * holder was alive and merely awaiting inside its critical section. `holderPid ===
 * process.pid` cannot distinguish (a) a leftover lock file from a finished
 * acquisition — the case the flag was added for (CI flake in parallel-research
 * scaffold mode) — from (b) a lock CURRENTLY HELD by another async context of this
 * process. Probe evidence: `MAX CONCURRENT HOLDERS = 2`; the token changed while A
 * still held; after A exited first the lock file was already gone (ENOENT) while B
 * was still inside its critical section. Real caller:
 * src/runtime/task-runner/post-execution.ts:626-629.
 *
 * Scope correction (verification C2): sync↔sync and sync↔async are correct; ONLY
 * async↔async (`withRunLock` vs `withRunLock`) was broken. round30-h1 covers
 * sync-vs-async; locks-async-async-mutual-exclusion.test.ts covers the FILE lock
 * family (`withFileLockAsync`) — this file covers the previously untested broken
 * combination.
 *
 * DETERMINISM NOTE (same as locks-async-async-mutual-exclusion.test.ts): caller 2
 * is gated on caller 1 having ENTERED its critical section via a deferred. A naive
 * `Promise.all` may or may not reproduce the bug depending on microtask scheduling.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { withRunLock, withRunLockSync } from "../../../../src/state/coordination/locks.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

function mkTmp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkManifest(stateRoot: string): TeamRunManifest {
	return {
		runId: "rr011-f02",
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

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStoredToken(lockFile: string): string | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockFile, "utf-8")) as { token?: unknown };
		return typeof parsed.token === "string" ? parsed.token : undefined;
	} catch {
		return undefined;
	}
}

function writeFakeLock(lockFile: string, payload: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
	fs.writeFileSync(lockFile, JSON.stringify(payload), "utf-8");
}

/** Poll `predicate` until true or `timeoutMs` elapses (child-process readiness gate). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await sleep(10);
	}
}

test("AC1: two independent async contexts are mutually excluded (maxActive === 1)", async () => {
	const dir = mkTmp("pi-crew-rr011-mutex-");
	try {
		const manifest = mkManifest(dir);
		let active = 0;
		let maxActive = 0;
		const order: string[] = [];
		const aEntered = createDeferred<void>();

		const p1 = withRunLock(manifest, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			order.push("a-enter");
			aEntered.resolve();
			// Hold long enough that, without mutual exclusion, the second caller
			// (which steals after ~25ms of retry backoff pre-fix) overlaps deterministically.
			await sleep(60);
			order.push("a-exit");
			active--;
			return "a";
		});
		// B is an INDEPENDENT top-level async context (the test's own context) —
		// NOT nested inside A. Fire it only once A is INSIDE its critical section.
		await aEntered.promise;
		const p2 = withRunLock(manifest, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			order.push("b-enter");
			await sleep(10);
			order.push("b-exit");
			active--;
			return "b";
		});

		const [a, b] = await Promise.all([p1, p2]);

		assert.equal(a, "a");
		assert.equal(b, "b");
		assert.equal(maxActive, 1, `async↔async mutual exclusion must hold — maxActive should be 1, got ${maxActive}`);
		assert.equal(
			order.join(","),
			"a-enter,a-exit,b-enter,b-exit",
			`critical sections must not interleave (B enters only after A releases), got: ${order.join(",")}`,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("AC2: no lost update — read-modify-write counter under two contending async contexts", async () => {
	const dir = mkTmp("pi-crew-rr011-lostupdate-");
	try {
		const manifest = mkManifest(dir);
		const counterFile = path.join(dir, "counter.json");
		fs.writeFileSync(counterFile, "0", "utf-8");
		const aEntered = createDeferred<void>();

		// Each critical section does a read-modify-write of a shared file. The
		// read→write gap (80ms) is deliberately wide so an overlapped writer
		// provably loses its update (deterministic in both RED and GREEN).
		const rmw = async (): Promise<void> => {
			const value = Number(fs.readFileSync(counterFile, "utf-8"));
			await sleep(80);
			fs.writeFileSync(counterFile, String(value + 1), "utf-8");
		};

		const p1 = withRunLock(manifest, async () => {
			aEntered.resolve();
			await rmw();
			return "a";
		});
		await aEntered.promise;
		const p2 = withRunLock(manifest, async () => {
			await rmw();
			return "b";
		});

		await Promise.all([p1, p2]);

		const final = Number(fs.readFileSync(counterFile, "utf-8"));
		assert.equal(final, 2, `both increments must be persisted (no lost update) — expected 2, got ${final}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("AC5: a finishing context does not delete another live holder's lock file", async () => {
	const dir = mkTmp("pi-crew-rr011-release-");
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");
		const aEntered = createDeferred<void>();
		const releaseA = createDeferred<void>();
		const bEntered = createDeferred<void>();
		const releaseB = createDeferred<void>();
		let lockFileExistsInsideB = false;

		const p1 = withRunLock(manifest, async () => {
			aEntered.resolve();
			await releaseA.promise;
			return "a";
		});
		await aEntered.promise;

		const p2 = withRunLock(manifest, async () => {
			bEntered.resolve();
			lockFileExistsInsideB = fs.existsSync(lockFile);
			await releaseB.promise;
			return "b";
		});

		// Let B contend while A holds (B must WAIT — F02 fix), then release A first.
		await sleep(60);
		releaseA.resolve();
		await p1;
		// A's finally has fully run. B now holds (or is about to hold) the lock —
		// the file MUST still exist. Pre-fix, A's PID-based releaseOwnLock deleted
		// B's lock here (verification probe 2: ENOENT while B still in its CS).
		await bEntered.promise;
		assert.equal(fs.existsSync(lockFile), true, "lock file must exist while B is inside its critical section");
		assert.equal(lockFileExistsInsideB, true, "lock file must exist at the moment B entered its critical section");

		releaseB.resolve();
		await p2;
		assert.equal(fs.existsSync(lockFile), false, "lock file removed only after the last holder exits");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("AC3: same-context re-entrance still bypasses and never releases the lock early", async () => {
	const dir = mkTmp("pi-crew-rr011-reentrance-");
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");
		let innerAsync = "";
		let innerSync = "";
		let lockExistsAfterInner = false;

		const result = await withRunLock(manifest, async () => {
			// Nested async call in the SAME async context → must bypass (no deadlock).
			innerAsync = await withRunLock(manifest, async () => "inner-async-ok");
			// Nested sync call in the SAME async context → must bypass (H-1 path).
			innerSync = withRunLockSync(manifest, () => "inner-sync-ok");
			// The nested bypass calls must NOT have released the outer hold.
			lockExistsAfterInner = fs.existsSync(lockFile);
			return "outer-ok";
		});

		assert.equal(innerAsync, "inner-async-ok");
		assert.equal(innerSync, "inner-sync-ok");
		assert.equal(result, "outer-ok");
		assert.equal(lockExistsAfterInner, true, "outer acquisition must still hold the lock after nested bypass calls return");
		assert.equal(fs.existsSync(lockFile), false, "lock released only after the outermost acquisition finishes");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("AC6: throwing fn() releases the lock; the original error propagates; next acquire succeeds", async () => {
	const dir = mkTmp("pi-crew-rr011-errrelease-");
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");

		await assert.rejects(
			() =>
				withRunLock(manifest, async () => {
					await sleep(10);
					throw new Error("ac6-boom");
				}),
			{ message: "ac6-boom" },
		);
		assert.equal(fs.existsSync(lockFile), false, "lock file released after fn() throws");

		const next = await withRunLock(manifest, async () => "next-ok");
		assert.equal(next, "next-ok", "next acquisition must succeed after an errored holder released");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("AC7: steal still works for dead / stale / legacy / corpse holders (own-pid steal preserved)", async () => {
	// (a) Dead foreign pid (crashed holder) → stealable.
	{
		const dir = mkTmp("pi-crew-rr011-steal-dead-");
		try {
			const manifest = mkManifest(dir);
			writeFakeLock(path.join(dir, "run.lock"), {
				kind: "run",
				pid: 99999,
				createdAt: new Date().toISOString(),
				token: "dead-holder-token",
			});
			const r = await withRunLock(manifest, async () => "dead-ok");
			assert.equal(r, "dead-ok");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	// (b) Stale (old createdAt) with OUR pid and a token not held live → steal
	// (staleMs backstop must keep working for hung in-process holders).
	{
		const dir = mkTmp("pi-crew-rr011-steal-stale-");
		try {
			const manifest = mkManifest(dir);
			writeFakeLock(path.join(dir, "run.lock"), {
				kind: "run",
				pid: process.pid,
				createdAt: new Date(Date.now() - 100_000).toISOString(),
				token: "stale-own-token",
			});
			const r = await withRunLock(manifest, async () => "stale-own-ok");
			assert.equal(r, "stale-own-ok");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	// (c) LEGACY token-less payload with OUR pid, fresh → STILL stealable.
	// This preserves the anti-CI-flake behaviour that motivated
	// treatOwnPidAsStealable (old releases wrote {pid, createdAt} with no token).
	{
		const dir = mkTmp("pi-crew-rr011-steal-legacy-");
		try {
			const manifest = mkManifest(dir);
			writeFakeLock(path.join(dir, "run.lock"), {
				pid: process.pid,
				createdAt: new Date().toISOString(),
			});
			const r = await withRunLock(manifest, async () => "legacy-ok");
			assert.equal(r, "legacy-ok", "legacy token-less lock files must remain stealable (CI-flake fix)");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	// (d) Fresh lock with OUR pid whose token is NOT held live in-process (a
	// corpse from a raced/superseded release) → stealable. Guards against the
	// held-token set over-blocking: only tokens of LIVE acquisitions block steals.
	{
		const dir = mkTmp("pi-crew-rr011-steal-corpse-");
		try {
			const manifest = mkManifest(dir);
			writeFakeLock(path.join(dir, "run.lock"), {
				kind: "run",
				pid: process.pid,
				createdAt: new Date().toISOString(),
				token: "corpse-token-never-held-in-process",
			});
			const r = await withRunLock(manifest, async () => "corpse-ok");
			assert.equal(r, "corpse-ok", "a fresh own-pid lock whose token is not live must be stealable (no leaked-set blocking)");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("AC8: a real second process holding the lock blocks this process (`locked`), and a dead holder is recovered", async () => {
	const dir = mkTmp("pi-crew-rr011-crossproc-");
	let child: ChildProcess | undefined;
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");
		const readyFile = path.join(dir, "child-ready");

		// Real child process takes the lock (genuine on-disk format) and stays alive.
		child = spawn(
			process.execPath,
			[
				"-e",
				[
					'const fs = require("node:fs");',
					"const lockFile = process.argv[1];",
					"const ready = process.argv[2];",
					'fs.writeFileSync(lockFile, JSON.stringify({ kind: "run", pid: process.pid, createdAt: new Date().toISOString(), token: "child-holder-token" }));',
					'fs.writeFileSync(ready, "1");',
					"setInterval(() => {}, 1000); // stay alive until killed",
				].join("\n"),
				lockFile,
				readyFile,
			],
			{ stdio: "ignore" },
		);
		await waitFor(() => fs.existsSync(readyFile));

		// While a DIFFERENT live process holds the lock, this process's async
		// acquire must fail with `locked` — cross-process behaviour unchanged.
		await assert.rejects(() => withRunLock(manifest, async () => "must-not-run"), /locked/);

		// Kill the holder; its lock file remains (dead holder) → steal recovers.
		const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;

		const r = await withRunLock(manifest, async () => "recovered-ok");
		assert.equal(r, "recovered-ok", "dead cross-process holder must be steal-recoverable");
	} finally {
		child?.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("AC9 (CI-flake canary): 50 sequential acquisitions in one process never surface a spurious `locked`", async () => {
	const dir = mkTmp("pi-crew-rr011-canary-");
	try {
		const manifest = mkManifest(dir);
		const N = 50;
		for (let i = 0; i < N; i++) {
			// Sequential acquire → release → acquire on the same manifest is the
			// parallel-research scaffold-mode shape the treatOwnPidAsStealable
			// flag was added for; it must keep working after RR-011.
			const r = await withRunLock(manifest, async () => i);
			assert.equal(r, i, `sequential acquisition #${i} must succeed without a spurious 'locked' error`);
		}
		assert.equal(fs.existsSync(path.join(dir, "run.lock")), false, "no lock file leaked after the sequence");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("AC10: distinct holder identity is observable on disk; release removes only the matching lock", async () => {
	const dir = mkTmp("pi-crew-rr011-tokens-");
	try {
		const manifest = mkManifest(dir);
		const lockFile = path.join(dir, "run.lock");
		const tokens: (string | undefined)[] = [];
		const aEntered = createDeferred<void>();
		const releaseA = createDeferred<void>();
		const bEntered = createDeferred<void>();
		const releaseB = createDeferred<void>();

		const p1 = withRunLock(manifest, async () => {
			tokens.push(readStoredToken(lockFile));
			aEntered.resolve();
			await releaseA.promise;
			return "a";
		});
		await aEntered.promise;
		const p2 = withRunLock(manifest, async () => {
			tokens.push(readStoredToken(lockFile));
			bEntered.resolve();
			await releaseB.promise;
			return "b";
		});

		await sleep(60);
		releaseA.resolve();
		await p1;
		// B must now be the holder: the on-disk lock carries B's token, not A's,
		// and it still exists (A's release did not touch it).
		await bEntered.promise;
		const tokenWhileBHolds = readStoredToken(lockFile);
		releaseB.resolve();
		await p2;

		assert.equal(tokens.length, 2);
		assert.ok(tokens[0] && tokens[1], `both critical sections must observe a token on disk: ${JSON.stringify(tokens)}`);
		assert.notEqual(tokens[0], tokens[1], "the two acquisitions must be distinguishable (different tokens)");
		assert.equal(tokenWhileBHolds, tokens[1], "lock file during B's critical section carries B's token");
		assert.notEqual(tokenWhileBHolds, tokens[0], "A's exit must not have replaced or removed B's ownership");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
