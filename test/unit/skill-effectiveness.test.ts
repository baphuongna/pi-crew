import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	adjustConfidence,
	applyDecay,
	CONFIDENCE_ADJUSTMENTS,
	CONFIDENCE_THRESHOLDS,
	computeInitialConfidence,
	computeSkillMetrics,
	confidenceToBehavior,
	confidenceToThreshold,
	evaluatePromotionGate,
	getSkillActivations,
	recordSkillActivation,
} from "../../src/runtime/skill-effectiveness.ts";
import { projectCrewRoot } from "../../src/utils/paths.ts";

const TEST_CWD = process.cwd();
const TEST_RUN_ID = `test-skill-eff-${Date.now()}`;

function cleanup() {
	// Cleanup at projectCrewRoot so the test follows the resolver (issue #29).
	const path = join(projectCrewRoot(TEST_CWD), `state/runs/${TEST_RUN_ID}`);
	try {
		if (existsSync(path)) {
			rmSync(path, { recursive: true, force: true });
		}
	} catch {
		// Ignore cleanup errors
	}
}

test("skill-effectiveness: CONFIDENCE_THRESHOLDS are ordered correctly", () => {
	assert.ok(CONFIDENCE_THRESHOLDS.TENTATIVE < CONFIDENCE_THRESHOLDS.MODERATE);
	assert.ok(CONFIDENCE_THRESHOLDS.MODERATE < CONFIDENCE_THRESHOLDS.STRONG);
	assert.ok(CONFIDENCE_THRESHOLDS.STRONG < CONFIDENCE_THRESHOLDS.NEAR_CERTAIN);
});

test("skill-effectiveness: computeInitialConfidence from observation count", () => {
	assert.equal(computeInitialConfidence(0), 0.3); // No observations → tentative
	assert.equal(computeInitialConfidence(1), 0.3); // 1 observation → tentative
	assert.equal(computeInitialConfidence(2), 0.3); // 2 observations → tentative
	assert.equal(computeInitialConfidence(3), 0.5); // 3-5 observations → moderate
	assert.equal(computeInitialConfidence(5), 0.5);
	assert.equal(computeInitialConfidence(6), 0.7); // 6-10 observations → strong
	assert.equal(computeInitialConfidence(10), 0.7);
	assert.equal(computeInitialConfidence(11), 0.85); // 11+ observations → very strong
});

test("skill-effectiveness: adjustConfidence increases on success", () => {
	const confidence = 0.5;
	const adjusted = adjustConfidence(confidence, true);
	assert.equal(adjusted, confidence + CONFIDENCE_ADJUSTMENTS.CONFIRMING);
	assert.equal(adjusted, 0.55);
});

test("skill-effectiveness: adjustConfidence decreases on failure", () => {
	const confidence = 0.5;
	const adjusted = adjustConfidence(confidence, false);
	assert.equal(adjusted, confidence + CONFIDENCE_ADJUSTMENTS.CONTRADICTING);
	assert.equal(adjusted, 0.4);
});

test("skill-effectiveness: adjustConfidence clamps to valid range", () => {
	assert.equal(adjustConfidence(0.15, false), 0.1); // Can't go below 0.1
	assert.equal(adjustConfidence(0.9, true), 0.95); // Can't go above 0.95
});

test("skill-effectiveness: applyDecay reduces confidence over time", () => {
	const current = 0.7;
	const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
	const decayed = applyDecay(current, weekAgo);
	assert.ok(decayed < current);
	assert.ok(decayed >= 0.1);
});

test("skill-effectiveness: confidenceToBehavior maps correctly", () => {
	assert.equal(confidenceToBehavior(0.2), "suggest");
	assert.equal(confidenceToBehavior(0.4), "suggest");
	assert.equal(confidenceToBehavior(0.5), "apply_if_asked");
	assert.equal(confidenceToBehavior(0.6), "apply_if_asked");
	assert.equal(confidenceToBehavior(0.7), "apply_auto");
	assert.equal(confidenceToBehavior(0.8), "apply_auto");
	assert.equal(confidenceToBehavior(0.9), "act_autonomous");
	assert.equal(confidenceToBehavior(1.0), "act_autonomous");
});

test("skill-effectiveness: confidenceToThreshold returns correct threshold name", () => {
	assert.equal(confidenceToThreshold(0.2), "TENTATIVE");
	assert.equal(confidenceToThreshold(0.5), "MODERATE");
	assert.equal(confidenceToThreshold(0.7), "STRONG");
	assert.equal(confidenceToThreshold(0.9), "NEAR_CERTAIN");
});

