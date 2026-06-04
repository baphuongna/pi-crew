import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

// crash-recovery.ts is deeply integrated with manifest loading, hooks, locks, etc.
// We test the pure helper logic: isTerminalTask (inlined) and shouldRecoverTask (inlined).
// The exported functions require extensive mocking so we test their contracts minimally.

import {
	detectInterruptedRuns,
	type RecoveryPlan,
} from "../../src/runtime/crash-recovery.ts";

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
});
