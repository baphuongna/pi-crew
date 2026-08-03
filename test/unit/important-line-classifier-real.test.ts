/**
 * P0-B Important-Line Classifier — real-function tests.
 *
 * Imports the REAL exported `splitWithImportantLines`, `isImportantLine`,
 * `extractImportantLines`, and the refactored `compactString` / `readIfSmall`
 * from their source modules. NO local mirrors. This guards against the
 * algorithm drifting from the shipped implementation (the bug that
 * output-handling-l4.test.ts had, fixed in Sprint 1).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { compactString } from "../../src/runtime/child-pi/child-pi.ts";
import {
	extractImportantLines,
	IMPORTANT_LINE_PATTERNS,
	isImportantLine,
	splitWithImportantLines,
} from "../../src/runtime/compaction/important-line-classifier.ts";
import { readIfSmall } from "../../src/runtime/task-output-context.ts";

// --- isImportantLine unit tests (each pattern) ---

test("isImportantLine matches error keywords (error/failed/exception/fatal/panic)", () => {
	assert.ok(isImportantLine("Error: connection refused"));
	assert.ok(isImportantLine("Test FAILED at line 42"));
	assert.ok(isImportantLine("Uncaught exception in handler"));
	assert.ok(isImportantLine("FATAL: out of memory"));
	assert.ok(isImportantLine("kernel panic — not syncing"));
	// false positive (prose) is acceptable; assert at least one true.
	assert.ok(!isImportantLine("All systems operational."));
});

test("isImportantLine matches file:line diagnostics", () => {
	assert.ok(isImportantLine("    at child-pi.ts:383:24"));
	assert.ok(isImportantLine("src/runtime/foo.ts:99:1 — undefined"));
	assert.ok(isImportantLine("/abs/path/App.tsx:42:10"));
	// Plain text with a colon and number but not file:line:
	assert.ok(!isImportantLine("hello world"));
});

test("isImportantLine matches HTTP 4xx/5xx codes", () => {
	assert.ok(isImportantLine("upstream returned 503 Service Unavailable"));
	assert.ok(isImportantLine("GET /api -> 404 Not Found"));
	assert.ok(isImportantLine("error: HTTP 500 from payment gateway"));
	// 2xx/3xx are NOT important (success):
	assert.ok(!isImportantLine("HTTP 200 OK"));
	assert.ok(!isImportantLine("HTTP 301 Moved Permanently"));
});

test("isImportantLine matches k8s/linter 'Warning' (case-sensitive)", () => {
	assert.ok(isImportantLine("Warning: kubelet had a hiccup"));
	assert.ok(isImportantLine("Warning  BackOff  pod restart"));
	// Lowercase prose "warning" should NOT match (avoids noise):
	assert.ok(!isImportantLine("Just a warning to the user."));
	assert.ok(!isImportantLine("She gave him a warning look."));
});

test("isImportantLine matches compiler/linter diagnostic ids", () => {
	assert.ok(isImportantLine("error TS2304: Cannot find name 'foo'"));
	assert.ok(isImportantLine("warning CS0246: type not found"));
	assert.ok(isImportantLine("ESLint: RULE012 unexpected var"));
	// Plain uppercase word with digits that's NOT a diagnostic id pattern (too long):
	assert.ok(!isImportantLine("ABCDEF1234567")); // 13 chars > 5-digit cap
});

// --- extractImportantLines unit tests ---

test("extractImportantLines returns only important lines, preserving order", () => {
	const text = [
		"normal line 1",
		"Error: something broke",
		"normal line 2",
		"    at app.ts:10:5",
		"normal line 3",
		"HTTP 502 Bad Gateway",
	].join("\n");
	const lines = extractImportantLines(text, 30);
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "Error: something broke");
	assert.equal(lines[1], "    at app.ts:10:5");
	assert.equal(lines[2], "HTTP 502 Bad Gateway");
});

test("extractImportantLines caps at maxLines", () => {
	const lines: string[] = [];
	for (let i = 0; i < 50; i++) lines.push(`Error: failure #${i}`);
	assert.equal(extractImportantLines(lines.join("\n"), 10).length, 10);
	assert.equal(extractImportantLines(lines.join("\n"), 30).length, 30);
});

test("extractImportantLines handles \\r\\n line endings", () => {
	const text = "line1\r\nError: bad\r\nline3\r\nWarning  BackOff\r\n";
	const lines = extractImportantLines(text);
	assert.deepEqual(lines, ["Error: bad", "Warning  BackOff"]);
});

test("extractImportantLines returns [] for empty / no-match input", () => {
	assert.deepEqual(extractImportantLines("", 10), []);
	assert.deepEqual(extractImportantLines("nothing important here\njust prose", 10), []);
});

// --- splitWithImportantLines unit tests ---

test("splitWithImportantLines returns input verbatim when value <= maxChars", () => {
	const r = splitWithImportantLines("short", 100);
	assert.equal(r.head, "short");
	assert.equal(r.tail, "");
	assert.deepEqual(r.importantLines, []);
	assert.equal(r.baseDropped, 0);
});

test("splitWithImportantLines returns head(75%)/tail(25%) with no important lines when preserveImportant:false", () => {
	const value = "A".repeat(100) + "Error: in middle\n" + "B".repeat(100);
	const maxChars = 80;
	const r = splitWithImportantLines(value, maxChars, {
		preserveImportant: false,
	});
	assert.equal(r.head.length, 60);
	assert.equal(r.tail.length, 20);
	assert.deepEqual(r.importantLines, []);
	assert.equal(r.baseDropped, value.length - maxChars);
});

test("splitWithImportantLines picks important lines from middle when they fit in slack", () => {
	const value = "HEAD".repeat(400) + "\n" + "Error: middle\n" + "Warning  BackOff\n" + "TAIL".repeat(100);
	const r = splitWithImportantLines(value, 1000, { slackFactor: 0.15 });
	assert.ok(r.importantLines.includes("Error: middle"), "error line must be preserved");
	assert.ok(r.importantLines.includes("Warning  BackOff"), "warning line must be preserved");
});

test("splitWithImportantLines picks whole lines only (does not slice mid-line)", () => {
	// 15% of 100 = 15 chars slack. Each line is 20+ chars → no line should be picked.
	const value = "H".repeat(200) + "\n" + "Error: way too long to fit the budget\n" + "T".repeat(100);
	const r = splitWithImportantLines(value, 100, { slackFactor: 0.15 });
	// Either none fit (the long line exceeds slack alone) or all fit. Never partial.
	for (const line of r.importantLines) {
		assert.ok(line === "Error: way too long to fit the budget" || line.length <= 15, `unexpected partial line: ${line}`);
	}
});

test("splitWithImportantLines caps candidate scan at maxImportantLines", () => {
	// 100 important lines but maxImportantLines=5.
	const lines = Array.from({ length: 100 }, (_, i) => `Error: line ${i}`);
	const value = "H".repeat(500) + "\n" + lines.join("\n") + "\n" + "T".repeat(500);
	const r = splitWithImportantLines(value, 1000, { maxImportantLines: 5 });
	assert.ok(r.importantLines.length <= 5, `expected <=5 important lines, got ${r.importantLines.length}`);
});

// --- compactString integration (REAL function) ---

test("compactString (real) preserves an error line from the middle (default opts)", () => {
	const maxChars = 4096;
	const head = "A".repeat(5000);
	const middle = ["normal line", "Error: crash at runtime", "another normal line"].join("\n");
	const tail = "Z".repeat(2000);
	const value = head + "\n" + middle + "\n" + tail;
	assert.ok(value.length > maxChars, `test fixture must exceed maxChars: value=${value.length} maxChars=${maxChars}`);
	const result = compactString(value, maxChars);
	assert.ok(result.includes("Error: crash at runtime"), "important line must be preserved in result");
	assert.ok(result.includes("Z".repeat(50)), "tail must be preserved");
	assert.match(result, /important lines preserved/, "marker must mention important-line preservation");
});

test("compactString (real) with preserveImportant:false does NOT scan middle", () => {
	const maxChars = 4096;
	const head = "A".repeat(5000);
	const middle = "Error: should NOT be preserved";
	const tail = "Z".repeat(2000);
	const value = head + "\n" + middle + "\n" + tail;
	assert.ok(value.length > maxChars, `test fixture must exceed maxChars: value=${value.length} maxChars=${maxChars}`);
	const result = compactString(value, maxChars, { preserveImportant: false });
	assert.ok(!result.includes("should NOT be preserved"), "error line must be dropped when preserveImportant:false");
	// Marker wording reverts to the old (L4 backward-compat) format:
	assert.match(result, /head\+tail preserved\]/);
	assert.ok(!result.includes("important lines preserved"), "no important-line marker when preserveImportant:false");
});

test("compactString (real) without important lines uses the old marker (L4 backward-compat)", () => {
	const value = "A".repeat(2000) + "B".repeat(5000) + "Z".repeat(2000);
	const result = compactString(value, 4096);
	// Exact old marker — no "+ K important lines" suffix:
	assert.match(result, /\[pi-crew compacted \d+ chars, head\+tail preserved\]/);
	assert.ok(!result.includes("important lines preserved"));
});

test("compactString (real) monotonic-shrink still holds with important-line scanning", () => {
	const threshold = 8192;
	for (let over = 1; over <= 60; over++) {
		const value = "y".repeat(threshold + over);
		const result = compactString(value, threshold);
		assert.ok(result.length <= value.length, `over=${over}: result ${result.length} must be <= input ${value.length}`);
	}
});

test("compactString (real) under-threshold returns input unchanged (with or without preserveImportant)", () => {
	const value = "short text without anything important";
	assert.equal(compactString(value, 8192), value);
	assert.equal(compactString(value, 8192, { preserveImportant: false }), value);
});

// --- readIfSmall integration (REAL function, via temp file) ---

function writeTempFile(content: string): {
	filePath: string;
	cleanup: () => void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p0b-readifsmall-"));
	const filePath = path.join(dir, "input.txt");
	fs.writeFileSync(filePath, content, "utf-8");
	return {
		filePath,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

test("readIfSmall (real) preserves a diagnostic line from the middle of a large file", () => {
	const head = "H".repeat(10_000);
	const middle = "normal\nError: file read failed\nmore normal\n";
	const tail = "T".repeat(10_000);
	const content = head + middle + tail;
	const { filePath, cleanup } = writeTempFile(content);
	try {
		const out = readIfSmall(filePath);
		assert.ok(out, "readIfSmall must return a string for an existing file");
		assert.ok(out.includes("Error: file read failed"), "important middle line must be preserved");
		assert.ok(out.includes("T".repeat(50)), "tail must be preserved");
	} finally {
		cleanup();
	}
});

test("readIfSmall (real) uses old marker (L4 backward-compat) when no important lines", () => {
	const content = "H".repeat(40_000) + "M".repeat(20_000) + "T".repeat(40_000);
	const { filePath, cleanup } = writeTempFile(content);
	try {
		const out = readIfSmall(filePath);
		assert.ok(out);
		assert.match(out, /\[pi-crew truncated \d+ chars, head\+tail preserved\]/);
		assert.ok(!out.includes("important lines preserved"));
	} finally {
		cleanup();
	}
});

// --- IMPORTANT_LINE_PATTERNS export sanity ---

test("IMPORTANT_LINE_PATTERNS has exactly 5 patterns (matches Hypa classifier)", () => {
	assert.equal(IMPORTANT_LINE_PATTERNS.length, 5);
});
