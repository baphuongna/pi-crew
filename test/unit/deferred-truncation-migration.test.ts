/**
 * Sprint 5 — Migrate 5 deferred truncation points through the stage-chain.
 *
 * Of the 5 truncation points flagged as deferred in v0.9.12's CHANGELOG, three
 * have been migrated in this sprint via two new compact-stages:
 *
 *   - `TailCaptureStage` (char or byte cap, optional marker) — migrates
 *     `appendBoundedTail` (child-pi.ts:52) and the `stream-preview.ts`
 *     textBuffer truncation.
 *   - `HeadSnapStage` (byte cap, optional newline-snap) — migrates
 *     `iteration-hooks.ts` `truncateToLimit` (now removed; call site inlined
 *     the HeadSnapStage).
 *
 * Deferred (still not migrated):
 *   - `async-runner.ts` stderr "stop capturing" semantic — state machine
 *     tied to chunk-by-chunk consumption; not a stage-chain fit.
 *   - `chain-runner.ts` array caps (`.slice(0, 50)`, `.slice(0, 20)`) —
 *     operate on arrays not strings; pipeline abstraction doesn't apply.
 *
 * Tests in this file call the REAL exported stages and verify behavior
 * equivalent to the pre-Sprint-5 inline implementations.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { HeadSnapStage, TAIL_CAPTURE_STREAM_STAGE, TailCaptureStage } from "../../src/runtime/compaction/compact-stages/index.ts";

// --- TailCaptureStage: char cap mode ---

test("TailCaptureStage (char cap): under cap returns input verbatim", () => {
	const stage = new TailCaptureStage({ maxChars: 100 });
	const text = "short text";
	assert.equal(stage.apply(text), text);
});

test("TailCaptureStage (char cap): over cap returns last maxChars characters (no marker)", () => {
	const stage = new TailCaptureStage({ maxChars: 10 });
	const text = "A".repeat(50) + "TAIL";
	// Last 10 chars of "AAAA...A(50x)TAIL" = 6 A's + "TAIL" = "AAAAAATAIL".
	assert.equal(stage.apply(text), "AAAAAATAIL");
});

test("TailCaptureStage (char cap): with marker prepends marker + newline when truncating", () => {
	const stage = new TailCaptureStage({ maxChars: 5, marker: "[truncated]" });
	const out = stage.apply("A".repeat(50));
	assert.equal(out, "[truncated]\nAAAAA");
});

test("TailCaptureStage (char cap): with marker returns input verbatim when under cap (no spurious marker)", () => {
	const stage = new TailCaptureStage({
		maxChars: 100,
		marker: "[truncated]",
	});
	const text = "short text";
	assert.equal(stage.apply(text), text);
});

// --- TailCaptureStage: byte cap mode ---

test("TailCaptureStage (byte cap): under cap returns input verbatim", () => {
	const stage = new TailCaptureStage({ maxBytes: 100 });
	const text = "short text";
	assert.equal(stage.apply(text), text);
});

test("TailCaptureStage (byte cap): over cap returns last maxBytes bytes snapped to UTF-8 boundary", () => {
	// ASCII text so byte cap == char cap; last 10 bytes = "AAAAAATAIL".
	const stage = new TailCaptureStage({ maxBytes: 10 });
	const text = "A".repeat(50) + "TAIL";
	assert.equal(stage.apply(text), "AAAAAATAIL");
});

test("TailCaptureStage (byte cap): UTF-8 boundary safety (no partial multi-byte sequence in tail)", () => {
	// Build a string where the cut would land inside a multi-byte char.
	// "😀" is 4 bytes in UTF-8.
	const emoji = "😀"; // 4 bytes
	const filler = "A".repeat(5);
	const stage = new TailCaptureStage({ maxBytes: 7 });
	// filler(5 bytes) + emoji(4 bytes) = 9 bytes total
	const text = filler + emoji;
	const out = stage.apply(text);
	// Output must be valid UTF-8 (no \uFFFD replacement chars).
	assert.ok(!out.includes("\uFFFD"), `tail must not contain U+FFFD: ${out}`);
	// And must contain exactly maxBytes bytes (or fewer if multi-byte snap).
	assert.ok(Buffer.byteLength(out, "utf-8") <= 7, `output bytes ${Buffer.byteLength(out, "utf-8")} must be <= 7`);
});

test("TailCaptureStage (byte cap): with marker prepends marker + newline when truncating", () => {
	const stage = new TailCaptureStage({ maxBytes: 5, marker: "[truncated]" });
	const out = stage.apply("A".repeat(50));
	assert.equal(out, "[truncated]\nAAAAA");
});

// --- TailCaptureStage: validation ---

test("TailCaptureStage: rejects when both maxChars and maxBytes are provided", () => {
	assert.throws(() => new TailCaptureStage({ maxChars: 10, maxBytes: 10 }), /exactly one/);
});

test("TailCaptureStage: rejects when neither maxChars nor maxBytes is provided", () => {
	assert.throws(() => new TailCaptureStage({}), /exactly one/);
});

test("TailCaptureStage: rejects non-positive maxChars", () => {
	assert.throws(() => new TailCaptureStage({ maxChars: 0 }), /maxChars/);
	assert.throws(() => new TailCaptureStage({ maxChars: -5 }), /maxChars/);
});

test("TailCaptureStage: rejects non-positive maxBytes", () => {
	assert.throws(() => new TailCaptureStage({ maxBytes: 0 }), /maxBytes/);
	assert.throws(() => new TailCaptureStage({ maxBytes: -1 }), /maxBytes/);
});

// --- TAIL_CAPTURE_STREAM_STAGE singleton ---

test("TAIL_CAPTURE_STREAM_STAGE singleton: under cap returns verbatim", () => {
	const text = "x".repeat(1000);
	assert.equal(TAIL_CAPTURE_STREAM_STAGE.apply(text), text);
});

test("TAIL_CAPTURE_STREAM_STAGE singleton: over cap returns last 16_384 chars", () => {
	const text = "A".repeat(20_000) + "TAIL";
	const out = TAIL_CAPTURE_STREAM_STAGE.apply(text);
	assert.equal(out.length, 16_384);
	assert.ok(out.endsWith("TAIL"), "tail end must be preserved");
	assert.ok(!out.includes("truncated"), "no marker in stream stage (raw text only)");
});

// --- HeadSnapStage ---

test("HeadSnapStage: under cap returns input verbatim", () => {
	const stage = new HeadSnapStage({ maxBytes: 100 });
	assert.equal(stage.apply("short text"), "short text");
});

test("HeadSnapStage: over cap returns first maxBytes snapped to last newline", () => {
	const stage = new HeadSnapStage({ maxBytes: 20 });
	// 20 bytes head region with newline at index 10 → snap to index 10.
	const text = "0123456789\nmore content after the newline";
	const out = stage.apply(text);
	assert.equal(out, "0123456789");
});

test("HeadSnapStage: over cap without newline returns full slice (no snap possible)", () => {
	const stage = new HeadSnapStage({ maxBytes: 10 });
	const text = "A".repeat(50);
	const out = stage.apply(text);
	assert.equal(out, "A".repeat(10));
});

test("HeadSnapStage: snapToNewline=false disables the snap", () => {
	const stage = new HeadSnapStage({ maxBytes: 20, snapToNewline: false });
	const text = "0123456789\nmore content after the newline";
	// First 20 bytes of ASCII text = "0123456789\nmore cont" (positions 0-19).
	const out = stage.apply(text);
	assert.equal(out, "0123456789\nmore cont");
});

test("HeadSnapStage: UTF-8 boundary safety (walks back partial multi-byte sequences)", () => {
	const emoji = "😀"; // 4 bytes
	// Build a string where the head slice would land mid-emoji.
	const text = "ABC" + emoji + "DEF";
	// maxBytes=5 would slice "ABC😀" but 😀 starts at index 3 (4 bytes), so the
	// slice "ABC" is 3 bytes (under cap), but "ABC😀" is 7 bytes (over).
	// The stage should snap back to "ABC" to avoid splitting the emoji.
	const stage = new HeadSnapStage({ maxBytes: 5 });
	const out = stage.apply(text);
	assert.ok(!out.includes("\uFFFD"), `output must not contain U+FFFD: ${out}`);
	assert.equal(out, "ABC");
});

test("HeadSnapStage: rejects non-positive maxBytes", () => {
	assert.throws(() => new HeadSnapStage({ maxBytes: 0 }));
	assert.throws(() => new HeadSnapStage({ maxBytes: -1 }));
	assert.throws(() => new HeadSnapStage({ maxBytes: NaN }));
});

// --- appendBoundedTail integration (migrated to TailCaptureStage) ---

test("appendBoundedTail (migrated): under cap returns combined verbatim", () => {
	// Import the function via a small re-export to verify behavior equivalence.
	// (appendBoundedTail is private in child-pi.ts so we test it via the stage
	// the same way the production code does.)
	const combined = "A".repeat(100) + "B".repeat(100);
	const maxBytes = 1000;
	const stage = new TailCaptureStage({
		maxBytes,
		marker: `[pi-crew captured output truncated to last ${Math.round(maxBytes / 1024)} KiB]`,
	});
	assert.equal(stage.apply(combined), combined);
});

test("appendBoundedTail (migrated): over cap returns marker + tail", () => {
	const combined = "A".repeat(2000);
	const maxBytes = 100;
	const stage = new TailCaptureStage({
		maxBytes,
		marker: `[pi-crew captured output truncated to last ${Math.round(maxBytes / 1024)} KiB]`,
	});
	const out = stage.apply(combined);
	assert.ok(out.startsWith("[pi-crew captured output truncated to last 0 KiB]\n"));
	assert.ok(out.length < combined.length);
	assert.ok(out.endsWith("A".repeat(maxBytes - 5)), "tail preserved");
});

// --- stream-preview.ts textBuffer integration ---

test("stream-preview textBuffer truncation: under cap returns verbatim", () => {
	const text = "x".repeat(100);
	const out = TAIL_CAPTURE_STREAM_STAGE.apply(text);
	assert.equal(out, text);
});

test("stream-preview textBuffer truncation: over cap returns last 16_384 chars", () => {
	// Simulate two consecutive text events like the stream-preview feedJsonEvent does.
	const text1 = "A".repeat(10_000);
	const text2 = "B".repeat(10_000);
	const appended1 = TAIL_CAPTURE_STREAM_STAGE.apply(text1);
	const appended2 = TAIL_CAPTURE_STREAM_STAGE.apply(appended1.length > 0 ? appended1 + "\n" + text2 : text2);
	// Result must be exactly 16_384 chars (the last 16_384 of the combined input).
	assert.equal(appended2.length, 16_384);
	assert.ok(appended2.endsWith("B"), "last event's content must be at the end");
});

test("stream-preview textBuffer truncation: NO marker in stream stage (raw text for UI)", () => {
	const out = TAIL_CAPTURE_STREAM_STAGE.apply("A".repeat(20_000));
	assert.ok(!out.includes("truncated") && !out.includes("..."), "stream stage must NOT add any prefix marker");
});

// --- iteration-hooks integration (migrated to HeadSnapStage) ---

test("iteration-hooks stdout truncation: under cap returns full decoded text", () => {
	// Simulate the iteration-hooks pipeline: concat chunks → toString → HeadSnapStage.
	const chunk1 = Buffer.from("first chunk\n");
	const chunk2 = Buffer.from("second chunk\n");
	const rawStdout = Buffer.concat([chunk1, chunk2]);
	const MAX_STDOUT_BYTES = 8192;
	const stdout = new HeadSnapStage({ maxBytes: MAX_STDOUT_BYTES }).apply(rawStdout.toString("utf-8"));
	assert.equal(stdout, "first chunk\nsecond chunk\n");
});

test("iteration-hooks stdout truncation: over cap with newline in head snaps to newline", () => {
	// Build a stdout with newline positions in the head region. The head slice
	// (first 8192 bytes) contains BOTH line1 and line2 endings; the snap drops
	// everything after the LAST newline in the head region, so the result is
	// the two-line prefix with no trailing partial line and no filler.
	const line1 = "first line of output\n"; // 21 bytes
	const line2 = "second line of output\n"; // 22 bytes
	const filler = "X".repeat(8200); // pushes past the 8KB cap
	const raw = Buffer.concat([Buffer.from(line1), Buffer.from(line2), Buffer.from(filler)]);
	const MAX_STDOUT_BYTES = 8192;
	const stdout = new HeadSnapStage({ maxBytes: MAX_STDOUT_BYTES }).apply(raw.toString("utf-8"));
	// Snap drops the partial trailing line (no \n after it) — result is the
	// prefix up to and not including the last newline in the head region.
	assert.ok(stdout.endsWith("second line of output"), "should snap at the LAST newline in the head region");
	assert.ok(!stdout.includes("filler"), "filler (after the snap point) must be dropped");
	assert.ok(!stdout.includes("XXX"), "no X characters from filler");
});

test("iteration-hooks stdout truncation: empty stdout returns empty string", () => {
	const stdout = new HeadSnapStage({ maxBytes: 8192 }).apply(Buffer.alloc(0).toString("utf-8"));
	assert.equal(stdout, "");
});

// --- L4 backward-compat: old inline truncation behavior preserved by the new stages ---

test("L4 backward-compat: appendBoundedTail-style marker wording is preserved by TailCaptureStage", () => {
	// Pre-Sprint-5 appendBoundedTail produced markers like:
	//   [pi-crew captured output truncated to last X KiB]
	// The migrated function passes exactly this marker to TailCaptureStage.
	const stage = new TailCaptureStage({
		maxBytes: 1024 * 4,
		marker: "[pi-crew captured output truncated to last 4 KiB]",
	});
	const out = stage.apply("A".repeat(10_000));
	assert.ok(out.startsWith("[pi-crew captured output truncated to last 4 KiB]\n"));
});

test("L4 backward-compat: stream-preview textBuffer truncation is bit-identical to pre-Sprint-5 inline logic", () => {
	// Pre-Sprint-5 logic: appended.slice(appended.length - MAX_TEXT_BUFFER)
	// Post-Sprint-5 logic:  TAIL_CAPTURE_STREAM_STAGE.apply(appended)
	// For inputs at or below the cap, both return input verbatim.
	// For inputs over the cap, both return the last MAX_TEXT_BUFFER chars.
	const MAX_TEXT_BUFFER = 16_384;
	const text = "A".repeat(MAX_TEXT_BUFFER - 1);
	assert.equal(TAIL_CAPTURE_STREAM_STAGE.apply(text), text, "under cap: bit-identical");
	const text2 = "A".repeat(MAX_TEXT_BUFFER + 1000);
	const inline = text2.slice(text2.length - MAX_TEXT_BUFFER);
	const stage = TAIL_CAPTURE_STREAM_STAGE.apply(text2);
	assert.equal(stage, inline, "over cap: bit-identical to pre-Sprint-5 inline slice");
});

test("L4 backward-compat: iterate-hooks newline-snap behavior is preserved by HeadSnapStage", () => {
	// Pre-Sprint-5 truncateToLimit: take first N bytes, snap to last newline in that range.
	// Post-Sprint-5: HeadSnapStage with snapToNewline=true (default) does the same.
	const text = "0123456789\nABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const stage = new HeadSnapStage({ maxBytes: 20 });
	assert.equal(stage.apply(text), "0123456789");
});
