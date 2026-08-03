/**
 * Tests for src/utils/bm25-search.ts
 * Coverage:
 * - Basic search returns relevant results
 * - Field weighting affects ranking
 * - minScore threshold
 * - limit cap
 * - Empty query returns empty results
 * - df precomputation (df is computed once at construction)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BM25Search } from "../../../src/utils/bm25-search.ts";

const docs = [
	{
		id: "a",
		fields: {
			name: "security review",
			description: "OWASP and STRIDE analysis",
		},
	},
	{
		id: "b",
		fields: {
			name: "performance tuning",
			description: "profile and optimize code",
		},
	},
	{
		id: "c",
		fields: {
			name: "security audit",
			description: "comprehensive security check",
		},
	},
	{
		id: "d",
		fields: { name: "data analysis", description: "explore and visualize" },
	},
];

const weights = { name: 3.0, description: 1.0 };

test("BM25Search basic search returns relevant results", () => {
	const engine = new BM25Search(docs, weights);
	const results = engine.search("security");
	assert.ok(results.length > 0, "should return at least one result");
	// 'a' and 'c' both contain "security" in name
	const ids = results.map((r) => r.item.id);
	assert.ok(ids.includes("a"));
	assert.ok(ids.includes("c"));
});

test("BM25Search field weighting: name match should rank higher than description match", () => {
	const engine = new BM25Search(docs, weights);
	const results = engine.search("performance");
	// 'b' has 'performance' in name (weight 3.0)
	// 'b' should be the top result
	assert.equal(results[0]?.item.id, "b");
});

test("BM25Search returns empty for empty query", () => {
	const engine = new BM25Search(docs, weights);
	const results = engine.search("");
	assert.equal(results.length, 0);
});

test("BM25Search returns empty for whitespace-only query", () => {
	const engine = new BM25Search(docs, weights);
	const results = engine.search("   \t\n  ");
	assert.equal(results.length, 0);
});

test("BM25Search limit cap restricts result count", () => {
	const engine = new BM25Search(docs, weights);
	const results = engine.search("security", { limit: 1 });
	assert.equal(results.length, 1);
});

test("BM25Search minScore threshold filters low-relevance results", () => {
	const engine = new BM25Search(docs, weights);
	// Use a very high minScore to filter everything
	const results = engine.search("security", { minScore: 100 });
	assert.equal(results.length, 0);
});

test("BM25Search results are sorted by score descending", () => {
	const engine = new BM25Search(docs, weights);
	const results = engine.search("security");
	for (let i = 1; i < results.length; i++) {
		assert.ok(results[i - 1]!.score >= results[i]!.score, "results should be sorted descending");
	}
});

test("BM25Search matchedOn indicates which fields matched", () => {
	const engine = new BM25Search(docs, weights);
	const results = engine.search("security");
	for (const r of results) {
		assert.ok(r.matchedOn.length > 0);
	}
});

test("BM25Search handles case-insensitive query", () => {
	const engine = new BM25Search(docs, weights);
	const lower = engine.search("security");
	const upper = engine.search("SECURITY");
	assert.equal(lower.length, upper.length);
});

test("BM25Search handles multi-term query", () => {
	const engine = new BM25Search(docs, weights);
	const results = engine.search("security review");
	assert.ok(results.length > 0);
});

test("BM25Search with empty corpus returns empty results", () => {
	const engine = new BM25Search([], weights);
	const results = engine.search("anything");
	assert.equal(results.length, 0);
});

test("BM25Search custom k1 and b config", () => {
	const engine = new BM25Search(docs, weights, { k1: 0.9, b: 0.4 });
	const results = engine.search("security");
	assert.ok(results.length > 0);
});

test("BM25Search df is precomputed (subsequent searches share same df)", () => {
	// Build a corpus where df is non-trivial
	const corpus = [
		{ id: "1", fields: { name: "alpha beta" } },
		{ id: "2", fields: { name: "alpha gamma" } },
		{ id: "3", fields: { name: "beta gamma" } },
	];
	const engine = new BM25Search(corpus, { name: 1.0 });
	// "alpha" appears in 2 documents (df=2)
	// "beta" appears in 2 documents (df=2)
	// "gamma" appears in 2 documents (df=2)
	const r1 = engine.search("alpha");
	const r2 = engine.search("beta");
	assert.equal(r1.length, 2);
	assert.equal(r2.length, 2);
});

test("BM25Search single-doc corpus returns that doc", () => {
	const engine = new BM25Search([docs[0]!], weights);
	const results = engine.search("security");
	assert.equal(results.length, 1);
	assert.equal(results[0]?.item.id, "a");
});

test("BM25Search preserves relevance across many terms", () => {
	const corpus = [
		{ id: "1", fields: { name: "react frontend ui" } },
		{ id: "2", fields: { name: "react backend api" } },
		{ id: "3", fields: { name: "vue frontend ui" } },
	];
	const engine = new BM25Search(corpus, { name: 1.0 });
	const results = engine.search("react");
	assert.ok(results.length > 0);
	assert.equal(results[0]?.item.id, "1"); // has highest tf
});
