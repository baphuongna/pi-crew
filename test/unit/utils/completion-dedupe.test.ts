import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl, pruneSeenMap } from "../../../src/utils/completion-dedupe.ts";

test("buildCompletionKey uses id when present", () => {
	assert.equal(buildCompletionKey({ id: "run-1", agent: "reviewer", timestamp: 123 }, "fallback"), "id:run-1");
});

test("buildCompletionKey creates deterministic fallback key", () => {
	const first = buildCompletionKey(
		{
			agent: "reviewer",
			timestamp: 123,
			taskIndex: 1,
			totalTasks: 2,
			success: true,
		},
		"fallback",
	);
	const second = buildCompletionKey(
		{
			agent: "reviewer",
			timestamp: 123,
			taskIndex: 1,
			totalTasks: 2,
			success: true,
		},
		"fallback",
	);
	assert.equal(first, second);
});

test("markSeenWithTtl dedupes within ttl and expires after", () => {
	const seen = new Map<string, number>();
	const ttlMs = 1000;
	assert.equal(markSeenWithTtl(seen, "k", 100, ttlMs), false);
	assert.equal(markSeenWithTtl(seen, "k", 200, ttlMs), true);
	assert.equal(markSeenWithTtl(seen, "k", 1201, ttlMs), false);
});

test("pruneSeenMap removes expired entries", () => {
	const seen = new Map([
		["a", 100],
		["b", 200],
		["c", 500],
	]);
	pruneSeenMap(seen, 1100, 600);
	assert.equal(seen.has("a"), false);
	assert.equal(seen.has("b"), false);
	assert.equal(seen.has("c"), true);
});

test("getGlobalSeenMap reuses map for same key", () => {
	const first = getGlobalSeenMap("__pi-crew-completion-dedupe-test__");
	first.set("once", Date.now());
	const second = getGlobalSeenMap("__pi-crew-completion-dedupe-test__");
	assert.equal(first, second);
	assert.equal(second.get("once") !== undefined, true);
});
