/**
 * Scratchpad spike — engine invariants (node:test, spawns real subprocesses).
 *
 * This is the go/no-go evidence for the pi-rlm → Node port. Two invariants
 * must hold for the FLAGSHIP decision (rlm-apply-pi-crew.md §5, §7.1):
 *
 *   (a) BINDINGS SURVIVE MID-CELL FAILURE — pattern 01 + 05. Cell 1 throws
 *       part-way through; the names it already bound (`data`, `sum`) stay in
 *       the namespace, and cell 2 on the SAME live engine reads them.
 *   (b) NAMESPACE REVIVES FROM SNAPSHOT ACROSS A PROCESS BOUNDARY — patterns
 *       08 + 09. Engine 1 snapshots to an explicit temp file, is killed; a
 *       NEW engine 2 restores from that file and answers with the revived
 *       values.
 *
 * Auxiliary: snapshot reports unserializable bindings (functions) in its
 * `failed` list without crashing, and the engine stays usable afterwards.
 *
 * Each engine test spawns a child process, so keep --test-timeout >= 60000.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EngineManager } from "../../../src/runtime/scratchpad/engine.ts";

test("invariant (a): bindings survive mid-cell failure", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});

	const first = await engine.execute(`const data = [1,2,3]; const sum = data.reduce((a,b)=>a+b,0); throw new Error("boom")`);
	assert.equal(first.status, "error", "cell 1 must report an error");
	assert.equal(first.error?.name, "Error");
	assert.match(first.error?.message ?? "", /boom/);

	// The engine is still alive and the namespace kept the pre-throw
	// bindings: `data` and `sum` were assigned BEFORE the throw.
	const second = await engine.execute("data.length");
	assert.equal(second.status, "ok");
	assert.equal(second.result, "3", "data.length must read the surviving binding");

	const third = await engine.execute("data.length + sum");
	assert.equal(third.status, "ok");
	assert.equal(third.result, "9", "sum must also survive (3 + 6)");
});

test("invariant (b): namespace revives from snapshot across a process boundary", { timeout: 60_000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "scratchpad-spike-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const engine1 = new EngineManager();
	t.after(async () => {
		await engine1.kill();
	});

	const first = await engine1.execute(`const x = 42; const y = x * 2; const obj = {a:1,b:[2,3]}`);
	assert.equal(first.status, "ok");

	const snapshotPath = join(dir, "snapshot.json");
	const snap = await engine1.snapshotState(snapshotPath);
	assert.ok(snap, "snapshotState must succeed on a running engine");
	assert.ok(snap!.saved.includes("x"));
	assert.ok(snap!.saved.includes("y"));
	assert.ok(snap!.saved.includes("obj"));
	assert.deepEqual(snap!.failed, [], "plain data must serialize cleanly");

	await engine1.kill();

	const engine2 = new EngineManager();
	t.after(async () => {
		await engine2.kill();
	});
	const restored = await engine2.restoreState(snapshotPath);
	assert.ok(restored, "restoreState must succeed on a fresh engine");
	assert.deepEqual([...restored!.restored].sort(), ["obj", "x", "y"]);

	const revived = await engine2.execute("y + obj.b.length");
	assert.equal(revived.status, "ok");
	assert.equal(revived.result, "86", "y (42*2) + obj.b.length (2) must revive");
});

test("snapshot reports unserializable bindings in failed list, engine stays usable", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	const dir = mkdtempSync(join(tmpdir(), "scratchpad-spike-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const first = await engine.execute(`function helper(x) { return x * 2; }`);
	assert.equal(first.status, "ok");

	const snapshotPath = join(dir, "snapshot.json");
	const snap = await engine.snapshotState(snapshotPath);
	assert.ok(snap, "snapshot must not crash on a function binding");
	const helperFailed = snap!.failed.find((f) => f.name === "helper");
	assert.ok(helperFailed, "helper must be reported in the failed list");
	assert.ok(helperFailed!.reason.length > 0, "failed entry carries a reason");
	assert.match(helperFailed!.reason, /clone/i, "v8 refuses to clone a function");

	// The live namespace still holds `helper` — snapshot failure is
	// non-destructive and the engine remains usable.
	const usable = await engine.execute("helper(21)");
	assert.equal(usable.status, "ok");
	assert.equal(usable.result, "42");
});
