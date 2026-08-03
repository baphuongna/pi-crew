/**
 * Tests for staleness-aware tool output pruning.
 *
 * Covers: same-file re-read staleness, file-edited-after-read invalidation,
 * protect window immunity, minimum-savings hysteresis, protected-tools
 * immunity + stale override for "read", and digest notice generation for
 * bash/grep/search.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildStalenessIndex,
	DEFAULT_PRUNE_CONFIG,
	type PruneConfig,
	pruneToolOutputs,
	resultDigest,
	type ToolResultEntry,
} from "../../src/runtime/compaction/tool-output-pruner.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRead(id: string, target: string, content: string, isError?: boolean): ToolResultEntry {
	return { id, toolName: "read", target, content, isError };
}

function makeBash(id: string, content: string, isError?: boolean): ToolResultEntry {
	return { id, toolName: "bash", content, isError };
}

function makeGrep(id: string, pattern: string, content: string): ToolResultEntry {
	return { id, toolName: "grep", target: pattern, content };
}

function makeSearch(id: string, pattern: string, content: string): ToolResultEntry {
	return { id, toolName: "search", target: pattern, content };
}

/** Config with low thresholds so pruning actually fires in tests. */
const AGGRESSIVE_CONFIG: PruneConfig = {
	protectTokens: 0,
	minimumSavings: 1,
	protectedTools: [],
	staleOverridableTools: ["read"],
};

/** Large content to ensure savings exceed minimumSavings. */
const BIG = "x".repeat(10_000);

// ---------------------------------------------------------------------------
// buildStalenessIndex
// ---------------------------------------------------------------------------

describe("buildStalenessIndex", () => {
	it("marks older result stale when same file is read twice", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", "old content"), makeRead("r2", "/src/a.ts", "new content")];
		const { staleIndices } = buildStalenessIndex(results);
		assert.ok(staleIndices.has(0), "older read should be stale");
		assert.ok(!staleIndices.has(1), "latest read should NOT be stale");
	});

	it("does NOT mark stale when targets differ", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", "content a"), makeRead("r2", "/src/b.ts", "content b")];
		const { staleIndices } = buildStalenessIndex(results);
		assert.equal(staleIndices.size, 0);
	});

	it("marks read stale when file is edited after read", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", "original"), makeRead("r2", "/src/b.ts", "unrelated")];
		const fileEdits = [{ target: "/src/a.ts", index: 3 }];
		const { staleIndices } = buildStalenessIndex(results, fileEdits);
		assert.ok(staleIndices.has(0), "read of edited file should be stale");
		assert.ok(!staleIndices.has(1), "read of unedited file should NOT be stale");
	});

	it("does NOT mark read stale when edit happens before read", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", "original")];
		const fileEdits = [{ target: "/src/a.ts", index: 0 }];
		const { staleIndices } = buildStalenessIndex(results, fileEdits);
		assert.equal(staleIndices.size, 0, "edit before read does not invalidate");
	});

	it("strips read selectors when matching edit targets", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts:50-200", "content")];
		const fileEdits = [{ target: "/src/a.ts", index: 1 }];
		const { staleIndices } = buildStalenessIndex(results, fileEdits);
		assert.ok(staleIndices.has(0), "read with selector should match base path edit");
	});

	it("does NOT mark error results as superseding (error re-reads don't count)", () => {
		const results: ToolResultEntry[] = [
			makeRead("r1", "/src/a.ts", "old content"),
			makeRead("r2", "/src/a.ts", "error: file not found", true),
		];
		const { staleIndices } = buildStalenessIndex(results);
		assert.equal(staleIndices.size, 0, "error result does not supersede earlier success");
	});

	it("marks grep stale when same pattern re-run", () => {
		const results: ToolResultEntry[] = [makeGrep("g1", "TODO", "old matches"), makeGrep("g2", "TODO", "new matches")];
		const { staleIndices } = buildStalenessIndex(results);
		assert.ok(staleIndices.has(0));
		assert.ok(!staleIndices.has(1));
	});
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — protect window
// ---------------------------------------------------------------------------

