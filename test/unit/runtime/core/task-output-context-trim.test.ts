import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DependencyContextEntry } from "../../../../src/runtime/task-output-context.ts";
import { enforceDependencyInlineBudget, MAX_TOTAL_DEP_INLINE_BYTES } from "../../../../src/runtime/task-output-context.ts";

/**
 * L4 total-budget: trims the inline `resultSummary` of low-priority
 * dependencies when the SUM of inline bytes across all deps exceeds
 * MAX_TOTAL_DEP_INLINE_BYTES. Per-dep cap (32 KB) is unchanged — this
 * layer adds a TOTAL cap so a single downstream worker can't be
 * overwhelmed by 5×30 KB of inline text.
 *
 * Priority order (highest kept first):
 *   1. status in {failed, needs-attention}
 *   2. recency (newer wins)
 *   3. relevance (workflow-declared order, earlier = higher)
 *   4. stable: original index (deterministic output)
 *
 * Downgrade = resultSummary="", inlineBytes=0, structuredResults=undefined;
 * resultPath + fullOutputPath are preserved so the downstream worker can
 * `read` the full content on demand.
 */

function makeDep(overrides: Partial<DependencyContextEntry> & { taskId: string }): DependencyContextEntry {
	return {
		role: "executor",
		status: "completed",
		resultSummary: "x".repeat(30_000),
		inlineBytes: 30_000,
		recency: 0,
		relevance: 0.5,
		...overrides,
	};
}

describe("MAX_TOTAL_DEP_INLINE_BYTES constant", () => {
	it("is 96_000 (3x per-dep cap)", () => {
		assert.equal(MAX_TOTAL_DEP_INLINE_BYTES, 96_000);
	});
});

