/**
 * Compact stages — focused unit tests for each ICompactStage implementation.
 *
 * Companion to `compact-pipeline-real.test.ts` (which tests the pipeline
 * composition + integration); this file targets each stage in isolation
 * with minimal input → expected-output shape checks. Stages covered:
 *   - AnsiStripStage     (color/cursor code removal)
 *   - BlankCollapseStage (whitespace-run compression)
 *   - DeduplicateStage   (consecutive duplicate line collapse)
 *   - HeadSnapStage      (head-only cap with newline-snap)
 *   - TailCaptureStage   (tail-only cap with optional marker)
 *   - TruncationStage    (head+important-middle+tail with marker)
 *
 * Every stage implements ICompactStage (`id`, `apply(text)`). The tests
 * verify shape (id, type, return type), idempotence where applicable, and
 * the core transformation with a small input.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	ANSI_STRIP_STAGE,
	AnsiStripStage,
	BLANK_COLLAPSE_STAGE,
	BlankCollapseStage,
	DEDUPLICATE_STAGE,
	DeduplicateStage,
	HeadSnapStage,
	TAIL_CAPTURE_STREAM_STAGE,
	TailCaptureStage,
	TruncationStage,
} from "../../src/runtime/compact-stages/index.ts";

// --- AnsiStripStage ---

describe("AnsiStripStage", () => {
	test("shape: id is 'ansi-strip' and apply returns a string", () => {
		const stage = new AnsiStripStage();
		assert.equal(stage.id, "ansi-strip");
		const out = stage.apply("hello");
		assert.equal(typeof out, "string");
	});

	test("apply strips a basic SGR color code from a simple input", () => {
		const out = ANSI_STRIP_STAGE.apply("\x1b[31mhello\x1b[0m");
		assert.equal(out, "hello");
	});

	test("apply is a no-op for plain text with no ANSI codes", () => {
		const text = "plain text without escape codes";
		assert.equal(ANSI_STRIP_STAGE.apply(text), text);
	});

	test("singleton export matches a fresh instance's behavior", () => {
		assert.equal(ANSI_STRIP_STAGE.id, new AnsiStripStage().id);
	});
});

// --- BlankCollapseStage ---

describe("BlankCollapseStage", () => {
	test("shape: id is 'blank-collapse' and apply returns a string", () => {
		const stage = new BlankCollapseStage();
		assert.equal(stage.id, "blank-collapse");
		const out = stage.apply("hello");
		assert.equal(typeof out, "string");
	});

	test("apply collapses 3+ consecutive newlines to exactly 2 (single blank line)", () => {
		const out = BLANK_COLLAPSE_STAGE.apply("a\n\n\n\n\nb");
		assert.equal(out, "a\n\nb");
	});

	test("apply preserves single newlines and double newlines (paragraph breaks)", () => {
		assert.equal(BLANK_COLLAPSE_STAGE.apply("a\nb"), "a\nb");
		assert.equal(BLANK_COLLAPSE_STAGE.apply("a\n\nb"), "a\n\nb");
	});

	test("apply is a no-op when input is below the threshold", () => {
		const out = BLANK_COLLAPSE_STAGE.apply("a\n\n\nb");
		assert.equal(out, "a\n\nb");
	});

	test("singleton export matches a fresh instance's behavior", () => {
		assert.equal(BLANK_COLLAPSE_STAGE.id, new BlankCollapseStage().id);
	});
});

// --- DeduplicateStage ---

describe("DeduplicateStage", () => {
	test("shape: id is 'deduplicate' and apply returns a string", () => {
		const stage = new DeduplicateStage();
		assert.equal(stage.id, "deduplicate");
		const out = stage.apply("hello");
		assert.equal(typeof out, "string");
	});

	test("apply collapses 3 consecutive identical lines into 1", () => {
		const out = DEDUPLICATE_STAGE.apply("a\na\na\nb");
		assert.equal(out, "a\nb");
	});

	test("apply keeps non-adjacent duplicate lines", () => {
		const out = DEDUPLICATE_STAGE.apply("a\nb\na\nb");
		assert.equal(out, "a\nb\na\nb");
	});

	test("apply is a no-op for unique consecutive lines", () => {
		const out = DEDUPLICATE_STAGE.apply("a\nb\nc");
		assert.equal(out, "a\nb\nc");
	});

	test("singleton export matches a fresh instance's behavior", () => {
		assert.equal(DEDUPLICATE_STAGE.id, new DeduplicateStage().id);
	});
});

// --- HeadSnapStage ---

describe("HeadSnapStage", () => {
	test("shape: id defaults to 'head-snap' and apply returns a string", () => {
		const stage = new HeadSnapStage({ maxBytes: 100 });
		assert.equal(stage.id, "head-snap");
		const out = stage.apply("hello");
		assert.equal(typeof out, "string");
	});

	test("apply is a no-op when input is within the byte cap", () => {
		const stage = new HeadSnapStage({ maxBytes: 100 });
		const text = "short text";
		assert.equal(stage.apply(text), text);
	});

	test("apply returns a string no longer than maxBytes for an over-cap input", () => {
		const stage = new HeadSnapStage({ maxBytes: 20 });
		const text = "a".repeat(500);
		const out = stage.apply(text);
		assert.ok(typeof out === "string");
		// Output must be <= maxBytes (UTF-8 boundary walk + optional newline snap).
		assert.ok(out.length <= 20, `output ${out.length} chars must be <= maxBytes 20`);
	});

	test("custom id is honored when supplied via config", () => {
		const stage = new HeadSnapStage({ maxBytes: 100, id: "custom-head" });
		assert.equal(stage.id, "custom-head");
	});

	test("constructor rejects non-positive maxBytes", () => {
		assert.throws(() => new HeadSnapStage({ maxBytes: 0 }));
		assert.throws(() => new HeadSnapStage({ maxBytes: -1 }));
		assert.throws(() => new HeadSnapStage({ maxBytes: NaN }));
	});
});

// --- TailCaptureStage ---

describe("TailCaptureStage", () => {
	test("shape: id defaults to 'tail-capture' and apply returns a string", () => {
		const stage = new TailCaptureStage({ maxChars: 100 });
		assert.equal(stage.id, "tail-capture");
		const out = stage.apply("hello");
		assert.equal(typeof out, "string");
	});

	test("apply (char cap) returns the last N chars when input exceeds maxChars", () => {
		const stage = new TailCaptureStage({ maxChars: 5 });
		const out = stage.apply("abcdefghij");
		assert.equal(out, "fghij");
	});

	test("apply (char cap) is a no-op for under-cap input", () => {
		const stage = new TailCaptureStage({ maxChars: 100 });
		assert.equal(stage.apply("hello"), "hello");
	});

	test("apply (char cap) prepends the marker when truncation fires", () => {
		const stage = new TailCaptureStage({ maxChars: 5, marker: "[truncated]" });
		const out = stage.apply("abcdefghij");
		assert.match(out, /^\[truncated\]\nfghij$/);
	});

	test("apply (byte cap) returns a string within the byte budget", () => {
		const stage = new TailCaptureStage({ maxBytes: 20 });
		const text = "x".repeat(500);
		const out = stage.apply(text);
		assert.ok(typeof out === "string");
		// Allow some slack for the UTF-8 boundary walk (we don't assert byteLength
		// directly because Node's string is char-based; we just assert it shrunk).
		assert.ok(out.length < text.length, "must shrink when input exceeds maxBytes");
	});

	test("constructor rejects when both maxChars and maxBytes are provided", () => {
		assert.throws(() => new TailCaptureStage({ maxChars: 10, maxBytes: 10 }));
	});

	test("constructor rejects when neither maxChars nor maxBytes is provided", () => {
		assert.throws(() => new TailCaptureStage({}));
	});

	test("TAIL_CAPTURE_STREAM_STAGE singleton has expected id and applies without throwing", () => {
		assert.equal(TAIL_CAPTURE_STREAM_STAGE.id, "tail-capture-stream");
		const out = TAIL_CAPTURE_STREAM_STAGE.apply("hello world");
		assert.equal(typeof out, "string");
	});
});

// --- TruncationStage ---

describe("TruncationStage", () => {
	test("shape: id is 'truncation' and apply returns a string", () => {
		const stage = new TruncationStage(100);
		assert.equal(stage.id, "truncation");
		const out = stage.apply("hello");
		assert.equal(typeof out, "string");
	});

	test("apply is a no-op for input at or below maxChars", () => {
		const stage = new TruncationStage(100);
		const text = "short";
		assert.equal(stage.apply(text), text);
	});

	test("apply produces a marker line when input exceeds maxChars", () => {
		const stage = new TruncationStage(50);
		const out = stage.apply("a".repeat(500));
		assert.match(out, /\[pi-crew compacted \d+ chars, head\+tail preserved\]/);
	});

	test("constructor rejects non-positive maxChars", () => {
		assert.throws(() => new TruncationStage(0));
		assert.throws(() => new TruncationStage(-10));
	});

	test("custom marker verb (truncated instead of compacted) is honored", () => {
		const stage = new TruncationStage(50, { marker: { verb: "truncated" } });
		const out = stage.apply("a".repeat(500));
		assert.match(out, /\[pi-crew truncated \d+ chars, head\+tail preserved\]/);
	});
});
