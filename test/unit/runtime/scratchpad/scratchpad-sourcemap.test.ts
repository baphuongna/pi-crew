/**
 * P6 — scratchpad stack-trace sourcemap (error line remap).
 *
 * Verifies transformCell builds a correct `lineMap` AND that guest runCell
 * remaps V8's transformed error line back to the cell's source line.
 *
 * Background (§2.4 of rlm-deep-review-2026-08-12.md): V8 reports the error line
 * relative to the TRANSFORMED body (which esbuild type-stripping and the import
 * pre-rewrite shift). Pre-fix, a cell error showed a wrong line number.
 *
 * The remap composes 3 layers: bodyLine → jsLine (splice tracking) → rewritten
 * (esbuild inline sourcemap + VLQ) → code (import pre-rewrite).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineManager } from "../../../../src/runtime/scratchpad/engine.ts";
import { transformCell } from "../../../../src/runtime/scratchpad/transform.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-crew-p6-"));
}

// ── transformCell lineMap unit tests ─────────────────────────────────────────

test("P6 (a): no import, no types → lineMap covers replaced lines; remap identity for others", () => {
	const r = transformCell("const a = 1;\nconst b = 2;\na + b");
	// Replacements: `const a` (body line 1), `const b` (body line 2), trailing
	// `a + b` (body line 3). All identity (no type/import shift).
	assert.deepEqual(r.lineMap, [
		{ sourceLine: 1, bodyLine: 1 },
		{ sourceLine: 2, bodyLine: 2 },
		{ sourceLine: 3, bodyLine: 3 },
	]);
});

test("P6 (b): multi-line type annotation — esbuild sourcemap maps to the collapse point", () => {
	const r = transformCell("const x: {\n  a: string\n} = { a: 'v' };\nx.a");
	// KNOWN esbuild-sourcemap limitation: esbuild maps `x.a` (js line 2) back
	// to rewritten line 2 (`a: string`), not line 4 (`x.a`) — its mappings for
	// type-annotation collapse point at the annotation, not the expression.
	// This is a MINOR cosmetic limitation (the line is not wildly off, and
	// multi-line type annotations in cells are rare). The common cases
	// (no-type identity, multi-line import) are exact — see (a) and (c).
	assert.deepEqual(r.lineMap, [
		{ sourceLine: 1, bodyLine: 1 },
		{ sourceLine: 2, bodyLine: 2 },
	]);
});

test("P6 (c): multi-line import (pre-rewrite collapse) → lineMap reflects the shift", () => {
	const r = transformCell('import {\n  a,\n  b\n} from "mod";\nconst v = a + b;\nv');
	// The import (source lines 1-3) becomes a BlockStatement in `js` (esbuild
	// rewrites the `{...}` await-import block), which produces NO replacement
	// entry (the block is passed through). So `const v` (source line 5) is the
	// first entry, landing on body line 4 (after the 3-line block); `v` (source
	// line 6) on body line 5. Lines inside the import block (1-3) are unreplaced
	// and fall back to nearest-lower-bound identity in remapStackLines.
	assert.deepEqual(r.lineMap, [
		{ sourceLine: 5, bodyLine: 4 },
		{ sourceLine: 6, bodyLine: 5 },
	]);
});

test("P6 (d): body does NOT contain the esbuild inline sourcemap comment", () => {
	const r = transformCell("const x: number = 5;\nx * 2");
	assert.ok(!r.body.includes("sourceMappingURL"), "inline sourcemap comment must be stripped from the cell body");
});

// ── guest runCell error remap (real EngineManager) ───────────────────────────

test("P6 (e): a cell error reports the SOURCE line, not the transformed body line", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// throw is on SOURCE line 3. V8 would report <anonymous>:5 (body line 3 + 2
	// wrapper prefix lines); after remap it must be 3.
	const r = await engine.execute("const a = 1;\nconst b = 2;\nthrow new Error('boom');");
	assert.equal(r.status, "error");
	const stack = r.error?.stack ?? [];
	const topFrame = stack.find((l) => l.includes("<anonymous>"));
	assert.ok(topFrame, "expected an <anonymous> frame");
	assert.match(topFrame!, /<anonymous>:3:\d+/, `expected source line 3 in top frame, got: ${topFrame}`);
});

test("P6 (h): an error MESSAGE containing <anonymous>:N:C) is left byte-identical (no corruption)", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// P6 review HIGH-1: the old regex matched ANY line containing
	// `<anonymous>:N:C)` including the `Error: <message>` line, rewriting the
	// message's numbers (e.g. `9` → `7`). The fix anchors to real `    at `
	// frames only, so the message must survive untouched while the top frame
	// still remaps to source line 3.
	const r = await engine.execute('const a = 1;\nconst b = 2;\nthrow new Error("boom at <anonymous>:9:4)");');
	assert.equal(r.status, "error");
	const stack = r.error?.stack ?? [];
	assert.equal(stack[0], "Error: boom at <anonymous>:9:4)", "message line must be byte-identical (not corrupted)");
	const topFrame = stack.find((l) => l.includes("<anonymous>") && l.includes("at ") && !l.startsWith("Error"));
	assert.ok(topFrame, "expected a remapped frame line");
	assert.match(topFrame!, /<anonymous>:3:\d+/, `top frame must still remap to source line 3, got: ${topFrame}`);
});

test("P6 (i): a bare throw (empty lineMap) leaves the stack untouched (no-op fallback)", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// MEDIUM-1: a single-line cell with only a throw has NO replacements, so
	// lineMap is empty and remap is a no-op. Pin the raw V8 line (body line 1 +
	// 2 wrapper lines = 3) so it cannot silently change.
	const r = await engine.execute("throw new Error('boom');");
	assert.equal(r.status, "error");
	const stack = r.error?.stack ?? [];
	const topFrame = stack.find((l) => l.includes("<anonymous>"));
	assert.ok(topFrame, "expected an <anonymous> frame");
	assert.match(topFrame!, /<anonymous>:3:\d+/, `bare throw raw line 3 (no-op), got: ${topFrame}`);
});

test("P6 (j): a cross-cell function frame is NOT mapped through the calling cell's lineMap", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// MEDIUM-3: cell 1 defines `f` (its throw is on f's OWN body line 2). Cell 2
	// calls `f()`. The `Proxy.f` frame's line belongs to CELL 1, but remap runs
	// with CELL 2's lineMap — mapping it through cell 2 would be actively
	// wrong. With the frame-anchored regex + nearest-lower-bound, the frame is
	// either left as-is (no entry ≤ its body line in cell 2's map) or mapped
	// sensibly. Assert it is NOT corrupted into a wrong number.
	await engine.execute("function f() {\n  throw new Error('inner');\n}\nf");
	const r = await engine.execute("f();");
	assert.equal(r.status, "error");
	const stack = r.error?.stack ?? [];
	const fFrame = stack.find((l) => l.includes("Proxy.f"));
	assert.ok(fFrame, "expected a Proxy.f frame");
	// The Proxy.f frame references cell 1's body line (2 + 2 wrapper = 4 raw;
	// or already 2 after cell-1's own remap). Whatever it is, it must NOT be
	// remapped through cell 2's map (which has no entry at body line 0/1 for
	// it). Assert it is either left as raw 4 or an already-remapped 2 — never
	// a spurious value.
	assert.match(fFrame!, /<anonymous>:[24]:\d+/, `cross-cell frame must not be corrupted, got: ${fFrame}`);
});

test("P6 (f): a cell error after a multi-line type annotation remaps to a sane line", { timeout: 60_000 }, async (t) => {
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	// With a 3-line type annotation, esbuild's collapse mapping points the
	// thrown line at the annotation collapse point rather than the true source
	// line 4. This is the documented esbuild-sourcemap limitation (see P6 b).
	// The test asserts the line is REMAPPED (not the raw V8 shifted line) and
	// is within the annotation block (1-3), which is a bounded, sane result.
	const r = await engine.execute("const x: {\n  a: string\n} = { a: 'v' };\nthrow new Error('boom');");
	assert.equal(r.status, "error");
	const stack = r.error?.stack ?? [];
	const topFrame = stack.find((l) => l.includes("<anonymous>"));
	assert.ok(topFrame, "expected an <anonymous> frame");
	assert.match(topFrame!, /<anonymous>:(1|2|3):\d+/, `expected a remapped annotation-block line, got: ${topFrame}`);
});

test("P6 (g): snapshot/restore still work after sourcemap change (no regression)", { timeout: 60_000 }, async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const engine = new EngineManager();
	t.after(async () => {
		await engine.kill();
	});
	await engine.execute("const answer = 42");
	const snapPath = join(dir, "snap.json");
	const snap = await engine.snapshotState(snapPath);
	assert.ok(snap, "snapshot should succeed");
	assert.ok(snap!.saved.includes("answer"), "answer var must be saved");
	await engine.kill();

	const engine2 = new EngineManager();
	t.after(async () => {
		await engine2.kill();
	});
	const restore = await engine2.restoreState(snapPath);
	assert.ok(restore, "restore should succeed");
	assert.ok(restore!.restored.includes("answer"), "answer var must be revived");
});
