import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { atomicWriteJsonCoalesced, flushPendingAtomicWrites } from "../../../src/state/atomic-write.ts";

/**
 * R10-2 regression: `flushPendingAtomicWrites(path?)` must flush ONLY the
 * pending coalesced entry for the given exact file when a path is passed,
 * and keep the exact global-drain behavior when omitted.
 *
 * Before R10-2, hot read sites (readCrewAgents etc.) called the global
 * flush, so reading file B waited on a pending coalesced write for an
 * unrelated file A no matter how long A's coalesce window was.
 */
test("scoped flush does not flush an unrelated file's pending coalesced write (R10-2)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scoped-flush-1-"));
	const fileA = path.join(dir, "a.json");
	const fileB = path.join(dir, "b.json");
	try {
		// Long coalesce window: A stays pending unless explicitly flushed.
		atomicWriteJsonCoalesced(fileA, { file: "A" }, 60_000);
		assert.equal(fs.existsSync(fileA), false, "A is buffered, not on disk yet");

		// Scoped flush for B (which has no pending entry) must leave A pending.
		flushPendingAtomicWrites(fileB);
		assert.equal(fs.existsSync(fileA), false, "scoped flush of B must NOT drain A's pending write");

		// B gets its own pending write; scoped flush of B lands it, A stays pending.
		atomicWriteJsonCoalesced(fileB, { file: "B" }, 60_000);
		assert.equal(fs.existsSync(fileB), false);
		flushPendingAtomicWrites(fileB);
		assert.equal(JSON.parse(fs.readFileSync(fileB, "utf-8")).file, "B", "B's own pending write flushes");
		assert.equal(fs.existsSync(fileA), false, "A must STILL be pending after B's scoped flush");

		// Omitted-arg global flush drains both.
		flushPendingAtomicWrites();
		assert.equal(JSON.parse(fs.readFileSync(fileA, "utf-8")).file, "A", "global flush drains A");
		assert.equal(JSON.parse(fs.readFileSync(fileB, "utf-8")).file, "B", "global flush drains B");
	} finally {
		// Belt-and-suspenders: never leak a 60s pending timer into other tests.
		flushPendingAtomicWrites();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("scoped flush for a path with no pending entry is a safe no-op (R10-2)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scoped-flush-2-"));
	const fileC = path.join(dir, "c.json");
	try {
		assert.doesNotThrow(() => flushPendingAtomicWrites(fileC));
		assert.equal(fs.existsSync(fileC), false, "no-op must not create the file");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("scoped flush preserves last-write-wins coalescing for the flushed file (R10-2)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scoped-flush-3-"));
	const fileA = path.join(dir, "a.json");
	const fileB = path.join(dir, "b.json");
	try {
		atomicWriteJsonCoalesced(fileA, { v: 1 }, 60_000);
		atomicWriteJsonCoalesced(fileA, { v: 2 }, 60_000); // supersedes v=1
		atomicWriteJsonCoalesced(fileB, { v: "other" }, 60_000);
		flushPendingAtomicWrites(fileA);
		assert.equal(JSON.parse(fs.readFileSync(fileA, "utf-8")).v, 2, "coalesced latest value lands on scoped flush");
		assert.equal(fs.existsSync(fileB), false, "B untouched by A's scoped flush");
	} finally {
		flushPendingAtomicWrites();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
