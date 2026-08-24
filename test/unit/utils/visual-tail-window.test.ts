import assert from "node:assert/strict";
import test from "node:test";
// NOTE: the task brief showed "../../src/..." but from test/unit/utils/ the
// correct depth is ../../../ (matches visual.test.ts) — kept per repo convention.
import { truncateToVisualLines, truncateToVisualLinesTail } from "../../../src/utils/visual.ts";

const CASES = [
	"single line",
	"a\nb\nc",
	`${"x".repeat(200)}\n${"y".repeat(3)}\nshort`, // wide line wraps
	Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n"), // long tail
	`${"⏳ ".repeat(80)}\nfinal`, // wide graphemes
];

for (const [i, text] of CASES.entries()) {
	test(`tail window matches full wrap tail (case ${i})`, () => {
		for (const limit of [1, 4, 16, 50]) {
			const full = truncateToVisualLines(text, limit, 60);
			const tail = truncateToVisualLinesTail(text, limit, 60);
			assert.deepEqual(tail.visualLines, full.visualLines);
			assert.ok(tail.skippedCount <= full.skippedCount, "skipped is a lower bound");
		}
	});
}
