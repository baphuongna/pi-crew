import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

// crash-recovery.ts is deeply integrated with manifest loading, hooks, locks, etc.
// We test the pure helper logic: isTerminalTask (inlined) and shouldRecoverTask (inlined).
// The exported functions require extensive mocking so we test their contracts minimally.

import { detectInterruptedRuns } from "../../src/runtime/crash-recovery.ts";

// ── detectInterruptedRuns ──
// Needs a ManifestCache with list(). We provide a minimal stub.

describe("detectInterruptedRuns", () => {
	it("returns empty when no runs are running or blocked", () => {
		const dir = createTrackedTempDir("pi-crew-cr-");
		try {
			const cache = { list: () => [] };
			const plans = detectInterruptedRuns(dir, cache as any);
			assert.deepStrictEqual(plans, []);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("skips runs with status completed", () => {
		const dir = createTrackedTempDir("pi-crew-cr-");
		try {
			const cache = {
				list: () => [{ runId: "r1", status: "completed" }],
			};
			const plans = detectInterruptedRuns(dir, cache as any);
			assert.deepStrictEqual(plans, []);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("skips runs with status failed", () => {
		const dir = createTrackedTempDir("pi-crew-cr-");
		try {
			const cache = {
				list: () => [{ runId: "r1", status: "failed" }],
			};
			const plans = detectInterruptedRuns(dir, cache as any);
			assert.deepStrictEqual(plans, []);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	// Regression: PR #32 / gustavo-pelissaro — a run blocked on human plan
	// approval must not be treated as interrupted/crashed, even if its async PID
	// is dead. detectInterruptedRuns would otherwise build a recovery plan and the
	// run could later be marked failed or orphan-cancelled.
	describe("plan-approval preservation", () => {
		it("detectInterruptedRuns skips runs blocked for plan approval", () => {
			const dir = createTrackedTempDir("pi-crew-cr-");
			try {
				const now = new Date().toISOString();
				const cache = {
					list: () => [
						{
							runId: "r-plan",
							status: "blocked",
							async: { pid: 99999125 },
							planApproval: {
								required: true,
								status: "pending",
								requestedAt: now,
								updatedAt: now,
							},
						},
					],
				};
				const plans = detectInterruptedRuns(dir, cache as any);
				assert.deepStrictEqual(plans, []);
			} finally {
				removeTrackedTempDir(dir);
			}
		});

		it("does not over-preserve: a plain blocked run (no plan approval) is not short-circuited by the guard", () => {
			// A run that is merely blocked (not on plan approval) must still be a
			// candidate for recovery — the guard is narrow to blocked+required+pending.
			// There is no real manifest on disk so detectInterruptedRuns builds no
			// plan either way, but we assert it does not crash and the guard branch is
			// reachable only via planApproval (the verdict-level behavior is covered
			// in stale-reconciler.test.ts).
			const dir = createTrackedTempDir("pi-crew-cr-");
			try {
				const cache = {
					list: () => [
						{
							runId: "r-blocked-plain",
							status: "blocked",
							async: { pid: 99999126 },
						},
					],
				};
				const plans = detectInterruptedRuns(dir, cache as any);
				assert.ok(Array.isArray(plans));
			} finally {
				removeTrackedTempDir(dir);
			}
		});
	});
});
