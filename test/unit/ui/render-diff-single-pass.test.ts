import assert from "node:assert/strict";
import test from "node:test";
import { renderDiff } from "../../../src/ui/render-diff.ts";

const DIFF_TEXT = ` 1 context line
-2 old value with tail
+2 old value with tail modified
-3 the quick brown fox
+3 totally different content here`;

test("renderDiff intra-line highlighting is stable (golden)", () => {
	const out = renderDiff(DIFF_TEXT, {});
	// Basic rendering
	assert.ok(out.includes("-2 old value with tail"), "removed line 2 rendered");
	assert.ok(out.includes("+2 old value with tail "), "added line 2 rendered with highlighting start");
	assert.ok(out.includes("[7mmodified[27m"), "similar pair has inverse video on changed word");
	assert.ok(out.includes("context line"), "context line preserved");
	// Unrelated pair renders plainly (no inverse video on lines 3):
	assert.ok(out.includes("-3 the quick brown fox"), "removed line 3 rendered plainly");
	assert.ok(out.includes("+3 totally different content here"), "added line 3 rendered plainly");
	// Verify the second pair doesn't have inverse video applied to the content
	const line3Removed = out.match(/-3 (.*)/)?.[1];
	const line3Added = out.match(/\+3 (.*)/)?.[1];
	assert.ok(!line3Removed?.includes("[7m"), "second pair removed line has no inverse video");
	assert.ok(!line3Added?.includes("[7m"), "second pair added line has no inverse video");
});
