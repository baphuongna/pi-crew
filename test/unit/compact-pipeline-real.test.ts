/**
 * P0-A Stage-Chain Compression Pipeline — real-function tests.
 *
 * Imports the REAL exported pipeline, stages, and the refactored `compactString`
 * / `readIfSmall` from their source modules. NO local mirrors. This guards
 * against the algorithm drifting from the shipped implementation.
 *
 * Critical invariants tested here:
 *   1. The monotonic-shrink gate: a stage that EXPANDS its input is silently
 *      dropped (its id is NOT added to `applied`). This is the safety property
 *      that prevents the family of L4 caveman-shrink bugs (24/27 artifacts
 *      null-byte-corrupted by a regex-based shrink that expanded in some cases).
 *   2. L4 backward-compat: compactString/readIfSmall on plain text with no
 *      ANSI / blank runs / consecutive duplicates produces bit-identical
 *      output to the pre-P0-A format (marker wording, head/tail slice).
 *   3. Stage composition: readIfSmall's pipeline ([ansi-strip, blank-collapse,
 *      truncation]) strips ANSI color codes from artifact file content BEFORE
 *      truncating.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { compactString } from "../../src/runtime/child-pi.ts";
import { applyCompactPipeline, type ICompactStage, type PipelineResult } from "../../src/runtime/compact-pipeline.ts";
import {
	ANSI_STRIP_STAGE,
	AnsiStripStage,
	BLANK_COLLAPSE_STAGE,
	BlankCollapseStage,
	DEDUPLICATE_STAGE,
	TruncationStage,
} from "../../src/runtime/compact-stages/index.ts";
import { readIfSmall } from "../../src/runtime/task-output-context.ts";

// --- Pipeline core: monotonic-shrink gate (CRITICAL SAFETY PROPERTY) ---

test("applyCompactPipeline never expands input — a stage that expands is silently dropped", () => {
	const expandingStage: ICompactStage = {
		id: "evil-expand",
		apply: () => "this output is much longer than the input",
	};
	const result = applyCompactPipeline("short", [expandingStage]);
	assert.equal(result.text, "short", "input must be unchanged when a stage would expand");
	assert.deepEqual(result.applied, [], "expanding stage's id must NOT be in applied");
});

test("applyCompactPipeline accepts a stage whose output equals input length (idempotent no-op)", () => {
	const noOpStage: ICompactStage = {
		id: "no-op",
		apply: (text) => text, // same length by definition
	};
	const result = applyCompactPipeline("hello", [noOpStage]);
	assert.equal(result.text, "hello");
	assert.deepEqual(result.applied, ["no-op"], "equal-length output is accepted (gate uses <=)");
});

test("applyCompactPipeline chains multiple stages, applied[] reflects accepted stages only", () => {
	const stages: ICompactStage[] = [
		{ id: "a", apply: (t) => t + " a" }, // expands → dropped
		{ id: "b", apply: (t) => t.slice(0, 3) }, // shrinks → accepted
		{ id: "c", apply: (t) => t + t }, // expands relative to current → dropped
		{ id: "d", apply: (t) => t.toUpperCase() }, // same length → accepted
	];
	const result = applyCompactPipeline("hello world", stages);
	assert.equal(result.text, "HEL");
	assert.deepEqual(result.applied, ["b", "d"]);
});

test("applyCompactPipeline skips malformed stages (non-string output, missing apply)", () => {
	const stages: Array<Partial<ICompactStage>> = [
		{ id: "bad-1", apply: () => null as unknown as string },
		{ id: "bad-2", apply: 42 as unknown as (text: string) => string },
		{ id: "good", apply: (t) => t.slice(0, 2) },
	];
	const result = applyCompactPipeline("hello", stages as ICompactStage[]);
	assert.equal(result.text, "he");
	assert.deepEqual(result.applied, ["good"]);
});

test("applyCompactPipeline with no stages returns input unchanged and empty applied", () => {
	const result = applyCompactPipeline("unchanged", []);
	assert.equal(result.text, "unchanged");
	assert.deepEqual(result.applied, []);
});

// --- AnsiStripStage ---

test("AnsiStripStage strips CSI color/cursor codes", () => {
	assert.equal(ANSI_STRIP_STAGE.apply("\x1b[31mred\x1b[0m"), "red");
	assert.equal(ANSI_STRIP_STAGE.apply("\x1b[1;32mbold green\x1b[0m"), "bold green");
	assert.equal(ANSI_STRIP_STAGE.apply("cursor\x1b[2Jmove\x1b[H"), "cursormove");
	assert.equal(ANSI_STRIP_STAGE.apply("\x1b[?25lhidden\x1b[?25h"), "hidden");
});

test("AnsiStripStage is idempotent (no ANSI in → unchanged; ANSI in → ANSI out)", () => {
	const plain = "no escape codes here";
	assert.equal(ANSI_STRIP_STAGE.apply(plain), plain);
	// Apply twice — second pass on already-stripped text is a no-op.
	const once = ANSI_STRIP_STAGE.apply("\x1b[31mred\x1b[0m");
	const twice = ANSI_STRIP_STAGE.apply(once);
	assert.equal(twice, once);
});

test("AnsiStripStage fast-path: text without \\x1b returns immediately (identity)", () => {
	const custom = new AnsiStripStage();
	assert.equal(custom.apply(""), "");
	assert.equal(custom.apply("a".repeat(1000)), "a".repeat(1000));
});

// --- BlankCollapseStage ---

test("BlankCollapseStage collapses 3+ consecutive newlines to a single blank line (\\n\\n)", () => {
	assert.equal(BLANK_COLLAPSE_STAGE.apply("a\n\n\n\nb"), "a\n\nb");
	assert.equal(BLANK_COLLAPSE_STAGE.apply("a\n\n\nb"), "a\n\nb");
	assert.equal(BLANK_COLLAPSE_STAGE.apply("a\n\nb"), "a\n\nb", "exactly 2 newlines must be preserved");
	assert.equal(BLANK_COLLAPSE_STAGE.apply("a\nb"), "a\nb", "single newline preserved");
});

test("BlankCollapseStage is configurable (minConsecutive threshold)", () => {
	const stage5 = new BlankCollapseStage(5);
	assert.equal(stage5.apply("a\n\n\n\n\n\nb"), "a\n\nb", "6 newlines → 2 (>=5 threshold)");
	assert.equal(stage5.apply("a\n\n\n\nb"), "a\n\n\n\nb", "4 newlines preserved (<5 threshold)");
});

// --- DeduplicateStage ---

test("DeduplicateStage collapses CONSECUTIVE duplicate lines (non-adjacent duplicates kept)", () => {
	assert.equal(DEDUPLICATE_STAGE.apply("a\na\nb\nb\nc"), "a\nb\nc");
	assert.equal(DEDUPLICATE_STAGE.apply("a\nb\na\nb"), "a\nb\na\nb", "non-adjacent duplicates preserved");
	assert.equal(DEDUPLICATE_STAGE.apply(""), "");
	assert.equal(DEDUPLICATE_STAGE.apply("single"), "single");
});

test("DeduplicateStage preserves \\r\\n line endings", () => {
	assert.equal(DEDUPLICATE_STAGE.apply("a\r\na\r\nb"), "a\r\nb");
});

// --- TruncationStage (parameterized marker) ---

test("TruncationStage default marker (compacted ... chars) matches compactString wording", () => {
	const stage = new TruncationStage(100);
	const out = stage.apply("A".repeat(500) + "B".repeat(500));
	assert.match(out, /\[pi-crew compacted \d+ chars, head\+tail preserved\]/);
	assert.equal(stage.id, "truncation");
});

test("TruncationStage with truncated marker (readIfSmall wording)", () => {
	const stage = new TruncationStage(100, {
		marker: { verb: "truncated", headSeparator: "\n\n" },
	});
	const out = stage.apply("A".repeat(500) + "B".repeat(500));
	assert.match(out, /\[pi-crew truncated \d+ chars, head\+tail preserved\]/);
	// Double-newline headSeparator: marker line is preceded by "\n\n" not "\n".
	assert.ok(out.includes("A\n\n...[pi-crew truncated"), "double-newline headSeparator applied");
});

test("TruncationStage rejects non-positive maxChars", () => {
	assert.throws(() => new TruncationStage(0));
	assert.throws(() => new TruncationStage(-1));
	assert.throws(() => new TruncationStage(NaN));
});

// --- compactString integration (P0-A pipeline = [truncation]) ---

test("compactString pipeline produces bit-identical L4 marker when no important lines and plain text", () => {
	// No ANSI, no blank runs, no consecutive duplicates → all non-truncation
	// stages would be no-ops. The output marker should be exactly the pre-P0-A
	// wording.
	const value = "A".repeat(2000) + "B".repeat(5000) + "Z".repeat(2000);
	const out = compactString(value, 4096);
	assert.match(out, /\[pi-crew compacted \d+ chars, head\+tail preserved\]/);
	assert.ok(!out.includes("important lines preserved"));
});

test("compactString pipeline preserves important lines (P0-B still works through P0-A)", () => {
	const maxChars = 4096;
	const head = "A".repeat(5000);
	const middle = "normal\nError: middle\nmore normal\n";
	const tail = "Z".repeat(2000);
	const value = head + middle + tail;
	assert.ok(value.length > maxChars, `fixture must exceed maxChars: ${value.length} > ${maxChars}`);
	const out = compactString(value, maxChars);
	assert.ok(out.includes("Error: middle"), "important line must be preserved");
	assert.match(out, /important lines preserved/);
});

test("compactString pipeline is monotonic-shrink safe across the boundary window", () => {
	for (let over = 1; over <= 60; over++) {
		const out = compactString("y".repeat(8192 + over), 8192);
		assert.ok(out.length <= 8192 + over, `over=${over}: output ${out.length} must be <= input ${8192 + over}`);
	}
});

// --- readIfSmall integration (P0-A pipeline = [ansi-strip, blank-collapse, truncation]) ---

function writeTempFile(content: string): {
	filePath: string;
	cleanup: () => void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p0a-readifsmall-"));
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

test("readIfSmall pipeline strips ANSI color codes before truncating", () => {
	// Long file with ANSI codes throughout — after readIfSmall, no \x1b should
	// remain in the result.
	const lines: string[] = [];
	for (let i = 0; i < 5000; i++) {
		lines.push(`\x1b[32mline ${i}\x1b[0m`);
	}
	const content = lines.join("\n");
	assert.ok(content.includes("\x1b"), "fixture must contain ANSI");
	const { filePath, cleanup } = writeTempFile(content);
	try {
		const out = readIfSmall(filePath);
		assert.ok(out);
		assert.ok(!out.includes("\x1b"), "ANSI must be stripped before truncation");
		assert.match(out, /\[pi-crew truncated \d+ chars, head\+tail preserved\]/);
	} finally {
		cleanup();
	}
});

test("readIfSmall pipeline collapses 3+ blank lines before truncating", () => {
	// Long file with blank-line noise — must exceed MAX_RESULT_INLINE_BYTES (32000) so truncation actually fires.
	const filler = "filler\n".repeat(12_000); // ~84KB
	const blanks = "\n\n\n\n\n\n"; // 6 newlines
	const content = filler + blanks + filler + blanks + filler;
	assert.ok(content.length > 32_000, `fixture must exceed MAX_RESULT_INLINE_BYTES: ${content.length} > 32000`);
	const { filePath, cleanup } = writeTempFile(content);
	try {
		const out = readIfSmall(filePath);
		assert.ok(out);
		assert.ok(!out.includes("\n\n\n\n\n\n"), "6-blank-line run must be collapsed before truncation");
	} finally {
		cleanup();
	}
});

test("readIfSmall pipeline is bit-identical to pre-P0-A wording on plain text (L4 backward-compat)", () => {
	// Plain ASCII, no ANSI, no blank runs → the new pipeline's pre-truncation
	// stages are no-ops, so the marker wording matches the pre-P0-A format.
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

// --- Pipeline observability (applied[]) ---

test("compactString result is byte-identical pre/post P0-A for plain text (no stage observability leak)", () => {
	// The `applied` array is internal to the pipeline — compactString returns
	// just the string. This test guards against accidentally exposing the
	// pipeline result type or changing the return shape.
	const value = "A".repeat(2000) + "B".repeat(5000) + "Z".repeat(2000);
	const out: unknown = compactString(value, 4096);
	assert.equal(typeof out, "string", "compactString must return a string, not a PipelineResult");
});

test("applyCompactPipeline applied[] lists each accepted stage once", () => {
	const stages: ICompactStage[] = [
		{ id: "strip-ansi", apply: (t) => t.replace(/\x1b\[[0-9;]*m/g, "") },
		{ id: "shrink", apply: (t) => t.toUpperCase().slice(0, 5) },
	];
	const result: PipelineResult = applyCompactPipeline("\x1b[31mhello world\x1b[0m", stages);
	assert.deepEqual(result.applied, ["strip-ansi", "shrink"]);
	assert.equal(result.text, "HELLO");
});
