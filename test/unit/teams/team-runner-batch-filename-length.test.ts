/**
 * RT-17 tests: batch-summary filename length is bounded.
 *
 * Bug: the batch-summary filename was an unbounded join of coalesced task IDs
 * (`batches/${ids.join("+")}.md`) → ENAMETOOLONG on ext4 with ~20 members.
 * Fix: when the joined IDs exceed 180 chars, hash to a fixed-length slug
 * (SHA-256 hex = 64 chars) with a member-count prefix. Short joins use the
 * raw IDs for readability + uniqueness.
 *
 * These tests verify:
 *   1. Short joins (common case) use raw IDs (readable + unique).
 *   2. 30 coalesced IDs produce a filename well under NAME_MAX (255).
 *   3. Different ID sets produce different slugs (uniqueness preserved).
 *   4. Same IDs always produce the same slug (deterministic).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { batchSummarySlug } from "../../../src/runtime/team-runner.ts";

// ─── Tests ────────────────────────────────────────────────────────

test("[RT-17] short join uses raw IDs (readable + unique)", () => {
	const ids = ["task-1", "task-2", "task-3"];
	const slug = batchSummarySlug(ids);
	assert.equal(slug, "task-1+task-2+task-3", "short join should use raw IDs");
});

test("[RT-17] single task uses raw ID", () => {
	const slug = batchSummarySlug(["solo-task"]);
	assert.equal(slug, "solo-task");
});

test("[RT-17] 30 coalesced IDs produce filename < 200 chars", () => {
	// Simulate 30 coalesced task IDs with realistic naming.
	const ids = Array.from({ length: 30 }, (_, i) => `01_agent-task-${String(i + 1).padStart(3, "0")}`);
	const slug = batchSummarySlug(ids);
	const fullFilename = `batches/${slug}.md`;
	assert.ok(fullFilename.length < 200, `filename should be < 200 chars, got ${fullFilename.length}: ${fullFilename}`);
	// Also verify it's well under NAME_MAX (255).
	assert.ok(slug.length < 255, `slug alone should be < 255 chars (NAME_MAX), got ${slug.length}`);
});

test("[RT-17] 50 coalesced IDs still bounded well under NAME_MAX", () => {
	const ids = Array.from({ length: 50 }, (_, i) => `very-long-task-id-prefix-${i}`);
	const slug = batchSummarySlug(ids);
	const fullFilename = `batches/${slug}.md`;
	assert.ok(fullFilename.length < 200, `filename should be < 200 chars even with 50 long IDs, got ${fullFilename.length}`);
});

test("[RT-17] long joins hash to fixed-length slug (well under 100 chars)", () => {
	const ids = Array.from({ length: 30 }, (_, i) => `task-${i}`);
	const slug = batchSummarySlug(ids);
	// Hashed slug: "coalesced-30-<64-char-hex>" = ~79 chars max
	assert.ok(slug.length < 100, `hashed slug should be < 100 chars, got ${slug.length}`);
	// Should start with the member-count prefix.
	assert.ok(slug.startsWith("coalesced-30-"), `hashed slug should start with member count prefix, got: ${slug}`);
});

test("[RT-17] different ID sets produce different slugs (uniqueness)", () => {
	const ids1 = Array.from({ length: 30 }, (_, i) => `task-${i}`);
	const ids2 = Array.from({ length: 30 }, (_, i) => `task-${i + 100}`);
	const slug1 = batchSummarySlug(ids1);
	const slug2 = batchSummarySlug(ids2);
	assert.notEqual(slug1, slug2, "different ID sets should produce different slugs");
});

test("[RT-17] same IDs produce same slug (deterministic)", () => {
	const ids = Array.from({ length: 30 }, (_, i) => `task-${i}`);
	const slug1 = batchSummarySlug(ids);
	const slug2 = batchSummarySlug(ids);
	assert.equal(slug1, slug2, "same IDs should produce same slug");
});

test("[RT-17] threshold boundary: 180-char join uses raw, 181-char hashes", () => {
	// Exactly 180 chars of joined IDs → raw (preserves readability).
	const idsExact = ["a".repeat(89), "b".repeat(90)]; // 89 + 1 + 90 = 180
	assert.equal(idsExact.join("+").length, 180);
	const slugExact = batchSummarySlug(idsExact);
	assert.equal(slugExact, idsExact.join("+"), "exactly 180 chars should use raw IDs");

	// 181 chars → hashed.
	const idsOver = ["a".repeat(90), "b".repeat(90)]; // 90 + 1 + 90 = 181
	assert.equal(idsOver.join("+").length, 181);
	const slugOver = batchSummarySlug(idsOver);
	assert.notEqual(slugOver, idsOver.join("+"), "181 chars should be hashed");
	assert.ok(slugOver.startsWith("coalesced-2-"), "should use hashed slug with count prefix");
});
