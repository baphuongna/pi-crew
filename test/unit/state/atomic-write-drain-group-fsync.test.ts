/**
 * PERF round 2, Task 8 (2026-08-25): grouped parent-dir fsync across a
 * coalesced drain.
 *
 * A full-durability atomic write fsyncs the data file AND the parent dir.
 * Inside the GLOBAL coalesced drain (`flushPendingAtomicWrites()` with no
 * argument) the per-file dir fsync is deferred and coalesced: after the
 * serial loop (all renames done — R16-B1 ordering) the drain issues ONE
 * fsync per DISTINCT parent dir. Scoped flushes, coalesce-timer flushes, and
 * direct `atomicWriteJson` calls keep the immediate per-write dir fsync.
 *
 * Observed via the node:fs CJS-default swap (same pattern as
 * test/unit/state/state-store-tasks-fsync.test.ts and b12): patch
 * `fs.openSync` so (a) a directory opened with flags "r" maps its fd → dir
 * path (that is exactly the dir-fsync site, inline or trailing-drain), and
 * (b) a `*.tmp` fd maps to the data file (the data-fsync site), then count
 * `fs.fsyncSync` calls per fd class. `syncBuiltinESMExports()` makes the
 * `import * as fs from "node:fs"` namespace inside src see the patch.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { atomicWriteJson, atomicWriteJsonCoalesced, flushPendingAtomicWrites } from "../../../src/state/atomic-write.ts";

/** Long enough that no coalesce timer fires mid-test — only explicit drains. */
const HOLD_MS = 60_000;

interface DirFsyncSpy {
	/** fsyncSync calls on an fd opened for `dir` with flags "r". */
	dirFsyncs(dir: string): number;
	/** fsyncSync calls on `*.tmp` data-file fds (the per-file data fsync). */
	dataFsyncs(): number;
	restore(): void;
}

function makeDirFsyncSpy(watchDirs: string[], failOpenPrefixes: string[] = []): DirFsyncSpy {
	const nodeRequire = createRequire(import.meta.url);
	const fsDefault = nodeRequire("node:fs") as {
		openSync: (...args: unknown[]) => number;
		fsyncSync: (...args: unknown[]) => unknown;
		closeSync: (...args: unknown[]) => void;
	};
	const nodeModule = nodeRequire("node:module") as { syncBuiltinESMExports(): void };
	const originalOpen = fsDefault.openSync;
	const originalFsync = fsDefault.fsyncSync;
	const originalClose = fsDefault.closeSync;
	const watch = new Set(watchDirs);
	const dirFdToDir = new Map<number, string>();
	const tempFds = new Set<number>();
	const perDir = new Map<string, number>();
	let dataFsyncCount = 0;

	fsDefault.openSync = (...args: unknown[]) => {
		const opened = args[0];
		for (const prefix of failOpenPrefixes) {
			if (typeof opened === "string" && opened.startsWith(prefix)) {
				throw Object.assign(new Error(`mock open failure for ${opened}`), { code: "EACCES" });
			}
		}
		const fd = originalOpen(...args);
		if (typeof opened === "string") {
			if (args[1] === "r" && watch.has(opened)) {
				// The dir-fsync site: openSync(dir, "r") — inline (depth 0) or the
				// trailing grouped drain helper. Attribute the fd to the dir.
				dirFdToDir.set(fd, opened);
			} else if (opened.endsWith(".tmp")) {
				// The atomic-write data temp file.
				tempFds.add(fd);
			}
		}
		return fd;
	};
	fsDefault.fsyncSync = (...args: unknown[]) => {
		const fd = args[0];
		if (typeof fd === "number") {
			const dir = dirFdToDir.get(fd);
			if (dir !== undefined) perDir.set(dir, (perDir.get(dir) ?? 0) + 1);
			else if (tempFds.has(fd)) dataFsyncCount++;
		}
		return originalFsync(...args);
	};
	// fd numbers are REUSED after close — drop the attribution on close or a
	// later temp open can inherit a dead dir fd's mapping and misattribute a
	// DATA fsync as a dir fsync (observed as a flaky +1 in the liveness case).
	fsDefault.closeSync = (...args: unknown[]) => {
		const fd = args[0];
		if (typeof fd === "number") {
			dirFdToDir.delete(fd);
			tempFds.delete(fd);
		}
		return originalClose(...args);
	};
	nodeModule.syncBuiltinESMExports();

	return {
		dirFsyncs: (dir) => perDir.get(dir) ?? 0,
		dataFsyncs: () => dataFsyncCount,
		restore: () => {
			fsDefault.openSync = originalOpen;
			fsDefault.fsyncSync = originalFsync;
			fsDefault.closeSync = originalClose;
			nodeModule.syncBuiltinESMExports();
		},
	};
}

function makeTempDir(label: string): string {
	return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `pi-crew-t8-${label}-`));
}

