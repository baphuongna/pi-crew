/**
 * I6 — pattern-12 shell interpolation guard (`sh()` binding) guest tests.
 *
 * Spawns real EngineManager guests (like the spike tests) to verify the
 * `sh(cmd, args[])` binding installed by installBootstrapBindings():
 *   (a) nullish args are refused BEFORE spawn (pattern-12 `rm -rf undefined`
 *       class-bug guard);
 *   (b) returns a VALUE `{ exitCode, stdout, stderr }` (pi-rlm "shell as
 *       value"), non-zero exit does not throw;
 *   (c) `sh` is excluded from the snapshot's `vars` (INTERNAL_BINDINGS skip);
 *   (d) `sh` is still callable after a restore (bootstrap re-installs after
 *       restore — a revived stale value cannot shadow the live handle).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EngineManager } from "../../../../src/runtime/scratchpad/engine.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-crew-sh-guard-"));
}

test("I6 (a): sh refuses null/undefined args before spawning (no 'rm -rf undefined')", { timeout: 60_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});

	// `dir` is undefined in the namespace → sh must refuse, not stringify.
	const res = await engine.execute(`const r = await sh("rm", ["-rf", dir]); r`);
	assert.equal(res.status, "error", "sh must refuse a nullish argument");
	assert.match(res.error?.message ?? "", /null\/undefined/, "refusal error must name the nullish guard");
});

test("I6 (a): sh refuses a missing command too", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	const res = await engine.execute(`const r = await sh(undefined); r`);
	assert.equal(res.status, "error", "sh must refuse a missing command");
});

test("I6 (b): sh returns { exitCode, stdout, stderr } value, non-zero does not throw", { timeout: 60_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});

	const ok = await engine.execute(`const r = await sh("node", ["-e", "process.stdout.write('hello-from-sh')"]); r`);
	assert.equal(ok.status, "ok", "sh should succeed for a valid command");
	assert.match(ok.result ?? "", /hello-from-sh/, "stdout must be captured in the result");

	const boom = await engine.execute(`const r = await sh("node", ["-e", "process.exit(3)"]); r`);
	assert.equal(boom.status, "ok", "non-zero exit must NOT throw (value semantics)");
	assert.match(boom.result ?? "", /exitCode:\s*3/, "exitCode 3 must be returned in the value");
});

test("I6 (c): sh is excluded from the snapshot vars (INTERNAL_BINDINGS skip)", { timeout: 60_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});

	await engine.execute(`const x = 42`);
	const snapPath = join(dir, "snap.json");
	const snap = await engine.snapshotState(snapPath);
	assert.ok(snap, "snapshot should succeed");
	// saved is a string[] of namespace var names — sh must NOT be among them.
	assert.ok(!snap!.saved.includes("sh"), "sh must not be serialized into the snapshot");
});

test("I6 (d): sh is still callable after a restore", { timeout: 60_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});

	// Build a snapshot with a var + sh; restore into a fresh engine.
	await engine.execute(`const answer = 42`);
	const snapPath = join(dir, "snap.json");
	await engine.snapshotState(snapPath);
	await engine.kill();

	const engine2 = new EngineManager();
	t.after(async () => {
		await engine2.kill();
	});
	// Restore via a valid snapshot file (engine.restoreState validates the file).
	const restore = await engine2.restoreState(snapPath);
	assert.ok(restore, "restore should succeed");
	assert.ok(restore!.restored.includes("answer"), "answer var must be revived");

	// sh must still work after restore (bootstrap re-installed it).
	const res = await engine2.execute(`const r = await sh("node", ["-e", "process.stdout.write('after-restore')"]); r`);
	assert.equal(res.status, "ok", "sh must still be callable after restore");
	assert.match(res.result ?? "", /after-restore/);
});
