import test from "node:test";
import assert from "node:assert/strict";
import { BM25Search } from "../../src/utils/bm25-search.ts";

interface Doc {
  id: string;
  fields: Record<string, string>;
}

test("BM25Search: empty query returns empty", () => {
  const docs: Doc[] = [
    { id: "a", fields: { name: "executor", desc: "executes tasks" } },
    { id: "b", fields: { name: "planner", desc: "plans tasks" } },
  ];
  const engine = new BM25Search(docs, { name: 1, desc: 1 });
  const results = engine.search("");
  assert.equal(results.length, 0);
});

test("BM25Search: single term returns ranked results", () => {
  const docs: Doc[] = [
    { id: "a", fields: { name: "executor", desc: "runs code" } },
    { id: "b", fields: { name: "planner", desc: "makes plans" } },
    { id: "c", fields: { name: "tester", desc: "runs tests" } },
  ];
  const engine = new BM25Search(docs, { name: 2, desc: 1 });
  const results = engine.search("run");
  assert.ok(results.length > 0);
  assert.ok(results[0].score > 0);
  // "runs" contains "run" — fuzzy match via substring regex
  const topNames = results.map((r) => r.item.id);
  assert.ok(topNames.includes("a") || topNames.includes("c"), "Should match docs with 'run'");
});

test("BM25Search: multi-term intersection", () => {
  const docs: Doc[] = [
    { id: "a", fields: { name: "executor", desc: "runs code" } },
    { id: "b", fields: { name: "planner", desc: "makes plans" } },
    { id: "c", fields: { name: "reviewer", desc: "reviews code" } },
  ];
  const engine = new BM25Search(docs, { name: 1, desc: 1 });
  const results = engine.search("code plans");
  // Doc b has "plans" but not "code"; doc a has "code" but not "plans"
  // The intersection should rank docs with both terms higher
  assert.ok(results.length > 0);
});

test("BM25Search: limit caps results", () => {
  const docs = Array.from({ length: 20 }, (_, i) => ({
    id: `doc${i}`,
    fields: { name: `doc ${i}`, desc: "test description" },
  }));
  const engine = new BM25Search(docs, { name: 1, desc: 1 });
  const results = engine.search("doc", { limit: 5 });
  assert.equal(results.length, 5);
});

test("BM25Search: minScore filters low-scoring", () => {
  const docs: Doc[] = [
    { id: "a", fields: { name: "executor", desc: "runs code" } },
    { id: "b", fields: { name: "planner", desc: "makes plans" } },
  ];
  const engine = new BM25Search(docs, { name: 1, desc: 1 });
  const results = engine.search("xyz", { minScore: 1.0 });
  assert.equal(results.length, 0);
});

test("BM25Search: field weights affect ranking", () => {
  const docs: Doc[] = [
    { id: "a", fields: { name: "executor", desc: "code runner" } },
    { id: "b", fields: { name: "planner", desc: "executor" } },
  ];
  const engine1 = new BM25Search(docs, { name: 2, desc: 1 });
  const engine2 = new BM25Search(docs, { name: 1, desc: 2 });

  const results1 = engine1.search("executor");
  const results2 = engine2.search("executor");

  // With higher name weight, doc a (name="executor") should rank higher
  // With higher desc weight, doc b (desc="executor") should rank higher
  assert.notEqual(results1[0].score, results2[0].score);
});

test("BM25Search: matchedOn tracks fields", () => {
  const docs: Doc[] = [
    { id: "a", fields: { name: "executor", desc: "runs code" } },
  ];
  const engine = new BM25Search(docs, { name: 1, desc: 1 });
  const results = engine.search("executor runs");
  assert.ok(results[0].matchedOn.length > 0);
});

test("BM25Search: same query is deterministic", () => {
  const docs: Doc[] = [
    { id: "a", fields: { name: "executor", desc: "runs code" } },
    { id: "b", fields: { name: "planner", desc: "makes plans" } },
  ];
  const engine = new BM25Search(docs, { name: 1, desc: 1 });
  const r1 = engine.search("executor");
  const r2 = engine.search("executor");
  assert.equal(r1[0].score, r2[0].score);
  assert.equal(r1[0].item.id, r2[0].item.id);
});
