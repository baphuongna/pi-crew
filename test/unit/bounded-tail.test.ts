/**
 * BoundedTail — correctness + performance regression guard (P0-1 fix).
 *
 * BoundedTail replaces the O(n²) `appendBoundedTail` rebuild-per-line pattern.
 * The headline regression guard: 5,000 multi-byte (CJK) lines must complete in
 * well under a second — the old algorithm took ~112 s on the same workload
 * (audit 2026-07-29). A regression back to full-buffer-rescan-per-line would
 * blow past the gate by 100×+.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BoundedTail } from "../../src/runtime/compact-stages/bounded-tail.ts";
import { TailCaptureStage } from "../../src/runtime/compact-stages/tail-capture-stage.ts";

const MAX = 512 * 1024; // DEFAULT_CHILD_PI.maxCaptureBytes

test("BoundedTail: under cap returns combined verbatim, no marker", () => {
	const tail = new BoundedTail(MAX);
	tail.push("hello ");
	tail.push("world");
	assert.equal(tail.value(), "hello world");
	assert.ok(!tail.value().includes("truncated"));
});

test("BoundedTail: empty returns empty string", () => {
	assert.equal(new BoundedTail(MAX).value(), "");
});

test("BoundedTail: over cap (ASCII) returns marker + last ≤maxBytes, ending with recent content", () => {
	const tail = new BoundedTail(200);
	// Push ~2KB in small chunks so the cap fires via segment-drop.
	for (let i = 0; i < 40; i++) tail.push(`X`.repeat(50) + "\n");
	const out = tail.value();
	assert.ok(out.startsWith("[pi-crew captured output truncated to last 0 KiB]\n"), "marker present");
	assert.ok(Buffer.byteLength(out, "utf-8") <= 200 + 80, "bounded near maxBytes"); // marker + body
	assert.ok(out.endsWith("X".repeat(50) + "\n"), "most-recent content preserved at the tail");
});

test("BoundedTail: over cap (CJK) byte-exact — no partial multi-byte sequence", () => {
	const tail = new BoundedTail(300); // sub-char-boundary cap to force a trim
	for (let i = 0; i < 1000; i++) tail.push("字".repeat(10)); // 3 bytes/char
	const out = tail.value();
	// Must decode cleanly (no U+FFFD replacement from a split sequence).
	assert.ok(!out.includes("\uFFFD"), "no replacement char from split multi-byte sequence");
	const body = out.split("\n").slice(1).join("\n"); // drop marker
	assert.ok(Buffer.byteLength(body, "utf-8") <= 300, "body within byte cap");
	assert.ok(body.endsWith("字"), "ends on a full CJK char");
});

test("BoundedTail: marker wording parity with old TailCaptureStage path", () => {
	const tail = new BoundedTail(1024 * 4);
	tail.push("A".repeat(10_000));
	const viaTail = tail.value();
	const viaStage = new TailCaptureStage({
		maxBytes: 1024 * 4,
		marker: "[pi-crew captured output truncated to last 4 KiB]",
	}).apply("A".repeat(10_000));
	assert.equal(viaTail.startsWith("[pi-crew captured output truncated to last 4 KiB]\n"), true, "same marker wording + separator");
	// Both keep the last 4 KiB of 'A's; only the leading marker differs in length parity.
	assert.ok(viaTail.endsWith("A".repeat(4096)));
	assert.ok(viaStage.endsWith("A".repeat(4096)));
});

test("BoundedTail: value() is cached (idempotent, stable reference content)", () => {
	const tail = new BoundedTail(MAX);
	tail.push("abc");
	const a = tail.value();
	const b = tail.value();
	assert.equal(a, b);
	tail.push("def");
	assert.equal(tail.value(), "abcdef");
});

test("PERF GATE: 5,000 CJK lines complete far under 1s (regression was ~112s)", () => {
	const line = "字".repeat(200) + "\n"; // 200 CJK chars ≈ 600 bytes/line
	const tail = new BoundedTail(MAX);
	const t0 = performance.now();
	for (let i = 0; i < 5000; i++) tail.push(line);
	const out = tail.value();
	const ms = performance.now() - t0;
	// Old O(n²) algorithm: ~112,138 ms on this workload. Gate at 1000 ms leaves
	// 100×+ headroom against CI jitter while still catching any full-rescan regression.
	assert.ok(ms < 1000, `BoundedTail 5000 CJK lines took ${ms.toFixed(1)} ms (gate < 1000)`);
	assert.ok(Buffer.byteLength(out, "utf-8") <= MAX + 80, "output bounded");
	assert.ok(out.endsWith("\n"), "ends with the most recent line");
});

test("PERF GATE: 5,000 ASCII lines complete far under 1s (regression was ~2.3s)", () => {
	const line = "x".repeat(200) + "\n";
	const tail = new BoundedTail(MAX);
	const t0 = performance.now();
	for (let i = 0; i < 5000; i++) tail.push(line);
	tail.value();
	const ms = performance.now() - t0;
	assert.ok(ms < 1000, `BoundedTail 5000 ASCII lines took ${ms.toFixed(1)} ms (gate < 1000)`);
});