describe("enforceDependencyInlineBudget", () => {
	it("returns deps unchanged when total is below budget", () => {
		// Case A: 3 deps × 30KB = 90KB < 96KB budget → no trim
		const deps = [
			makeDep({ taskId: "d1", relevance: 1.0 }),
			makeDep({ taskId: "d2", relevance: 0.9 }),
			makeDep({ taskId: "d3", relevance: 0.8 }),
		];
		const out = enforceDependencyInlineBudget(deps);
		assert.equal(out.length, 3);
		for (let i = 0; i < 3; i++) {
			assert.equal(out[i]!.resultSummary.length, 30_000, `dep ${i} should be kept inline`);
			assert.equal(out[i]!.inlineBytes, 30_000, `dep ${i} inlineBytes should be unchanged`);
		}
	});

	it("downgrades lowest-priority deps to path-only when total exceeds budget", () => {
		// Case B: 5 deps × 30KB = 150KB > 96KB budget → keep top 3 (90KB),
		// downgrade the remaining 2 to path-only.
		const deps = [
			makeDep({ taskId: "d1", relevance: 1.0 }),
			makeDep({ taskId: "d2", relevance: 0.9 }),
			makeDep({ taskId: "d3", relevance: 0.8 }),
			makeDep({ taskId: "d4", relevance: 0.7 }),
			makeDep({ taskId: "d5", relevance: 0.6 }),
		];
		const out = enforceDependencyInlineBudget(deps);
		assert.equal(out.length, 5);
		// Top 3 by relevance are kept inline
		const kept = out.filter((d) => (d.inlineBytes ?? 0) > 0);
		const downgraded = out.filter((d) => (d.inlineBytes ?? 0) === 0);
		assert.equal(kept.length, 3, "expected 3 deps kept inline (90KB ≤ 96KB)");
		assert.equal(downgraded.length, 2, "expected 2 deps downgraded");
		// Downgraded deps: resultSummary cleared, but resultPath and
		// fullOutputPath preserved so worker can `read` the full content.
		for (const dep of downgraded) {
			assert.equal(dep.resultSummary, "", `downgraded dep ${dep.taskId} resultSummary should be empty`);
			assert.equal(dep.structuredResults, undefined, "downgraded dep structuredResults should be undefined");
		}
		// The 2 downgraded should be d4 and d5 (lowest relevance)
		assert.deepEqual(downgraded.map((d) => d.taskId).sort(), ["d4", "d5"], "d4 and d5 (lowest relevance) should be downgraded");
	});

	it("preserves resultPath and fullOutputPath on downgraded deps", () => {
		const deps = [
			makeDep({ taskId: "d1", resultPath: "/a/result.txt", fullOutputPath: "/a/result.full.txt" }),
			makeDep({ taskId: "d2", resultPath: "/b/result.txt", fullOutputPath: "/b/result.full.txt" }),
			makeDep({ taskId: "d3", resultPath: "/c/result.txt", fullOutputPath: "/c/result.full.txt" }),
			makeDep({ taskId: "d4", resultPath: "/d/result.txt", fullOutputPath: "/d/result.full.txt" }),
			makeDep({ taskId: "d5", resultPath: "/e/result.txt", fullOutputPath: "/e/result.full.txt" }),
		];
		const out = enforceDependencyInlineBudget(deps);
		const downgraded = out.filter((d) => (d.inlineBytes ?? 0) === 0);
		for (const dep of downgraded) {
			assert.ok(dep.resultPath, `downgraded dep ${dep.taskId} should keep resultPath`);
			assert.ok(dep.fullOutputPath, `downgraded dep ${dep.taskId} should keep fullOutputPath`);
		}
	});

	it("always keeps failed/needs-attention deps inline (highest priority)", () => {
		// A failed dep is the most important context for the downstream
		// worker — even if it has the lowest relevance, it MUST stay inline.
		const deps = [
			makeDep({ taskId: "d1", status: "completed", relevance: 1.0 }),
			makeDep({ taskId: "d2", status: "completed", relevance: 0.9 }),
			makeDep({ taskId: "d3", status: "completed", relevance: 0.8 }),
			makeDep({ taskId: "d4_failed", status: "failed", relevance: 0.1 }),
		];
		const out = enforceDependencyInlineBudget(deps);
		const failed = out.find((d) => d.taskId === "d4_failed");
		assert.ok(failed, "failed dep must be present");
		assert.equal(failed.inlineBytes, 30_000, "failed dep must be kept inline (highest priority)");
		assert.equal(failed.resultSummary.length, 30_000);
	});

	it("keeps needs-attention deps inline (highest priority, like failed)", () => {
		const deps = [
			makeDep({ taskId: "d1", status: "completed", relevance: 1.0 }),
			makeDep({ taskId: "d2", status: "completed", relevance: 0.9 }),
			makeDep({ taskId: "d3", status: "completed", relevance: 0.8 }),
			makeDep({ taskId: "d4", status: "completed", relevance: 0.7 }),
			makeDep({ taskId: "d5_needs", status: "needs-attention", relevance: 0.0 }),
		];
		const out = enforceDependencyInlineBudget(deps);
		const needs = out.find((d) => d.taskId === "d5_needs");
		assert.ok(needs, "needs-attention dep must be present");
		assert.equal(needs.inlineBytes, 30_000, "needs-attention dep must be kept inline (highest priority)");
	});

	it("uses recency as tie-breaker between same-priority deps", () => {
		// d1 and d2 have equal relevance but d2 is more recent. d1, d2
		// plus a 3rd dep (d3) with mid relevance and recency=0 should
		// all fit in the budget. d1 has finishedAt=100, d2 has finishedAt=200.
		// Total: 3×30=90KB < 96KB → no trim, but the test confirms the
		// priority score is computed correctly. Add a 4th to force trim.
		const deps = [
			makeDep({ taskId: "d1", relevance: 0.5, recency: 100 }),
			makeDep({ taskId: "d2", relevance: 0.5, recency: 200 }), // more recent
			makeDep({ taskId: "d3", relevance: 0.4, recency: 50 }),
			makeDep({ taskId: "d4", relevance: 0.3, recency: 25 }),
		];
		const out = enforceDependencyInlineBudget(deps);
		// Total = 4×30=120KB > 96KB. Budget allows 3 inline (90KB). The
		// 4th is downgraded. Priority: d2 (recency 200) > d1 (recency 100)
		// > d3 (relevance 0.4) > d4 (relevance 0.3). So d4 is downgraded.
		const downgraded = out.filter((d) => (d.inlineBytes ?? 0) === 0);
		assert.equal(downgraded.length, 1, "1 dep downgraded (4×30KB - 3×30KB = 30KB over budget)");
		assert.equal(downgraded[0]!.taskId, "d4", "d4 (lowest relevance + lowest recency) is downgraded");
	});

	it("returns input unchanged when no deps", () => {
		const out = enforceDependencyInlineBudget([]);
		assert.deepEqual(out, []);
	});

	it("returns input unchanged when exactly at budget", () => {
		// 3 deps × 30KB = 90KB. Budget is 96KB. We can add 2KB more
		// without exceeding. Add 1 dep of 6KB → 96KB total = at budget.
		const deps = [
			makeDep({ taskId: "d1", inlineBytes: 30_000, resultSummary: "x".repeat(30_000) }),
			makeDep({ taskId: "d2", inlineBytes: 30_000, resultSummary: "x".repeat(30_000) }),
			makeDep({ taskId: "d3", inlineBytes: 30_000, resultSummary: "x".repeat(30_000) }),
			makeDep({ taskId: "d4", inlineBytes: 6_000, resultSummary: "x".repeat(6_000) }),
		];
		const out = enforceDependencyInlineBudget(deps);
		const kept = out.filter((d) => (d.inlineBytes ?? 0) > 0);
		assert.equal(kept.length, 4, "all 4 deps kept (total = 96KB = at budget, not over)");
	});

	it("preserves original input order in output", () => {
		// Mixed statuses, the result array MUST be in the same order as
		// the input — only content changes.
		const deps = [
			makeDep({ taskId: "d1", relevance: 0.3 }),
			makeDep({ taskId: "d2", relevance: 0.9 }),
			makeDep({ taskId: "d3", relevance: 0.5 }),
			makeDep({ taskId: "d4", relevance: 0.7 }),
			makeDep({ taskId: "d5", relevance: 0.1 }),
		];
		const out = enforceDependencyInlineBudget(deps);
		assert.deepEqual(
			out.map((d) => d.taskId),
			["d1", "d2", "d3", "d4", "d5"],
			"output must be in input order",
		);
	});
});