// ---------------------------------------------------------------------------
// (a) THE grouping case: 4 coalesced files, one dir, one global drain
// ---------------------------------------------------------------------------

test("coalesced drain of 4 files in one dir → ONE parent-dir fsync, 4 data fsyncs, all content lands", () => {
	const stateDir = makeTempDir("drain");
	const files = ["tasks.json", "manifest.json", "graph.json", "budget.json"].map((name) => path.join(stateDir, name));
	const spy = makeDirFsyncSpy([stateDir]);
	try {
		for (const [i, file] of files.entries()) {
			atomicWriteJsonCoalesced(file, { file: i, status: "running" }, HOLD_MS, { compact: true });
		}
		assert.equal(spy.dirFsyncs(stateDir), 0, "buffered writes must not fsync the dir before the drain");

		flushPendingAtomicWrites(); // global drain

		for (const [i, file] of files.entries()) {
			assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { file: i, status: "running" }, `${file} must land its content`);
		}
		assert.equal(spy.dataFsyncs(), 4, "each drained file keeps its own data fsync");
		assert.equal(
			spy.dirFsyncs(stateDir),
			1,
			`parent dir must be fsynced EXACTLY ONCE for the whole drain (got ${spy.dirFsyncs(stateDir)})`,
		);
	} finally {
		spy.restore();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// (b) single direct write — immediate dir fsync unchanged (no deferral leak)
// ---------------------------------------------------------------------------

test("direct atomicWriteJson keeps the immediate per-write parent-dir fsync", () => {
	const stateDir = makeTempDir("direct");
	const spy = makeDirFsyncSpy([stateDir]);
	try {
		atomicWriteJson(path.join(stateDir, "solo.json"), { ok: true }, { compact: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "solo.json"), "utf-8")), { ok: true });
		assert.equal(spy.dataFsyncs(), 1, "direct full-durability write fsyncs the data fd once");
		assert.equal(spy.dirFsyncs(stateDir), 1, "direct write (depth 0) must fsync the dir immediately, exactly once");
	} finally {
		spy.restore();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// (c) two distinct dirs → one dir fsync PER DIR
// ---------------------------------------------------------------------------

test("coalesced drain across TWO dirs → one parent-dir fsync per distinct dir", () => {
	const dirA = makeTempDir("two-a");
	const dirB = makeTempDir("two-b");
	const spy = makeDirFsyncSpy([dirA, dirB]);
	try {
		for (const [dir, tag] of [
			[dirA, "a"],
			[dirB, "b"],
		] as const) {
			atomicWriteJsonCoalesced(path.join(dir, "one.json"), { tag, n: 1 }, HOLD_MS, { compact: true });
			atomicWriteJsonCoalesced(path.join(dir, "two.json"), { tag, n: 2 }, HOLD_MS, { compact: true });
		}
		flushPendingAtomicWrites();
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirA, "one.json"), "utf-8")), { tag: "a", n: 1 });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirB, "two.json"), "utf-8")), { tag: "b", n: 2 });
		assert.equal(spy.dataFsyncs(), 4, "4 files → 4 data fsyncs");
		assert.equal(spy.dirFsyncs(dirA), 1, `dirA grouped to exactly one fsync (got ${spy.dirFsyncs(dirA)})`);
		assert.equal(spy.dirFsyncs(dirB), 1, `dirB grouped to exactly one fsync (got ${spy.dirFsyncs(dirB)})`);
	} finally {
		spy.restore();
		fs.rmSync(dirA, { recursive: true, force: true });
		fs.rmSync(dirB, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// (d) liveness / no-leak guards
// ---------------------------------------------------------------------------

test("empty drain is a no-op; scoped flush stays immediate; post-drain writes are immediate again", () => {
	const stateDir = makeTempDir("liveness");
	const spy = makeDirFsyncSpy([stateDir]);
	try {
		// Empty global drain: no pending writes → no dir fsync, no throw.
		assert.doesNotThrow(() => flushPendingAtomicWrites());
		assert.equal(spy.dirFsyncs(stateDir), 0, "empty drain must not fsync anything");

		// Scoped (single-path) flush keeps the immediate dir fsync.
		const scopedFile = path.join(stateDir, "scoped.json");
		atomicWriteJsonCoalesced(scopedFile, { n: 1 }, HOLD_MS, { compact: true });
		flushPendingAtomicWrites(scopedFile);
		assert.deepEqual(JSON.parse(fs.readFileSync(scopedFile, "utf-8")), { n: 1 });
		assert.equal(spy.dirFsyncs(stateDir), 1, "scoped flush must keep the immediate per-file dir fsync (no deferral)");

		// A grouped drain after that still groups exactly once...
		atomicWriteJsonCoalesced(path.join(stateDir, "grouped.json"), { n: 2 }, HOLD_MS, { compact: true });
		flushPendingAtomicWrites();
		assert.equal(spy.dirFsyncs(stateDir), 2, "grouped drain adds exactly one trailing dir fsync");

		// ...and the deferral does NOT leak past the drain: the next direct
		// write fsyncs immediately again (depth back to 0, set cleared).
		atomicWriteJson(path.join(stateDir, "after.json"), { n: 3 }, { compact: true });
		assert.equal(spy.dirFsyncs(stateDir), 3, "post-drain direct write must fsync the dir immediately");
	} finally {
		spy.restore();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// (e) mid-drain failure → the trailing dir fsync must not be skipped
// ---------------------------------------------------------------------------

test("a failed flush mid-drain does not skip the trailing dir fsync for already-renamed files", () => {
	const stateDir = makeTempDir("failure");
	const good1 = path.join(stateDir, "good1.json");
	const poison = path.join(stateDir, "poison.json");
	const good2 = path.join(stateDir, "good2.json");
	// Fail openSync for poison's data temp files (`poison.json.<uuid>.tmp`).
	const spy = makeDirFsyncSpy([stateDir], [`${poison}.`]);
	// INJECTION NOTE: a raw write failure inside the drain is CONTAINED by
	// flushOnePendingAtomicWrite's catch — its retry/rethrow block is
	// unreachable today because atomicWriteFile deletes the pending entry
	// (cancelPendingCoalescedWrite) before attempting the write, so the catch
	// never sees a matching `current` entry and never re-throws. To exercise
	// the drain's abort path (loop throwing mid-way) we therefore make the
	// flush's error REPORTING (logInternalError → console.error) throw for
	// poison's failure. If the reporting hook changes, this test fails loudly
	// ("Missing expected exception") and the injection point must be revisited.
	const originalConsoleError = console.error;
	console.error = (...args: unknown[]) => {
		const text = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
		if (text.includes("atomic-write.coalesced-flush") && text.includes(poison)) {
			throw new Error("injected mid-drain abort");
		}
		originalConsoleError(...args);
	};
	try {
		// Map insertion order = drain order: good1 first, poison second, good2 last.
		atomicWriteJsonCoalesced(good1, { n: 1 }, HOLD_MS, { compact: true });
		atomicWriteJsonCoalesced(poison, { n: 2 }, HOLD_MS, { compact: true });
		atomicWriteJsonCoalesced(good2, { n: 3 }, HOLD_MS, { compact: true });
		assert.equal(fs.existsSync(good1), false, "good1 still buffered before the drain");

		// good1 renames (deferring its dir fsync), then poison's flush fails and
		// the injected reporting error aborts the serial loop mid-drain.
		assert.throws(() => flushPendingAtomicWrites(), /injected mid-drain abort/);

		assert.deepEqual(JSON.parse(fs.readFileSync(good1, "utf-8")), { n: 1 }, "good1 renamed before the abort is on disk");
		assert.equal(
			spy.dirFsyncs(stateDir),
			1,
			`the drain's finally must still fsync the already-renamed file's dir despite the mid-drain abort (got ${spy.dirFsyncs(stateDir)})`,
		);
		assert.equal(fs.existsSync(poison), false, "poison's write failed — never on disk");
		assert.equal(fs.existsSync(good2), false, "the serial loop aborted at poison — good2 never flushed");

		// Post-abort recovery: a direct write clears good2's pending entry and
		// the immediate dir-fsync path still works (no leaked deferral state).
		atomicWriteJson(good2, { n: 3 }, { compact: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(good2, "utf-8")), { n: 3 });
		assert.equal(spy.dirFsyncs(stateDir), 2, "direct write after the aborted drain fsyncs immediately");
	} finally {
		console.error = originalConsoleError;
		spy.restore();
		// Belt-and-suspenders: never leak a 60s pending timer into other tests.
		flushPendingAtomicWrites();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a contained write failure mid-drain still groups: other files land and the dir fsyncs exactly once", () => {
	const stateDir = makeTempDir("contained");
	const files = ["good1.json", "poison.json", "good2.json", "good3.json"].map((name) => path.join(stateDir, name));
	const poison = files[1];
	// Raw write failure (no injected abort): flushOnePendingAtomicWrite
	// contains it and the serial drain CONTINUES with the remaining files.
	const spy = makeDirFsyncSpy([stateDir], [`${poison}.`]);
	try {
		for (const [i, file] of files.entries()) {
			atomicWriteJsonCoalesced(file, { n: i }, HOLD_MS, { compact: true });
		}
		assert.doesNotThrow(() => flushPendingAtomicWrites(), "contained failure must not abort the drain");
		for (const [i, file] of files.entries()) {
			if (file === poison) continue;
			assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { n: i }, `${file} must still land`);
		}
		assert.equal(fs.existsSync(poison), false, "poison never lands");
		assert.equal(spy.dataFsyncs(), 3, "3 successful files → 3 data fsyncs");
		assert.equal(spy.dirFsyncs(stateDir), 1, "one grouped trailing dir fsync despite the mid-drain failure");
	} finally {
		spy.restore();
		flushPendingAtomicWrites();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
