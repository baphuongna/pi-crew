/**
 * Real-function tests for child-pi.ts output-handling fixes (Sprint 1).
 *
 * These tests import and call the REAL exported `compactString` and
 * `compactValue` functions from src/runtime/child-pi/child-pi.ts — NOT local mirror
 * copies. This guards against the algorithm drifting from the real
 * implementation (the bug that output-handling-l4.test.ts had).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compactString, compactValue } from "../../../../src/runtime/child-pi/child-pi.ts";
import { redactSecretString } from "../../../../src/utils/redaction.ts";

test("BUG-3: compactString must NOT expand input just over threshold (monotonic shrink)", () => {
	const input = "x".repeat(8193);
	const result = compactString(input, 8192);
	assert.ok(result.length <= input.length, `result (${result.length}) must be <= input (${input.length}) — compaction must never expand`);
});

test("BUG-3: compactString monotonic-shrink across the boundary window (threshold+1 .. threshold+60)", () => {
	const threshold = 8192;
	for (let over = 1; over <= 60; over++) {
		const input = "y".repeat(threshold + over);
		const result = compactString(input, threshold);
		assert.ok(result.length <= input.length, `over=${over}: result (${result.length}) must be <= input (${input.length})`);
	}
});

test("compactString normal head+tail preserves head, tail, and marker", () => {
	const threshold = 8192;
	const head = "A".repeat(6144);
	const middle = "B".repeat(10000);
	const tail = "Z".repeat(2048);
	const input = head + middle + tail; // 18272 chars
	const result = compactString(input, threshold);
	assert.ok(result.length < input.length, "result must be compacted");
	assert.ok(result.includes(head.slice(0, 100)), "head portion must be present");
	assert.ok(result.includes(tail), "tail portion must be present");
	assert.match(result, /\[pi-crew compacted/, "truncation marker must be present");
});

test("compactString under-threshold returns input unchanged", () => {
	const input = "x".repeat(100);
	const result = compactString(input, 8192);
	assert.equal(result, input, "under-threshold input must be returned unchanged");
});

test("BUG-4: compactValue array >20 items appends truncation marker", () => {
	const arr: string[] = [];
	for (let i = 0; i < 50; i++) arr.push(`item-${i}`);
	const result = compactValue(arr) as unknown[];
	assert.ok(Array.isArray(result), "result must be an array");
	assert.ok(result.length > 20, "result must contain the 20 items plus a marker");
	assert.equal(result.length, 21, "expected 20 items + 1 marker entry");
	const marker = result[result.length - 1];
	assert.match(String(marker), /\[pi-crew truncated 30 entries\]/, "marker must report 30 truncated entries");
});

test("BUG-4: compactValue small array (<=20) has no truncation marker", () => {
	const arr = ["a", "b", "c", "d", "e"];
	const result = compactValue(arr) as unknown[];
	assert.ok(Array.isArray(result), "result must be an array");
	assert.equal(result.length, 5, "small array must be unchanged in length");
	for (const entry of result) {
		assert.doesNotMatch(String(entry), /\[pi-crew truncated/, "no truncation marker for small array");
	}
});

test("BUG-4: compactValue object >20 keys gets a [truncated] marker", () => {
	const obj: Record<string, unknown> = {};
	for (let i = 0; i < 25; i++) obj[`key${i}`] = i;
	const result = compactValue(obj) as Record<string, unknown>;
	assert.ok("[truncated]" in result, "object must contain a [truncated] marker key");
	assert.match(String(result["[truncated]"]), /5 entries/, "marker must report 5 truncated entries");
});

test("SEC-1: redactSecretString scrubs a GitHub PAT pattern from a stderr-like string", () => {
	// This verifies the function actually applied at the SEC-1 fix sites works.
	const pat = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36);
	const stderrLike = `worker error: auth failed for token ${pat}\nstack: ...`;
	const redacted = redactSecretString(stderrLike);
	assert.ok(!redacted.includes(pat), "the raw GitHub PAT must NOT survive redaction");
	assert.ok(!redacted.includes("ghp_"), "the ghp_ prefix must be scrubbed");
});

test("SEC-1: redactSecretString scrubs PAT even when embedded in a compacted stderr slice", () => {
	// Simulate the SEC-1 code path: a stderr tail slice containing a secret,
	// then run through redactSecretString. Confirms the wrapper is effective.
	const pat = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij".slice(0, 36);
	const tail = `fatal: ${pat} rejected`.repeat(1);
	const slice = tail.slice(-1024);
	const safe = redactSecretString(slice);
	assert.ok(!safe.includes(pat), "PAT must not be present after redaction");
});
