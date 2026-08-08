import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { findLatestScratchpadSnapshot } from "../../src/runtime/scratchpad/snapshot-lookup.ts";

// Phase 2 (D1/D1b/D12): snapshot lookup helper. Latest mtime wins (model-
// fallback i resets each retry round → mtime is the write-order proxy);
// mtime ties break by LOWEST attempt (new retry round restarts at i=0 → the
// low-index file belongs to the newer round). Strict: regular files only,
// symlinks rejected at readdir, exact `<agentId>.attempt-<digits>.snapshot.json`.

function makeCtx() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "p2-lookup-"));
	const scratchpadDir = path.join(root, "scratchpad");
	fs.mkdirSync(scratchpadDir, { recursive: true });
	const write = (name: string, mtimeMs?: number) => {
		const p = path.join(scratchpadDir, name);
		fs.writeFileSync(p, "{}");
		if (mtimeMs !== undefined) {
			fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
		}
		return p;
	};
	return { root, scratchpadDir, write };
}

test("P2-T1: no scratchpad dir → null (fail-open)", () => {
	const { root } = makeCtx();
	fs.rmdirSync(path.join(root, "scratchpad"));
	assert.equal(findLatestScratchpadSnapshot(root, "task-1"), null);
});

test("P2-T1: empty dir → null", () => {
	const { root } = makeCtx();
	assert.equal(findLatestScratchpadSnapshot(root, "task-1"), null);
});

test("P2-T1: picks the file with the LATEST mtime, not the highest attempt number (D1b retry-reset case)", () => {
	const ctx = makeCtx();
	// retry1-i2 (attempt 2, OLD) vs retry2-i0 (attempt 0, NEW) — number says i2,
	// write order says i0. Latest mtime must win.
	ctx.write("task-1.attempt-2.snapshot.json", 1_000_000);
	const newer = ctx.write("task-1.attempt-0.snapshot.json", 2_000_000);
	const hit = findLatestScratchpadSnapshot(ctx.root, "task-1");
	assert.ok(hit, "must find a snapshot");
	assert.equal(hit.path, newer);
	assert.equal(hit.attempt, 0);
});

test("P2-T1: mtime tie → LOWEST attempt wins (new retry round restarts at i=0 — MINOR-S6)", () => {
	const ctx = makeCtx();
	const t = 1_500_000_000_000;
	const low = ctx.write("task-1.attempt-0.snapshot.json", t);
	ctx.write("task-1.attempt-3.snapshot.json", t);
	// Both files share the same mtime (coarse filesystem); per D1b' the lowest
	// attempt wins the tie — a new retry round restarts at i=0.
	const hit = findLatestScratchpadSnapshot(ctx.root, "task-1");
	assert.ok(hit);
	assert.equal(hit.path, low);
});

test("P2-T1: ignores other agents' snapshots", () => {
	const ctx = makeCtx();
	ctx.write("task-2.attempt-0.snapshot.json", 9_000_000);
	const hit = findLatestScratchpadSnapshot(ctx.root, "task-1");
	assert.equal(hit, null);
});

test("P2-T1: ignores files that do not match the exact pattern", () => {
	const ctx = makeCtx();
	ctx.write("task-1.attempt-x.snapshot.json", 9_000_000); // non-numeric attempt
	ctx.write("task-1.attempt-0.snapshot.json.bak", 9_000_000); // wrong suffix
	ctx.write("task-1.attempt-0.json", 9_000_000); // missing snapshot.json
	ctx.write("task-1.attempt-0.snapshot.json.tmp", 9_000_000); // temp-ish name
	assert.equal(findLatestScratchpadSnapshot(ctx.root, "task-1"), null);
});

test("P2-T1: ignores non-file entries (dirs, symlinks) — D12 strictness", (t) => {
	const ctx = makeCtx();
	// dir entry with a matching name → must not match
	fs.mkdirSync(path.join(ctx.scratchpadDir, "task-1.attempt-0.snapshot.json"));
	// symlink pointing OUTSIDE the container at a matching-named file → must be
	// rejected at readdir (never followed — proves containment, NIT-CA-2)
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-lookup-out-"));
	const outsideFile = path.join(outsideDir, "task-1.attempt-9.snapshot.json");
	fs.writeFileSync(outsideFile, "{}");
	try {
		fs.symlinkSync(outsideFile, path.join(ctx.scratchpadDir, "task-1.attempt-9.snapshot.json"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") {
			t.skip("symlinks unsupported on this platform");
			return;
		}
		throw error;
	}
	const hit = findLatestScratchpadSnapshot(ctx.root, "task-1");
	assert.equal(hit, null, "dir + symlink entries must not match");
});

test("P2-T1: scratchpad DIR replaced by symlink → null (SEC-7 scan-dir containment)", (t) => {
	const ctx = makeCtx();
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-lookup-out-"));
	fs.writeFileSync(path.join(outsideDir, "task-1.attempt-0.snapshot.json"), "{}");
	fs.rmSync(ctx.scratchpadDir, { recursive: true });
	try {
		fs.symlinkSync(outsideDir, ctx.scratchpadDir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") {
			t.skip("symlinks unsupported on this platform");
			return;
		}
		throw error;
	}
	assert.equal(findLatestScratchpadSnapshot(ctx.root, "task-1"), null, "symlinked scratchpad dir must not be followed");
});

test("P2-T1: returns absolute path inside the container", () => {
	const ctx = makeCtx();
	const p = ctx.write("task-1.attempt-0.snapshot.json", 1_000_000);
	const hit = findLatestScratchpadSnapshot(ctx.root, "task-1");
	assert.ok(hit);
	assert.ok(path.isAbsolute(hit.path));
	assert.equal(hit.path, p);
	assert.equal(hit.mtimeMs, 1_000_000);
});