describe("pruneToolOutputs — protect window", () => {
	it("never prunes non-stale results inside the protect window", () => {
		// Different files → no staleness. Huge protect window → both protected.
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", BIG), makeRead("r2", "/src/b.ts", BIG)];
		const config: PruneConfig = {
			protectTokens: 100_000, // huge window
			minimumSavings: 1,
			protectedTools: [],
		};
		const result = pruneToolOutputs(results, config);
		assert.equal(result.prunedCount, 0);
		assert.equal(result.tokensSaved, 0);
	});

	it("prunes stale results even inside the protect window (staleness overrides recency)", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", BIG), makeRead("r2", "/src/a.ts", BIG)];
		const config: PruneConfig = {
			protectTokens: 100_000, // huge window
			minimumSavings: 1,
			protectedTools: [],
			staleOverridableTools: ["read"],
		};
		const result = pruneToolOutputs(results, config);
		assert.ok(result.prunedCount >= 1, "stale result should be pruned despite protect window");
	});
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — minimum savings threshold
// ---------------------------------------------------------------------------

describe("pruneToolOutputs — minimumSavings hysteresis", () => {
	it("does NOT prune when savings are below minimumSavings", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", "tiny"), makeRead("r2", "/src/a.ts", "tiny")];
		// AGGRESSIVE_CONFIG has minimumSavings=1 but content is so small savings may be 0.
		const config: PruneConfig = {
			protectTokens: 0,
			minimumSavings: 10_000,
			protectedTools: [],
			staleOverridableTools: ["read"],
		};
		const result = pruneToolOutputs(results, config);
		assert.equal(result.prunedCount, 0);
	});

	it("prunes when savings exceed minimumSavings", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", BIG), makeRead("r2", "/src/a.ts", BIG)];
		const config: PruneConfig = {
			protectTokens: 0,
			minimumSavings: 100,
			protectedTools: [],
			staleOverridableTools: ["read"],
		};
		const result = pruneToolOutputs(results, config);
		assert.ok(result.prunedCount >= 1);
		assert.ok(result.tokensSaved >= 100);
	});
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — protected tools immunity + stale override
// ---------------------------------------------------------------------------

describe("pruneToolOutputs — protected tools", () => {
	it("protected tool is never pruned even when stale (no override)", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", BIG), makeRead("r2", "/src/a.ts", BIG)];
		const config: PruneConfig = {
			protectTokens: 0,
			minimumSavings: 1,
			protectedTools: ["read"],
			// NO staleOverridableTools — read is fully protected
		};
		const result = pruneToolOutputs(results, config);
		assert.equal(result.prunedCount, 0, "protected read without override should not be pruned");
	});

	it("protected tool WITH stale override is pruned when superseded", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", BIG), makeRead("r2", "/src/a.ts", BIG)];
		const config: PruneConfig = {
			protectTokens: 0,
			minimumSavings: 1,
			protectedTools: ["read"],
			staleOverridableTools: ["read"],
		};
		const result = pruneToolOutputs(results, config);
		assert.ok(result.prunedCount >= 1, "superseded read with override should be pruned");
		// The latest read (r2) should NOT be pruned.
		assert.ok(!result.prunedIds.includes("r2"), "latest read should survive");
	});

	it("most recent result per target is never pruned even with override", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", BIG), makeRead("r2", "/src/a.ts", BIG)];
		// Window large enough to protect the latest result (≈2500 tokens),
		// but stale override ensures the older one is still prunable.
		const config: PruneConfig = {
			protectTokens: 5_000,
			minimumSavings: 1,
			protectedTools: [],
			staleOverridableTools: ["read"],
		};
		const result = pruneToolOutputs(results, config);
		assert.ok(!result.prunedIds.includes("r2"), "most recent should survive");
		assert.ok(result.prunedIds.includes("r1"), "older should be pruned");
	});

	it("non-protected tool (bash) is pruned outside protect window", () => {
		const results: ToolResultEntry[] = [makeBash("b1", BIG), makeBash("b2", BIG)];
		const result = pruneToolOutputs(results, {
			...AGGRESSIVE_CONFIG,
			protectedTools: [],
		});
		// bash results are not stale (no target key), but they're old and outside protect window.
		// The newest is protected by recency window (0 tokens, so everything is outside).
		// Actually with protectTokens=0, all non-stale non-protected results are candidates.
		assert.ok(result.prunedCount >= 1, "old bash outside window should be pruned");
	});
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — digest notice generation
// ---------------------------------------------------------------------------

