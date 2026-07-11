import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { atomicWriteJson, atomicWriteJsonAsync, atomicWriteJsonCoalesced, flushPendingAtomicWrites } from "../../src/state/atomic-write.ts";

test("atomicWriteJsonCoalesced collapses 5 rapid writes into 1 disk write (2.1)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coalesce-"));
	const filePath = path.join(dir, "tasks.json");
	try {
		for (let i = 0; i < 5; i++) atomicWriteJsonCoalesced(filePath, { iteration: i }, 20);
		assert.equal(fs.existsSync(filePath), false, "no flush yet — file should not exist");
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(fs.existsSync(filePath), true, "auto-flush after coalesce window");
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.equal(parsed.iteration, 4, "last value wins");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("flushPendingAtomicWrites flushes synchronously (2.1)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coalesce-flush-"));
	const filePath = path.join(dir, "tasks.json");
	try {
		atomicWriteJsonCoalesced(filePath, { state: "queued" }, 60_000);
		assert.equal(fs.existsSync(filePath), false);
		flushPendingAtomicWrites();
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.equal(parsed.state, "queued");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteJsonCoalesced last-write-wins on overlapping paths (2.1)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coalesce-multi-"));
	const a = path.join(dir, "a.json");
	const b = path.join(dir, "b.json");
	try {
		atomicWriteJsonCoalesced(a, { v: 1 }, 20);
		atomicWriteJsonCoalesced(b, { v: 2 }, 20);
		atomicWriteJsonCoalesced(a, { v: 3 }, 20); // overrides a
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(JSON.parse(fs.readFileSync(a, "utf-8")).v, 3);
		assert.equal(JSON.parse(fs.readFileSync(b, "utf-8")).v, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("immediate async write cancels pending coalesced write (FIND-1 regression)", async () => {
	// Without cancellation, the merge's saveRunTasksAsync (immediate) would be
	// clobbered when the persistSingleTaskUpdate coalesced timer fires,
	// overwriting the fresh merge result with a stale single-task snapshot.
	// Uses a long coalesce window + explicit flush to make the race deterministic
	// (the 50ms auto-timer is timing-dependent; flushPendingAtomicWrites forces
	// any surviving stale entry to land immediately).
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coalesce-cancel-async-"));
	const filePath = path.join(dir, "tasks.json");
	try {
		atomicWriteJsonCoalesced(filePath, { state: "stale-single-task-snapshot" }, 60_000);
		assert.equal(fs.existsSync(filePath), false, "coalesced write is buffered, not yet on disk");
		await atomicWriteJsonAsync(filePath, { state: "fresh-merge-result" });
		assert.equal(JSON.parse(fs.readFileSync(filePath, "utf-8")).state, "fresh-merge-result");
		// Force any surviving pending (stale) write to land NOW.
		flushPendingAtomicWrites();
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.equal(parsed.state, "fresh-merge-result", "immediate write must win; stale coalesced write must not clobber it");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("immediate sync write cancels pending coalesced write (FIND-1 regression, sync path)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coalesce-cancel-sync-"));
	const filePath = path.join(dir, "tasks.json");
	try {
		atomicWriteJsonCoalesced(filePath, { state: "stale" }, 60_000);
		atomicWriteJson(filePath, { state: "fresh-sync" });
		flushPendingAtomicWrites();
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.equal(parsed.state, "fresh-sync", "sync immediate write must win");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
