import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { releaseOwnLock, withFileLockSync, withRunLock, withRunLockSync } from "../../../../src/state/coordination/locks.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "test-run-001",
		team: "test-team",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: stateRoot,
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
		goal: "test goal",
	};
}

describe("withFileLockSync", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = createTrackedTempDir("pi-crew-locks-file-");
	});
	afterEach(() => {
		removeTrackedTempDir(tmpDir);
	});

	it("executes the callback and returns its result", () => {
		const filePath = path.join(tmpDir, "data.json");
		const result = withFileLockSync(filePath, () => 42);
		assert.equal(result, 42);
	});

	it("creates a .flock sidecar file during execution and cleans up after", () => {
		const filePath = path.join(tmpDir, "protected.txt");
		let lockExistedDuringCallback = false;
		withFileLockSync(filePath, () => {
			lockExistedDuringCallback = fs.existsSync(filePath + ".flock");
		});
		assert.equal(lockExistedDuringCallback, true);
		assert.equal(fs.existsSync(filePath + ".flock"), false);
	});

	it("allows concurrent operations on different files", () => {
		const fileA = path.join(tmpDir, "a.txt");
		const fileB = path.join(tmpDir, "b.txt");
		const resultA = withFileLockSync(fileA, () => "alpha");
		const resultB = withFileLockSync(fileB, () => "beta");
		assert.equal(resultA, "alpha");
		assert.equal(resultB, "beta");
	});

	it("cleans up lock even when callback throws", () => {
		const filePath = path.join(tmpDir, "throw.txt");
		assert.throws(() =>
			withFileLockSync(filePath, () => {
				throw new Error("boom");
			}),
		);
		assert.equal(fs.existsSync(filePath + ".flock"), false);
	});

	it("accepts staleMs option", () => {
		const filePath = path.join(tmpDir, "opts.txt");
		const result = withFileLockSync(filePath, () => "ok", { staleMs: 100 });
		assert.equal(result, "ok");
	});
});

describe("withRunLockSync", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = createTrackedTempDir("pi-crew-locks-run-");
	});
	afterEach(() => {
		removeTrackedTempDir(tmpDir);
	});

	it("executes callback and returns result", () => {
		const manifest = makeManifest(tmpDir);
		const result = withRunLockSync(manifest, () => "done");
		assert.equal(result, "done");
	});

	it("creates run.lock during execution and removes after", () => {
		const manifest = makeManifest(tmpDir);
		let lockExisted = false;
		withRunLockSync(manifest, () => {
			lockExisted = fs.existsSync(path.join(tmpDir, "run.lock"));
		});
		assert.equal(lockExisted, true);
		assert.equal(fs.existsSync(path.join(tmpDir, "run.lock")), false);
	});

	it("cleans up lock even when callback throws", () => {
		const manifest = makeManifest(tmpDir);
		assert.throws(() =>
			withRunLockSync(manifest, () => {
				throw new Error("fail");
			}),
		);
		assert.equal(fs.existsSync(path.join(tmpDir, "run.lock")), false);
	});
});

describe("withRunLock (async)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = createTrackedTempDir("pi-crew-locks-async-");
	});
	afterEach(() => {
		removeTrackedTempDir(tmpDir);
	});

	it("executes async callback and returns result", async () => {
		const manifest = makeManifest(tmpDir);
		const result = await withRunLock(manifest, async () => {
			return await Promise.resolve("async-done");
		});
		assert.equal(result, "async-done");
	});

	it("creates and cleans up run.lock for async operations", async () => {
		const manifest = makeManifest(tmpDir);
		let lockExisted = false;
		await withRunLock(manifest, async () => {
			lockExisted = fs.existsSync(path.join(tmpDir, "run.lock"));
			await Promise.resolve();
		});
		assert.equal(lockExisted, true);
		assert.equal(fs.existsSync(path.join(tmpDir, "run.lock")), false);
	});

	it("cleans up lock when async callback rejects", async () => {
		const manifest = makeManifest(tmpDir);
		await assert.rejects(
			() =>
				withRunLock(manifest, async () => {
					throw new Error("async-fail");
				}),
			{ message: "async-fail" },
		);
		assert.equal(fs.existsSync(path.join(tmpDir, "run.lock")), false);
	});
});

describe("releaseOwnLock (LOCK-1: PID-guarded release)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = createTrackedTempDir("pi-crew-locks-release-own-");
	});
	afterEach(() => {
		removeTrackedTempDir(tmpDir);
	});

	it("does NOT delete a lock file whose pid belongs to a different process (stolen lock)", () => {
		const lockFile = path.join(tmpDir, "run.lock");
		fs.writeFileSync(
			lockFile,
			JSON.stringify({
				kind: "run",
				pid: 999999, // a different (fake) process
				createdAt: new Date().toISOString(),
				token: "our-token",
			}),
		);
		releaseOwnLock(lockFile, "our-token");
		// File must STILL EXIST — the lock was stolen by pid 999999; we must not wipe it.
		assert.equal(fs.existsSync(lockFile), true);
	});

	it("deletes a lock file whose pid matches the current process", () => {
		const lockFile = path.join(tmpDir, "run.lock");
		fs.writeFileSync(
			lockFile,
			JSON.stringify({
				kind: "run",
				pid: process.pid, // OUR process
				createdAt: new Date().toISOString(),
				token: "our-token",
			}),
		);
		releaseOwnLock(lockFile, "our-token");
		assert.equal(fs.existsSync(lockFile), false);
	});
});
