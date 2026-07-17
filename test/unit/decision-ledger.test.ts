import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	appendEntry,
	decayCandidate,
	getLatestDecision,
	getLedger,
	initLedger,
	promoteCandidate,
	type RolloutEntry,
	summarizeLedger,
} from "../../src/state/decision-ledger.ts";

function cleanupRun(runId: string) {
	const dir = join(process.cwd(), `.crew/state/runs/${runId}`);
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── Security regression (post-issue-#29 review) ────────────────────────
// `initLedger`, `appendEntry`, etc. accept `runId` as a string and use
// it directly in path computation. The fix in commit <this> adds
// `assertSafePathId("runId", runId)` to each exported function to
// prevent path-traversal. These tests verify the guard fires.
test("decision-ledger: initLedger rejects path-traversal runId", () => {
	assert.throws(() => initLedger("../../../tmp/pwned"), /Invalid runId/);
});

test("decision-ledger: appendEntry rejects path-traversal runId", () => {
	const entry = {
		rolloutId: "x",
		timestamp: new Date().toISOString(),
		searchSpace: "test",
		trialCount: 0,
		topCandidates: [],
		decisionMark: "accept" as const,
		coherenceMark: {
			matchesPrior: true,
			matchesRecursive: true,
			promotionAllowed: true,
			reason: "test",
		},
	} as unknown as RolloutEntry;
	assert.throws(() => appendEntry("../escape", entry), /Invalid runId/);
});

test("decision-ledger: getLedger rejects path-traversal runId", () => {
	assert.throws(() => getLedger("../../etc/passwd"), /Invalid runId/);
});

test("decision-ledger: getLatestDecision rejects path-traversal runId", () => {
	assert.throws(() => getLatestDecision(".."), /Invalid runId/);
});

test("decision-ledger: summarizeLedger rejects path-traversal runId", () => {
	assert.throws(() => summarizeLedger("."), /Invalid runId/);
});

test("decision-ledger: promoteCandidate rejects path-traversal inputs", () => {
	assert.throws(() => promoteCandidate("../escape", "../../etc"), /Invalid runId/);
	assert.throws(() => promoteCandidate("valid-id", "../bad"), /Invalid candidate/);
});

test("decision-ledger: decayCandidate rejects path-traversal inputs", () => {
	assert.throws(() => decayCandidate("../escape", "../../etc"), /Invalid runId/);
	assert.throws(() => decayCandidate("valid-id", "../bad"), /Invalid candidate/);
});

test("decision-ledger: initLedger creates directory and file", () => {
	const runId = "test-init-" + Date.now();
	cleanupRun(runId);

	initLedger(runId);

	const ledgerPath = join(process.cwd(), `.crew/state/runs/${runId}/decision-ledger.jsonl`);
	assert.ok(existsSync(ledgerPath), "Ledger file should exist");

	cleanupRun(runId);
});

test("decision-ledger: appendEntry adds entry to ledger", () => {
	const runId = "test-append-" + Date.now();
	cleanupRun(runId);

	const entry: RolloutEntry = {
		rolloutId: "rollout-1",
		timestamp: new Date().toISOString(),
		searchSpace: "model-selection",
		trialCount: 1,
		topCandidates: ["claude-3-5-sonnet", "gpt-4o"],
		decisionMark: "accept",
		coherenceMark: {
			matchesPrior: false,
			matchesRecursive: false,
			promotionAllowed: true,
			reason: "First rollout",
		},
	};

	appendEntry(runId, entry);

	const ledger = getLedger(runId);
	assert.strictEqual(ledger.length, 1, "Should have 1 entry");
	assert.strictEqual(ledger[0].rolloutId, "rollout-1");

	cleanupRun(runId);
});

test("decision-ledger: coherence marks are auto-computed on append", () => {
	const runId = "test-coherence-" + Date.now();
	cleanupRun(runId);

	// First entry - should have promotion allowed (no prior to match)
	const entry1: RolloutEntry = {
		rolloutId: "rollout-1",
		timestamp: new Date().toISOString(),
		searchSpace: "model-selection",
		trialCount: 1,
		topCandidates: ["claude-3-5-sonnet"],
		decisionMark: "accept",
		coherenceMark: {
			matchesPrior: false,
			matchesRecursive: false,
			promotionAllowed: false,
			reason: "placeholder",
		},
	};
	appendEntry(runId, entry1);

	// Second entry with same decision - should match prior
	const entry2: RolloutEntry = {
		rolloutId: "rollout-2",
		timestamp: new Date().toISOString(),
		priorWinner: "claude-3-5-sonnet",
		searchSpace: "model-selection",
		trialCount: 2,
		topCandidates: ["claude-3-5-sonnet", "gpt-4o"],
		decisionMark: "accept",
		coherenceMark: {
			matchesPrior: false,
			matchesRecursive: false,
			promotionAllowed: false,
			reason: "placeholder",
		},
	};
	appendEntry(runId, entry2);

	const ledger = getLedger(runId);
	assert.strictEqual(ledger[1].coherenceMark.matchesPrior, true, "Second entry should match prior");
	assert.strictEqual(ledger[1].coherenceMark.promotionAllowed, true, "Second entry should have promotion allowed");

	cleanupRun(runId);
});

test("decision-ledger: getLatestDecision returns null for empty ledger", () => {
	const runId = "test-empty-" + Date.now();
	cleanupRun(runId);

	initLedger(runId);

	const latest = getLatestDecision(runId);
	assert.strictEqual(latest, null, "Should return null for empty ledger");

	cleanupRun(runId);
});

test("decision-ledger: getLatestDecision returns most recent entry", () => {
	const runId = "test-latest-" + Date.now();
	cleanupRun(runId);

	for (let i = 1; i <= 3; i++) {
		const entry: RolloutEntry = {
			rolloutId: `rollout-${i}`,
			timestamp: new Date().toISOString(),
			searchSpace: "model-selection",
			trialCount: i,
			topCandidates: [`candidate-${i}`],
			decisionMark: i === 1 ? "accept" : i === 2 ? "watch" : "reject",
			coherenceMark: {
				matchesPrior: false,
				matchesRecursive: false,
				promotionAllowed: true,
				reason: "test",
			},
		};
		appendEntry(runId, entry);
	}

	const latest = getLatestDecision(runId);
	assert.ok(latest !== null, "Should return an entry");
	assert.strictEqual(latest!.rolloutId, "rollout-3", "Should be the third entry");
	assert.strictEqual(latest!.decisionMark, "reject", "Should have reject decision");

	cleanupRun(runId);
});

test("decision-ledger: summarizeLedger returns message for empty ledger", () => {
	const runId = "test-summary-empty-" + Date.now();
	cleanupRun(runId);

	initLedger(runId);

	const summary = summarizeLedger(runId);
	assert.ok(summary.includes("No entries recorded yet"), "Should mention no entries");

	cleanupRun(runId);
});

test("decision-ledger: summarizeLedger generates markdown summary", () => {
	const runId = "test-summary-" + Date.now();
	cleanupRun(runId);

	const entry: RolloutEntry = {
		rolloutId: "rollout-1",
		timestamp: "2024-01-15T10:00:00Z",
		searchSpace: "model-selection",
		trialCount: 1,
		topCandidates: ["claude-3-5-sonnet"],
		decisionMark: "accept",
		coherenceMark: {
			matchesPrior: false,
			matchesRecursive: false,
			promotionAllowed: true,
			reason: "First rollout",
		},
	};

	appendEntry(runId, entry);

	const summary = summarizeLedger(runId);
	assert.ok(summary.includes("# Decision Ledger Summary"), "Should have markdown header");
	assert.ok(summary.includes("rollout-1"), "Should include rollout ID");
	assert.ok(summary.includes("model-selection"), "Should include search space");
	assert.ok(summary.includes("Accept"), "Should include decision mark");

	cleanupRun(runId);
});

test("decision-ledger: promoteCandidate creates accept entry", () => {
	const runId = "test-promote-" + Date.now();
	cleanupRun(runId);

	const entry = promoteCandidate(runId, "new-candidate");

	assert.strictEqual(entry.decisionMark, "accept", "Should have accept decision");
	assert.ok(entry.topCandidates.includes("new-candidate"), "Should include promoted candidate");
	assert.strictEqual(entry.coherenceMark.promotionAllowed, true, "Should have promotion allowed");

	cleanupRun(runId);
});

test("decision-ledger: decayCandidate creates decay entry", () => {
	const runId = "test-decay-" + Date.now();
	cleanupRun(runId);

	const entry = decayCandidate(runId, "old-candidate");

	assert.strictEqual(entry.decisionMark, "decay", "Should have decay decision");
	assert.ok(entry.topCandidates.includes("old-candidate"), "Should include decayed candidate");
	assert.strictEqual(entry.coherenceMark.promotionAllowed, false, "Manual decay should not allow promotion");

	cleanupRun(runId);
});

test("decision-ledger: recursive pattern detection works", () => {
	const runId = "test-recursive-" + Date.now();
	cleanupRun(runId);

	// Add 3 entries with the same decision
	for (let i = 1; i <= 3; i++) {
		const entry: RolloutEntry = {
			rolloutId: `rollout-${i}`,
			timestamp: new Date().toISOString(),
			searchSpace: "model-selection",
			trialCount: i,
			topCandidates: ["stable-candidate"],
			decisionMark: "accept",
			coherenceMark: {
				matchesPrior: false,
				matchesRecursive: false,
				promotionAllowed: false,
				reason: "placeholder",
			},
		};
		appendEntry(runId, entry);
	}

	// Add a 4th entry - should match recursive pattern
	const entry4: RolloutEntry = {
		rolloutId: "rollout-4",
		timestamp: new Date().toISOString(),
		searchSpace: "model-selection",
		trialCount: 4,
		topCandidates: ["new-candidate"],
		decisionMark: "accept",
		coherenceMark: {
			matchesPrior: false,
			matchesRecursive: false,
			promotionAllowed: false,
			reason: "placeholder",
		},
	};
	appendEntry(runId, entry4);

	const ledger = getLedger(runId);
	assert.strictEqual(ledger[3].coherenceMark.matchesRecursive, true, "4th entry should match recursive pattern");
	assert.strictEqual(ledger[3].coherenceMark.promotionAllowed, true, "4th entry should have promotion allowed");

	cleanupRun(runId);
});

test("appendEntry does NOT create directories for path-traversal runId (side-effect freedom)", () => {
	const runId = "../../../tmp/pwned-side-effect-test";
	const entry = {
		rolloutId: "r1",
		timestamp: new Date().toISOString(),
		searchSpace: "test",
		trialCount: 0,
		topCandidates: [],
		decisionMark: "accept" as const,
		coherenceMark: {
			matchesPrior: false,
			matchesRecursive: false,
			promotionAllowed: true,
			reason: "test",
		},
	} as unknown as RolloutEntry;

	// The path-traversal runId should throw BEFORE any mkdirSync
	assert.throws(() => appendEntry(runId, entry), /Invalid runId/);

	// Verify no directory was created outside the crew root
	const outsidePath = join(
		// Walk up from cwd: ../../../tmp/pwned-side-effect-test
		// resolves relative to projectCrewRoot(), so check for unexpected dirs
		"tmp",
		"pwned-side-effect-test",
	);
	assert.ok(!existsSync(outsidePath), `Directory ${outsidePath} should NOT exist (side-effect leak)`);
});

test("getLatestDecision rejects path-traversal runId (direct guard)", () => {
	for (const bad of ["../escape", "..", "."]) {
		assert.throws(() => getLatestDecision(bad), /Invalid runId/, `getLatestDecision("${bad}") should throw`);
	}
});

test("summarizeLedger rejects path-traversal runId (direct guard)", () => {
	for (const bad of ["../escape", "..", "."]) {
		assert.throws(() => summarizeLedger(bad), /Invalid runId/, `summarizeLedger("${bad}") should throw`);
	}
});
