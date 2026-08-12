/**
 * Global shadow poisoning regression tests (P1).
 *
 * Verifies the fix in guest.ts: a cell that shadows a protected Node global
 * (`const process = 'poisoned'`, `const Buffer = {...}`, ...) must NOT poison
 * later cells in the same engine, and must NOT survive snapshot→restore.
 *
 * Spawns real EngineManager guests (like guest-sh.test.ts). Pre-fix these would
 * silently corrupt: `typeof process.env` would be 'undefined', `Buffer.alloc`
 * would be missing — with NO error. See rlm-deep-review-2026-08-12.md §2.3.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EngineManager } from "../../../../src/runtime/scratchpad/engine.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-crew-gshadow-"));
}

test("P1 (a): within-cell shadow works, but does NOT leak to the next cell", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});

	// cell 1: shadow `process`. Within THIS cell the shadow must win.
	const c1 = await engine.execute(`const process = 'poisoned'; typeof process`);
	assert.equal(c1.status, "ok", "cell 1 should run cleanly");
	assert.match(c1.result ?? "", /'string'/, "within-cell shadow: typeof process === 'string'");

	// cell 2 (same engine): `process` must be the REAL global again — no leak.
	const c2 = await engine.execute(`typeof process.env`);
	assert.equal(c2.status, "ok");
	assert.match(c2.result ?? "", /'object'/, "process.env must be the real object (typeof 'object'), not undefined");

	// cell 3: the real global is fully usable after a prior shadow.
	const c3 = await engine.execute(`typeof process.platform`);
	assert.equal(c3.status, "ok");
	assert.match(c3.result ?? "", /'string'/, "process.platform (a real global property) must resolve");
});

test("P1 (b): a serializable global shadow does NOT survive snapshot→restore", { timeout: 60_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// Poison Buffer with a serializable plain object (the dangerous case — it
	// revives). A real Buffer has `.alloc`; the poison does not.
	await engine.execute(`const Buffer = { poisoned: true }; 'set'`);
	const snapPath = join(dir, "snap.json");
	const snap = await engine.snapshotState(snapPath);
	assert.ok(snap, "snapshot should succeed");
	await engine.kill();

	const engine2 = new EngineManager();
	t.after(async () => {
		await engine2.kill();
	});
	const restore = await engine2.restoreState(snapPath);
	assert.ok(restore, "restore should succeed");

	// After restore, Buffer must be the REAL global (bootstrap re-installed it),
	// not the revived poisoned object.
	const res = await engine2.execute(`Buffer.alloc ? 'real' : 'poisoned'`);
	assert.equal(res.status, "ok");
	assert.match(res.result ?? "", /'real'/, "Buffer must be the real global after restore, not the poison");
});

test("P1 (c): a protected global is still usable as a value (read path intact)", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// Reading a protected global (no shadow) must resolve to the real one.
	const res = await engine.execute(`typeof setTimeout`);
	assert.equal(res.status, "ok");
	assert.match(res.result ?? "", /'function'/, "setTimeout must resolve to the real global function");
});

test("P1 (d): console shadow does not corrupt the guest's own error reporting", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// Shadowing console should not break later cells or the guest's stray-error
	// reporting (which routes through the captured console).
	await engine.execute(`const console = { log: () => 'fake' }; 'set'`);
	const after = await engine.execute(`typeof console.error`);
	assert.equal(after.status, "ok");
	assert.match(after.result ?? "", /'function'/, "console.error must be the real function in the next cell");
});

test("P1 (e): a user variable persists across cells after a protected-global reset (regression guard)", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// resetProtectedGlobals() runs at the start of EVERY cell. If a future change
	// ever wipes the whole namespace (not just protected globals), the other tests
	// would still pass. This guards legitimate user state survives the reset.
	await engine.execute(`const process = 'poisoned'; const myData = 'survived'; 'set'`);
	const data = await engine.execute(`myData`);
	assert.equal(data.status, "ok");
	assert.match(data.result ?? "", /'survived'/, "a user variable must persist across cells despite a global shadow reset");

	const realGlobal = await engine.execute(`typeof process.env`);
	assert.match(realGlobal.result ?? "", /'object'/, "and the real global must be restored in the same cell");
});

test("P1 (f): multiple protected globals shadowed in one cell all reset in the next", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	await engine.execute(`const process = 1; const Buffer = 2; const console = 3; const setTimeout = 4; 'set'`);
	const res = await engine.execute(`[typeof process.env, Buffer.alloc ? 'B' : 'x', typeof console.error, typeof setTimeout]`);
	assert.equal(res.status, "ok");
	// inspect of ['object','B','function','function']
	assert.match(res.result ?? "", /'object'/, "process restored");
	assert.match(res.result ?? "", /'B'/, "Buffer restored");
	assert.match(res.result ?? "", /'function'.*'function'/s, "console + setTimeout restored");
});

test("P1 (g): the shadowed global IS in the snapshot but restore still yields the clean global", { timeout: 60_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// Snapshot taken right after the shadow cell (before any reset) — the poison
	// IS serialized. This pins the fix to the RESTORE path, not snapshot exclusion.
	await engine.execute(`const Buffer = { poisoned: true }; 'set'`);
	const snapPath = join(dir, "snap.json");
	const snap = await engine.snapshotState(snapPath);
	assert.ok(snap, "snapshot should succeed");
	assert.ok(snap!.saved.includes("Buffer"), "the shadowed global must be IN the snapshot (fix is restore-side, not snapshot-side)");
	await engine.kill();

	const engine2 = new EngineManager();
	t.after(async () => {
		await engine2.kill();
	});
	await engine2.restoreState(snapPath);
	const res = await engine2.execute(`Buffer.alloc ? 'real' : 'poisoned'`);
	assert.equal(res.status, "ok");
	assert.match(res.result ?? "", /'real'/, "restore must overwrite the revived shadow with the live global");
});

test("P1 (h): a clean snapshot does not serialize protected globals (identity-skip)", { timeout: 60_000 }, async (t) => {
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
	assert.ok(snap!.saved.includes("x"), "the user var must be saved");
	assert.ok(!snap!.saved.includes("process"), "process must be identity-skipped (live === registered)");
	assert.ok(!snap!.saved.includes("Buffer"), "Buffer must be identity-skipped");
	assert.ok(!snap!.saved.includes("sh"), "sh must remain identity-skipped (regression guard for the existing I6 skip)");
});
