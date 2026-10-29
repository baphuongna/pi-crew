/**
 * W6 (steal-rm-dual-holder) regression tests for src/state/coordination/locks.ts.
 *
 * The steal branch of acquireLockWithRetry / acquireLockWithRetryAsync used to
 * run `fs.rmSync(filePath, { force: true })` unconditionally after a
 * single-snapshot verdict: a contender that created a FRESH lock between the
 * snapshot and the removal lost that lock to the removal, the remover's own
 * O_EXCL create then succeeded, and BOTH processes returned tokens and entered
 * the critical section (dual holders, no post-create verification — exactly
 * the check-then-act gap the sibling module closed in workspace-lock.ts
 * tryCreateVerified).
 *
 * Fix under test:
 *   1. instance-bound removal — `removeLockIfTokenMatches` removes the file
 *      ONLY when its current stored token still equals the snapshotted corpse
 *      token (a fresh contender's randomUUID never matches);
 *   2. post-claim verification — a successful O_EXCL create is only trusted
 *      after a re-read confirms the on-disk token is the acquirer's own
 *      (pinned at wrapper level by the "steal still works" tests: the acquire
 *      path can only complete through the verified return).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { removeLockIfTokenMatches, withFileLockAsync, withFileLockSync } from "../../../../src/state/coordination/locks.ts";

/** A pid that does not exist on the machine (dead holder → stealable). */
const DEAD_PID = 99999;

function writeLockFixture(filePath: string, token: string | undefined, ageMs: number): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const createdAt = new Date(Date.now() - ageMs).toISOString();
	const payload = token === undefined ? { pid: DEAD_PID, createdAt } : { pid: DEAD_PID, createdAt, token };
	fs.writeFileSync(filePath, JSON.stringify(payload), "utf-8");
}

function readStoredToken(filePath: string): string | undefined {
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { token?: unknown };
	return typeof parsed.token === "string" ? parsed.token : undefined;
}

describe("removeLockIfTokenMatches (W6 instance-bound steal removal)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-steal-w6-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true });
	});

	it("removes the lock when the stored token still equals the corpse token", () => {
		const lockFile = path.join(tmpDir, "run.lock");
		writeLockFixture(lockFile, "corpse-token", 100_000);

		const removed = removeLockIfTokenMatches(lockFile, "corpse-token");

		assert.equal(removed, true, "the verified corpse must be removable");
		assert.ok(!fs.existsSync(lockFile), "corpse lock file must be gone");
	});

	it("does NOT remove a FRESH contender's lock (different token) — the dual-holder regression", () => {
		const lockFile = path.join(tmpDir, "run.lock");
		// Contender B created a fresh lock (new randomUUID token) after the
		// snapshot was taken. The old code rmSync'd it unconditionally → dual
		// holders. The fix must refuse.
		writeLockFixture(lockFile, "fresh-contender-token", 0);

		const removed = removeLockIfTokenMatches(lockFile, "corpse-token");

		assert.equal(removed, false, "a lock whose token differs from the verified corpse must NOT be removed");
		assert.equal(readStoredToken(lockFile), "fresh-contender-token", "the fresh contender's lock must survive byte-for-byte");
	});

	it("token-less corpse (legacy payload) still removes a token-less file", () => {
		const lockFile = path.join(tmpDir, "run.lock");
		writeLockFixture(lockFile, undefined, 100_000);

		const removed = removeLockIfTokenMatches(lockFile, undefined);

		assert.equal(removed, true, "legacy token-less corpse steal must keep working (CI-flake fix preserved)");
		assert.ok(!fs.existsSync(lockFile), "token-less corpse must be gone");
	});

	it("token-less corpse does NOT remove a file that HAS a token (fresh contender)", () => {
		const lockFile = path.join(tmpDir, "run.lock");
		writeLockFixture(lockFile, "fresh-contender-token", 0);

		const removed = removeLockIfTokenMatches(lockFile, undefined);

		assert.equal(removed, false, "a tokened (fresh) lock must never fall to a token-less corpse removal");
		assert.equal(readStoredToken(lockFile), "fresh-contender-token", "fresh contender's lock must survive");
	});

	it("a missing file is a harmless no-op and a corpse token never matches a vanished file", () => {
		const missing = path.join(tmpDir, "gone.lock");
		assert.equal(removeLockIfTokenMatches(missing, "corpse-token"), false);
		assert.equal(removeLockIfTokenMatches(missing, undefined), true, "ENOENT + token-less corpse → no-op rm is harmless");
		assert.ok(!fs.existsSync(missing), "nothing was created");
	});
});

describe("wrapper-level steal behavior with the bound removal in place (W6)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-steal-w6-wrap-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true });
	});

	it("withFileLockSync still steals a stale TOKENED corpse and enters the critical section", () => {
		const target = path.join(tmpDir, "protected.bin");
		const lockFile = `${target}.flock`;
		writeLockFixture(lockFile, "corpse-token-aaaa", 100_000);

		let tokenInside: string | undefined;
		const result = withFileLockSync(target, () => {
			tokenInside = readStoredToken(lockFile);
			return "ok";
		});

		assert.equal(result, "ok");
		assert.ok(tokenInside !== undefined, "acquire must have (re)created the lock before fn ran");
		assert.notEqual(tokenInside, "corpse-token-aaaa", "the corpse must have been replaced by a fresh O_EXCL claim");
		assert.ok(!fs.existsSync(lockFile), "token-guarded release must remove our own lock on exit");
	});

	it("withFileLockAsync still steals a stale TOKENED corpse and enters the critical section", async () => {
		const target = path.join(tmpDir, "protected-async.bin");
		const lockFile = `${target}.flock`;
		writeLockFixture(lockFile, "corpse-token-bbbb", 100_000);

		let tokenInside: string | undefined;
		const result = await withFileLockAsync(target, async () => {
			tokenInside = readStoredToken(lockFile);
			return "ok-async";
		});

		assert.equal(result, "ok-async");
		assert.ok(tokenInside !== undefined);
		assert.notEqual(tokenInside, "corpse-token-bbbb", "the corpse must have been replaced by a fresh O_EXCL claim");
		assert.ok(!fs.existsSync(lockFile));
	});
});
