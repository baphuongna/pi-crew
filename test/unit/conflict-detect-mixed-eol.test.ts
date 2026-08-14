/**
 * Unit tests for spliceConflict EOL preservation (ST-13).
 *
 * Bug: spliceConflict previously split on `/\r?\n/` (discarding every
 * line's CR) then re-joined ALL lines with a single uniform EOL. In a
 * mixed CRLF/LF file this rewrote every non-conflicting line's ending,
 * so the entire file showed as changed in git diff.
 *
 * Fix: preserve each line's original EOL bytes; only the conflicting
 * region is rewritten.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { scanConflictLines, spliceConflict } from "../helpers/conflict-detect.ts";

const CRLF = "\r\n";
const LF = "\n";

describe("spliceConflict mixed-EOL preservation (ST-13)", () => {
	it("preserves original EOL of non-conflicting lines (CRLF before, LF after)", () => {
		// Mixed-EOL file: CRLF/LF lines flank a conflict region.
		const original =
			"const a = 1;" +
			CRLF + // line 1 — CRLF (non-conflict)
			"const b = 2;" +
			LF + // line 2 — LF (non-conflict)
			"<<<<<<< HEAD" +
			LF + // line 3 — conflict start
			"our line" +
			LF + // ours
			"=======" +
			LF + // separator
			"their line" +
			LF + // theirs
			">>>>>>> feature" +
			LF + // line 7 — conflict end
			"const c = 3;" +
			CRLF + // line 8 — CRLF (non-conflict)
			"const d = 4;" +
			LF; // line 9 — LF (non-conflict)

		const entry = {
			id: 1,
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 3,
			separatorLine: 5,
			endLine: 7,
			oursLabel: "HEAD",
			theirsLabel: "feature",
			oursLines: ["our line"],
			theirsLines: ["their line"],
		};

		const result = spliceConflict(original, entry, "merged");

		// Exact expected output: conflict region replaced, EOL of every
		// other line unchanged.
		const expected =
			"const a = 1;" +
			CRLF +
			"const b = 2;" +
			LF +
			"merged" +
			LF + // boundary EOL taken from conflict region (LF)
			"const c = 3;" +
			CRLF +
			"const d = 4;" +
			LF;
		assert.strictEqual(result, expected);

		// Direct EOL-byte assertions on the non-conflicting lines.
		assert.ok(result.includes("const a = 1;" + CRLF), "CRLF line before conflict must keep CRLF");
		assert.ok(result.includes("const b = 2;" + LF), "LF line before conflict must keep LF");
		assert.ok(result.includes("const c = 3;" + CRLF), "CRLF line after conflict must keep CRLF");
		assert.ok(result.includes("const d = 4;" + LF), "LF line after conflict must keep LF");

		// The bug regression-guard: LF non-conflict lines must NOT have been
		// rewritten to CRLF (which the old join(dominantEol) did).
		assert.ok(!result.includes("const b = 2;" + CRLF), "LF line must not be normalised to CRLF");
		assert.ok(!result.includes("const d = 4;" + CRLF), "LF line must not be normalised to CRLF");
		// CRLF non-conflict line must not lose its CR.
		assert.ok(!result.includes("const a = 1;" + LF + "const b"), "CRLF line must not lose its CR");
	});

	it("leaves non-conflicting lines byte-for-byte identical (round-trip check)", () => {
		// LF-dominant file with a single stray CRLF conflict region.
		const original =
			"keepLF1" +
			LF +
			"keepLF2" +
			LF +
			"<<<<<<< H" +
			CRLF + // conflict start — CRLF (minority style)
			"ours" +
			CRLF +
			"=======" +
			CRLF +
			"theirs" +
			CRLF +
			">>>>>>> T" +
			LF + // conflict end — back to LF
			"keepLF3" +
			LF +
			"keepLF4";

		const entry = {
			id: 1,
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 3,
			separatorLine: 5,
			endLine: 7,
			oursLabel: "H",
			theirsLabel: "T",
			oursLines: ["ours"],
			theirsLines: ["theirs"],
		};

		const result = spliceConflict(original, entry, "resolved1\nresolved2");

		// Non-conflict lines round-trip exactly.
		assert.ok(result.startsWith("keepLF1" + LF + "keepLF2" + LF), "prefix lines preserved verbatim");
		assert.ok(result.endsWith("resolved2" + LF + "keepLF3" + LF + "keepLF4"), "suffix lines preserved verbatim");
		// LF lines untouched (no injected CR).
		assert.ok(!result.includes("keepLF1" + CRLF));
		assert.ok(!result.includes("keepLF3" + CRLF));
	});

	it("detects the conflict via scanConflictLines and resolves with minimal diff", () => {
		// End-to-end: scan a mixed-EOL buffer, build the entry, splice, and
		// confirm only the conflict lines changed.
		const original =
			"topCRLF" + CRLF + "<<<<<<< HEAD" + LF + "x" + LF + "=======" + LF + "y" + LF + ">>>>>>> feat" + CRLF + "bottomLF" + LF;

		// split how scanConflictLines expects (mirrors read path on a CRLF file)
		const lines = original.split("\n");
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 1, "conflict must be detected in mixed-EOL buffer");
		const b = blocks[0];
		const entry = {
			id: 1,
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: b.startLine,
			separatorLine: b.separatorLine,
			endLine: b.endLine,
			oursLabel: b.oursLabel,
			theirsLabel: b.theirsLabel,
			oursLines: b.oursLines,
			theirsLines: b.theirsLines,
		};

		const result = spliceConflict(original, entry, "fixed");
		assert.strictEqual(result, "topCRLF" + CRLF + "fixed" + CRLF + "bottomLF" + LF);
		// Non-conflict CRLF line and LF line both untouched.
		assert.ok(result.startsWith("topCRLF" + CRLF));
		assert.ok(result.endsWith("bottomLF" + LF));
	});
});
