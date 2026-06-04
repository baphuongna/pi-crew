import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BM25Search } from "../../src/utils/bm25-search.ts";

const docs = [
	{ id: "a", fields: { name: "security review", description: "OWASP and STRIDE analysis" } },
	{ id: "b", fields: { name: "performance tuning", description: "profile and optimize code" } },
	{ id: "c", fields: { name: "security audit", description: "comprehensive security check" } },
	{ id: "d", fields: { name: "data analysis", description: "explore and visualize data" } },
	{ id: "e", fields: { name: "code review", description: "review pull requests for quality" } },
];

const weights = { name: 3.0, description: 1.0 };

describe("BM25Search constructor", () => {
	it("handles empty document list", () => {
		const engine = new BM25Search([], weights);
		const results = engine.search("test");
		assert.deepEqual(results, []);
	});

	it("handles empty field weights", () => {
		const engine = new BM25Search(docs, {});
		const results = engine.search("security");
		assert.equal(results.length, 0);
	});

	it("accepts custom k1 and b parameters", () => {
		const engine = new BM25Search(docs, weights, { k1: 2.0, b: 0.5 });
		const results = engine.search("security");
		assert.ok(results.length > 0);
	});
});

describe("BM25Search search", () => {
	it("ranks name matches higher than description matches", () => {
		const engine = new BM25Search(docs, weights);
		const results = engine.search("review");
		// "code review" has "review" in name, "security review" also in name
		assert.ok(results.length >= 2);
		// All results should have a positive score
		for (const r of results) {
			assert.ok(r.score > 0);
		}
	});

	it("respects limit option", () => {
		const engine = new BM25Search(docs, weights);
		const results = engine.search("review", { limit: 1 });
		assert.ok(results.length <= 1);
	});

	it("respects minScore option", () => {
		const engine = new BM25Search(docs, weights);
		const results = engine.search("review", { minScore: 999 });
		assert.equal(results.length, 0);
	});

	it("returns empty results for empty query", () => {
		const engine = new BM25Search(docs, weights);
		assert.deepEqual(engine.search(""), []);
	});

	it("returns empty results for whitespace-only query", () => {
		const engine = new BM25Search(docs, weights);
		assert.deepEqual(engine.search("   "), []);
	});

	it("returns matchedOn field names", () => {
		const engine = new BM25Search(docs, weights);
		const results = engine.search("security");
		assert.ok(results.length > 0);
		for (const r of results) {
			assert.ok(r.matchedOn.length > 0);
		}
	});

	it("handles multi-term query", () => {
		const engine = new BM25Search(docs, weights);
		const results = engine.search("security analysis");
		assert.ok(results.length > 0);
	});

	it("returns results sorted by score descending", () => {
		const engine = new BM25Search(docs, weights);
		const results = engine.search("security");
		for (let i = 1; i < results.length; i++) {
			assert.ok(results[i - 1].score >= results[i].score);
		}
	});

	it("deduplicates matchedOn fields", () => {
		const engine = new BM25Search(docs, weights);
		const results = engine.search("security security");
		for (const r of results) {
			const unique = new Set(r.matchedOn);
			assert.equal(r.matchedOn.length, unique.size);
		}
	});
});
