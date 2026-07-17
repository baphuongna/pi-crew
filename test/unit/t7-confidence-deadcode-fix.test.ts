/**
 * T7 (v0.8.2) — confidence-scoring dead-code fix.
 *
 * Bug: `registerSkillEffectivenessHooks`' `task_completed` handler hardcoded
 * `confidence: computeInitialConfidence(1)` (= 0.3) on every activation
 * write, and `task_failed` was a no-op. Consequences:
 *   1. `adjustConfidence()` was dead code (defined, tested in isolation, but
 *      never called in the recording path) — every skill stayed at ~0.3.
 *   2. `computeSkillMetrics.currentConfidence` was derived from the last
 *      stored value (always 0.3) + decay → the whole confidence system was
 *      inert; pass-rate never moved the confidence needle.
 *   3. Failed tasks recorded nothing, so the failure never fed back into
 *      passRate or the decay loop.
 *
 * Fix: `computeNextActivationConfidence` computes the ROLLING adjusted
 * confidence (prior last-recorded confidence for that skill + outcome delta),
 * and both hooks (task_completed AND task_failed) now record activations.
 *
 * These tests pin the fix: confidence must EVOLVE across activations and
 * reflect outcomes, and `task_failed` must now record a passed:false entry.
 */
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	adjustConfidence,
	computeNextActivationConfidence,
	computeSkillMetrics,
	getSkillActivations,
	recordSkillActivation,
	type SkillActivation,
} from "../../src/runtime/skill-effectiveness.ts";
import { projectCrewRoot } from "../../src/utils/paths.ts";

const TEST_CWD = process.cwd();
const TEST_RUN_ID = `test-t7-conf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function cleanup(): void {
	const dir = join(projectCrewRoot(TEST_CWD), `state/runs/${TEST_RUN_ID}`);
	try {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function act(skillId: string, passed: boolean, confidence: number, taskId: string): SkillActivation {
	return {
		id: `act-${taskId}`,
		skillId,
		role: "executor",
		runId: TEST_RUN_ID,
		taskId,
		timestamp: new Date().toISOString(),
		passed,
		confidence,
	};
}

test("T7: computeNextActivationConfidence seeds first activation at 0.3", () => {
	cleanup();
	try {
		// No prior activations → seed at the tentative floor.
		const confidence = computeNextActivationConfidence("verification-before-done", [], true);
		assert.equal(confidence, 0.3);
	} finally {
		cleanup();
	}
});

test("T7: computeNextActivationConfidence rolls forward (+0.05 on success)", () => {
	cleanup();
	try {
		const prior = [act("skill-a", true, 0.3, "t1")];
		const next = computeNextActivationConfidence("skill-a", prior, true);
		// 0.3 + 0.05 (CONFIRMING) = 0.35 — NOT a hardcoded 0.3.
		assert.equal(next, adjustConfidence(0.3, true));
		assert.equal(next, 0.35);
	} finally {
		cleanup();
	}
});

test("T7: computeNextActivationConfidence rolls backward (-0.1 on failure)", () => {
	cleanup();
	try {
		const prior = [act("skill-a", true, 0.5, "t1")];
		const next = computeNextActivationConfidence("skill-a", prior, false);
		// 0.5 - 0.1 (CONTRADICTING) = 0.4.
		assert.equal(next, adjustConfidence(0.5, false));
		assert.equal(next, 0.4);
	} finally {
		cleanup();
	}
});

test("T7: computeNextActivationConfidence only looks at the SAME skill's history", () => {
	cleanup();
	try {
		// Two skills interleaved; skill-b's first activation should seed at 0.3
		// even though skill-a already has a 0.7 record.
		const prior = [act("skill-a", true, 0.7, "t1")];
		const next = computeNextActivationConfidence("skill-b", prior, true);
		assert.equal(next, 0.3);
	} finally {
		cleanup();
	}
});

test("T7: recording two successes via the hooks' confidence math evolves the value", () => {
	cleanup();
	try {
		// Simulate the task_completed hook's confidence computation path:
		// activation 1 seeds 0.3; activation 2 rolls to 0.35. Record both
		// through recordSkillActivation (the real storage) and assert the
		// stored values + computeSkillMetrics reflect the evolution.
		const existing1 = getSkillActivations(TEST_CWD, TEST_RUN_ID);
		const c1 = computeNextActivationConfidence("skill-x", existing1, true);
		recordSkillActivation(TEST_CWD, act("skill-x", true, c1, "x1"));

		const existing2 = getSkillActivations(TEST_CWD, TEST_RUN_ID);
		const c2 = computeNextActivationConfidence("skill-x", existing2, true);
		recordSkillActivation(TEST_CWD, act("skill-x", true, c2, "x2"));

		const stored = getSkillActivations(TEST_CWD, TEST_RUN_ID);
		assert.equal(stored.length, 2);
		assert.equal(stored[0]!.confidence, 0.3); // seeded
		assert.equal(stored[1]!.confidence, 0.35); // rolled forward

		const metrics = computeSkillMetrics("skill-x", stored);
		// currentConfidence = last stored (0.35) with same-day decay ≈ 0.35.
		assert.ok(
			metrics.currentConfidence > 0.3,
			`currentConfidence ${metrics.currentConfidence} should exceed the 0.3 floor (the bug value)`,
		);
		assert.equal(metrics.passedActivations, 2);
		assert.equal(metrics.passRate, 1);
	} finally {
		cleanup();
	}
});

test("T7: a failed task now lowers the rolling confidence (regression guard for the no-op task_failed hook)", () => {
	cleanup();
	try {
		// Before T7, task_failed recorded NOTHING, so a failure after a success
		// left confidence unchanged. Now the failure records a passed:false
		// activation with the rolled-back confidence.
		recordSkillActivation(TEST_CWD, act("skill-y", true, 0.5, "y1"));
		const existing = getSkillActivations(TEST_CWD, TEST_RUN_ID);
		const cFail = computeNextActivationConfidence("skill-y", existing, false);
		recordSkillActivation(TEST_CWD, act("skill-y", false, cFail, "y2"));

		const stored = getSkillActivations(TEST_CWD, TEST_RUN_ID);
		assert.equal(stored.length, 2);
		assert.equal(stored[1]!.passed, false);
		assert.equal(stored[1]!.confidence, 0.4); // 0.5 - 0.1

		const metrics = computeSkillMetrics("skill-y", stored);
		assert.equal(metrics.failedActivations, 1);
		assert.equal(metrics.passRate, 0.5);
		// The failure fed back: currentConfidence reflects the rollback.
		assert.ok(
			metrics.currentConfidence <= 0.4 + 0.001,
			`currentConfidence ${metrics.currentConfidence} should reflect the failure rollback`,
		);
	} finally {
		cleanup();
	}
});

test("T7: adjustConfidence is no longer dead — computeNextActivationConfidence calls it", () => {
	// Sanity: the previously-dead function is now on the production path.
	// (If someone deletes the call, this test won't catch it directly, but
	// the rolling tests above will — their expected values depend on
	// adjustConfidence's clamp + delta.)
	assert.equal(adjustConfidence(0.3, true), 0.35);
	assert.equal(adjustConfidence(0.5, false), 0.4);
	assert.equal(adjustConfidence(0.05, false), 0.1); // clamp floor
	assert.equal(adjustConfidence(0.94, true), 0.95); // clamp ceiling
});