describe("pruneToolOutputs — digest notices", () => {
	it("generates bash digest with exit code", () => {
		const results: ToolResultEntry[] = [
			makeBash("b1", `Building...\nLinking...\nDone. Build successful\n${"x".repeat(9000)}`),
			makeBash("b2", "latest bash output"),
		];
		const result = pruneToolOutputs(results, {
			...AGGRESSIVE_CONFIG,
			protectedTools: [],
		});
		assert.ok(result.prunedCount >= 1);
		const pruned = result.results[0]!;
		// The digest notice includes exit code (digest may be truncated by
		// the token cap, so we only assert on the prefix).
		assert.match(pruned.content, /\[Output pruned — \d+ tokens; exit=0/);
		// Full digest verified separately via resultDigest() below.
	});

	it("generates grep digest with match count prefix", () => {
		const results: ToolResultEntry[] = [
			makeGrep("g1", "TODO", `src/a.ts:1:TODO fix\nsrc/b.ts:5:TODO refactor\n\n15 matches in 3 files\n${"x".repeat(9000)}`),
			makeGrep("g2", "TODO", "latest grep"),
		];
		const result = pruneToolOutputs(results, AGGRESSIVE_CONFIG);
		assert.ok(result.prunedCount >= 1);
		const pruned = result.results[0]!;
		// Digest is truncated by token cap; assert on the prefix that survives.
		assert.match(pruned.content, /\[Output pruned — \d+ tokens; matches=/);
	});

	it("generates search digest with match count prefix", () => {
		const results: ToolResultEntry[] = [
			makeSearch("s1", "import", `Found 42 matches in 7 files\n${"x".repeat(9000)}`),
			makeSearch("s2", "import", "latest search"),
		];
		const result = pruneToolOutputs(results, AGGRESSIVE_CONFIG);
		assert.ok(result.prunedCount >= 1);
		const pruned = result.results[0]!;
		assert.match(pruned.content, /\[Output pruned — \d+ tokens; matches=/);
	});

	it("generates generic notice for tools without a known digest (read)", () => {
		const results: ToolResultEntry[] = [makeRead("r1", "/src/a.ts", BIG), makeRead("r2", "/src/a.ts", BIG)];
		const result = pruneToolOutputs(results, AGGRESSIVE_CONFIG);
		assert.ok(result.prunedCount >= 1);
		const pruned = result.results[0]!;
		assert.match(pruned.content, /\[Output pruned — \d+ tokens\]/);
		// read has no digest → should NOT have the semicolon-separated digest format.
		assert.doesNotMatch(pruned.content, /exit=|matches=|files=/);
	});
});

// ---------------------------------------------------------------------------
// resultDigest (direct unit tests)
// ---------------------------------------------------------------------------

describe("resultDigest", () => {
	it("returns undefined for unknown tools", () => {
		assert.equal(resultDigest("edit", "some content"), undefined);
		assert.equal(resultDigest("read", "file content"), undefined);
	});

	it("bash digest includes exit code, tail, and error line", () => {
		const digest = resultDigest("bash", "Compiling...\nError: syntax error at line 5\nBuild failed", true);
		assert.ok(digest);
		assert.match(digest!, /exit=1/);
		assert.match(digest!, /tail=Build failed/);
		assert.match(digest!, /error=Error: syntax error at line 5/);
	});

	it("grep digest extracts counts", () => {
		const digest = resultDigest("grep", "8 matches in 2 files");
		assert.ok(digest);
		assert.match(digest!, /matches=8/);
		assert.match(digest!, /files=2/);
	});

	it("search digest falls back to 'search digest unavailable' for empty results", () => {
		const digest = resultDigest("search", "");
		assert.equal(digest, "search digest unavailable");
	});
});

// ---------------------------------------------------------------------------
// DEFAULT_PRUNE_CONFIG sanity
// ---------------------------------------------------------------------------

describe("DEFAULT_PRUNE_CONFIG", () => {
	it("protects read by default with stale override", () => {
		assert.ok(DEFAULT_PRUNE_CONFIG.protectedTools.includes("read"));
		assert.ok(DEFAULT_PRUNE_CONFIG.staleOverridableTools?.includes("read"));
		assert.ok(DEFAULT_PRUNE_CONFIG.protectTokens > 0);
		assert.ok(DEFAULT_PRUNE_CONFIG.minimumSavings > 0);
	});

	it("default config does NOT prune unique small reads (opt-in)", () => {
		const results: ToolResultEntry[] = [
			makeRead("r1", "/src/a.ts", "small unique content"),
			makeRead("r2", "/src/b.ts", "another unique file"),
		];
		const result = pruneToolOutputs(results, DEFAULT_PRUNE_CONFIG);
		assert.equal(result.prunedCount, 0);
	});
});