test("skill-effectiveness: recordSkillActivation and getSkillActivations", () => {
	cleanup();
	try {
		const activation = recordSkillActivation(TEST_CWD, {
			id: `act-${Date.now()}`,
			skillId: "verification-before-done",
			role: "executor",
			runId: TEST_RUN_ID,
			taskId: "task-1",
			timestamp: new Date().toISOString(),
			passed: true,
			confidence: 0.5,
		});

		const activations = getSkillActivations(TEST_CWD, TEST_RUN_ID);
		assert.equal(activations.length, 1);
		assert.equal(activations[0].skillId, "verification-before-done");
		assert.equal(activations[0].passed, true);
	} finally {
		cleanup();
	}
});

test("skill-effectiveness: computeSkillMetrics with no activations", () => {
	cleanup();
	try {
		const metrics = computeSkillMetrics("nonexistent-skill", []);
		assert.equal(metrics.totalActivations, 0);
		assert.equal(metrics.passRate, 0);
		assert.equal(metrics.currentConfidence, 0.3);
	} finally {
		cleanup();
	}
});

test("skill-effectiveness: computeSkillMetrics with activations", () => {
	cleanup();
	try {
		// Record activations
		recordSkillActivation(TEST_CWD, {
			id: "act-1",
			skillId: "test-skill",
			role: "executor",
			runId: TEST_RUN_ID,
			taskId: "task-1",
			timestamp: new Date().toISOString(),
			passed: true,
			confidence: 0.5,
		});
		recordSkillActivation(TEST_CWD, {
			id: "act-2",
			skillId: "test-skill",
			role: "executor",
			runId: TEST_RUN_ID,
			taskId: "task-2",
			timestamp: new Date().toISOString(),
			passed: true,
			confidence: 0.55,
		});
		recordSkillActivation(TEST_CWD, {
			id: "act-3",
			skillId: "test-skill",
			role: "executor",
			runId: TEST_RUN_ID,
			taskId: "task-3",
			timestamp: new Date().toISOString(),
			passed: false,
			confidence: 0.45,
		});

		const metrics = computeSkillMetrics("test-skill", getSkillActivations(TEST_CWD, TEST_RUN_ID));
		assert.equal(metrics.totalActivations, 3);
		assert.equal(metrics.passedActivations, 2);
		assert.equal(metrics.failedActivations, 1);
		assert.equal(metrics.passRate, 2 / 3);
		assert.ok(metrics.avgConfidence > 0);
		assert.ok(metrics.currentConfidence >= 0.1);
	} finally {
		cleanup();
	}
});

test("skill-effectiveness: evaluatePromotionGate passes with good metrics", () => {
	const metrics = {
		skillId: "test-skill",
		totalActivations: 10,
		passedActivations: 9,
		failedActivations: 1,
		passRate: 0.9,
		avgConfidence: 0.75,
		currentConfidence: 0.8,
		trend: "stable" as const,
		roleBreakdown: {},
	};

	const gate = evaluatePromotionGate(metrics);
	assert.ok(gate.passed);
	assert.ok(gate.criteria.correctness);
	assert.ok(gate.criteria.evidence);
	assert.ok(gate.criteria.rollback);
	assert.ok(gate.criteria.encoding);
});

test("skill-effectiveness: evaluatePromotionGate fails with low pass rate", () => {
	const metrics = {
		skillId: "test-skill",
		totalActivations: 10,
		passedActivations: 4,
		failedActivations: 6,
		passRate: 0.4,
		avgConfidence: 0.75,
		currentConfidence: 0.8,
		trend: "stable" as const,
		roleBreakdown: {},
	};

	const gate = evaluatePromotionGate(metrics);
	assert.ok(!gate.passed);
	assert.ok(!gate.criteria.correctness);
	assert.ok(gate.criteria.evidence);
});

test("skill-effectiveness: evaluatePromotionGate fails with insufficient activations", () => {
	const metrics = {
		skillId: "test-skill",
		totalActivations: 2,
		passedActivations: 2,
		failedActivations: 0,
		passRate: 1.0,
		avgConfidence: 0.5,
		currentConfidence: 0.5,
		trend: "stable" as const,
		roleBreakdown: {},
	};

	const gate = evaluatePromotionGate(metrics);
	assert.ok(!gate.passed);
	assert.ok(gate.criteria.correctness);
	assert.ok(!gate.criteria.evidence);
});
