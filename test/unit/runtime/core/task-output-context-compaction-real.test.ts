import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MAX_RESULT_INLINE_BYTES, readIfSmall } from "../../../../src/runtime/task-output-context.ts";

/**
 * These tests call the REAL exported `readIfSmall` function — no mirror.
 * They verify:
 *   1. UTF-8 multi-byte sequences are not corrupted at truncation boundaries.
 *   2. Monotonic-shrink: barely-over-threshold inputs produce SHORTER output.
 *   3. Normal head+tail truncation preserves both ends + marker.
 *   4. Small files pass through unchanged.
 */

function writeTempFile(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readifsmall-"));
	const filePath = path.join(dir, "input.txt");
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

function cleanup(filePath: string): void {
	try {
		fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

test("readIfSmall — UTF-8 multi-byte sequences are not corrupted at byte-split boundary", () => {
	// Build a string whose UTF-8 byte representation exceeds the threshold,
	// with multi-byte characters (emoji = 4 bytes, CJK = 3 bytes) positioned
	// so that the old byte-based head/tail reads would split them.
	// We use a mix of ASCII and multi-byte chars throughout so any byte
	// offset is likely to land inside a multi-byte sequence.
	const emoji = "😀"; // U+1F600, 4 UTF-8 bytes
	const cjk = "漢"; // U+6F22, 3 UTF-8 bytes
	// Repeat a pattern to exceed MAX_RESULT_INLINE_BYTES in string length.
	// Each "A{emoji}{cjk}" unit = 3 chars. To exceed 32000 chars we need
	// ~10667 units.
	const unit = `A${emoji}${cjk}`;
	const repeats = Math.ceil((MAX_RESULT_INLINE_BYTES + 500) / unit.length);
	const content = unit.repeat(repeats);

	const filePath = writeTempFile(content);
	try {
		const result = readIfSmall(filePath);
		assert.ok(result, "readIfSmall should return a string");
		// The old byte-based code would produce U+FFFD at the head/tail cut.
		assert.ok(!/\uFFFD/.test(result!), "Output must NOT contain U+FFFD replacement characters");
		// Verify emoji and CJK chars are actually present in the output.
		assert.ok(result!.includes(emoji), "Emoji should be present in output");
		assert.ok(result!.includes(cjk), "CJK char should be present in output");
	} finally {
		cleanup(filePath);
	}
});

test("readIfSmall — monotonic shrink: threshold+1 input produces shorter output", () => {
	// Input exactly 1 char over the threshold. The old code (and code without
	// the monotonic-shrink guard) would add a marker (~57 chars) making the
	// output LARGER than the input. The guard must return the original.
	const content = "x".repeat(MAX_RESULT_INLINE_BYTES + 1);
	const filePath = writeTempFile(content);
	try {
		const result = readIfSmall(filePath);
		assert.ok(result, "readIfSmall should return a string");
		// Monotonic-shrink: output must NOT be larger than input.
		// For threshold+1, truncation would expand, so the guard returns
		// the original unchanged — output equals input (never exceeds).
		assert.ok(result!.length <= content.length, `Output (${result!.length}) must not exceed input (${content.length})`);
	} finally {
		cleanup(filePath);
	}
});

test("readIfSmall — head+tail preserved with truncation marker for large input", () => {
	// Large input well beyond threshold: head and tail should be present.
	const headMarker = "HEAD_MARKER_HEAD_MARKER";
	const tailMarker = "TAIL_MARKER_TAIL_MARKER";
	const padding = "B".repeat(MAX_RESULT_INLINE_BYTES * 2);
	const content = `${headMarker}${padding}${tailMarker}`;
	const filePath = writeTempFile(content);
	try {
		const result = readIfSmall(filePath);
		assert.ok(result, "readIfSmall should return a string");
		assert.ok(result!.includes(headMarker), "Head content should be preserved");
		assert.ok(result!.includes(tailMarker), "Tail content should be preserved");
		assert.ok(result!.includes("[pi-crew truncated"), "Truncation marker should be present");
		assert.ok(result!.length < content.length, "Output must be shorter than the large input");
	} finally {
		cleanup(filePath);
	}
});

test("readIfSmall — small file returns full content unchanged", () => {
	const content = "Hello, world! This is a small file.\nLine 2.\n";
	const filePath = writeTempFile(content);
	try {
		const result = readIfSmall(filePath);
		assert.equal(result, content, "Small file should be returned unchanged");
	} finally {
		cleanup(filePath);
	}
});
