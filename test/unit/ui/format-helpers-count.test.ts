/**
 * R3 nit — `1 tools` (found in live-run data across five surfaces) is fixed by
 * one shared helper. Locks singular/plural for the count label.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCount } from "../../../src/ui/format-helpers.ts";

test("formatCount: singular for 1, plural otherwise", () => {
	assert.equal(formatCount(1, "tool"), "1 tool");
	assert.equal(formatCount(0, "tool"), "0 tools");
	assert.equal(formatCount(3, "tool"), "3 tools");
	assert.equal(formatCount(11, "tool"), "11 tools");
});

test("formatCount: irregular plural is respected", () => {
	assert.equal(formatCount(1, "entry", "entries"), "1 entry");
	assert.equal(formatCount(2, "entry", "entries"), "2 entries");
});

test("formatCount: works for the other labels it now owns", () => {
	assert.equal(formatCount(1, "turn"), "1 turn");
	assert.equal(formatCount(12, "turn"), "12 turns");
	assert.equal(formatCount(1, "agent"), "1 agent");
});
