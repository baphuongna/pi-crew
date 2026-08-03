import assert from "node:assert";
import { describe, test } from "node:test";
import { computeRunHealth, scoreToGrade } from "../../../../src/runtime/task-health.ts";

describe("scoreToGrade", () => {
	test("maps 90-100 to A", () => {
		assert.strictEqual(scoreToGrade(95), "A");
		assert.strictEqual(scoreToGrade(90), "A");
	});
	test("maps 70-89 to B", () => {
		assert.strictEqual(scoreToGrade(70), "B");
		assert.strictEqual(scoreToGrade(89), "B");
	});
	test("maps 50-69 to C", () => {
		assert.strictEqual(scoreToGrade(50), "C");
		assert.strictEqual(scoreToGrade(69), "C");
	});
	test("maps 30-49 to D", () => {
		assert.strictEqual(scoreToGrade(30), "D");
		assert.strictEqual(scoreToGrade(49), "D");
	});
	test("maps 0-29 to F", () => {
		assert.strictEqual(scoreToGrade(0), "F");
		assert.strictEqual(scoreToGrade(29), "F");
	});
});

describe("computeRunHealth", () => {
	test("returns perfect score for all tasks completed", () => {
		const manifest = makeManifest([
			{ id: "t1", status: "completed" },
			{ id: "t2", status: "completed" },
		]);
		const health = computeRunHealth(manifest);
		assert.strictEqual(health.score, 100);
		assert.strictEqual(health.grade, "A");
		assert.strictEqual(health.penalties.length, 0);
	});

	test("applies high-failure-rate penalty", () => {
		const manifest = makeManifest([
			{ id: "t1", status: "completed" },
			{ id: "t2", status: "failed" },
			{ id: "t3", status: "failed" },
		]);
		const health = computeRunHealth(manifest);
		assert.ok(health.score < 100);
		assert.ok(health.penalties.some((p) => p.reason === "high-failure-rate"));
	});

	test("applies stalled-tasks penalty", () => {
		const manifest = makeManifest([
			{ id: "t1", status: "completed" },
			{ id: "t2", status: "running", stalledSince: Date.now() - 600_000 }, // stalled 10min
		]);
		const health = computeRunHealth(manifest);
		assert.ok(health.penalties.some((p) => p.reason === "stalled-tasks"));
	});

	test("clamps score to [0, 100]", () => {
		const manifest = makeManifest([
			{ id: "t1", status: "failed" },
			{ id: "t2", status: "failed" },
			{ id: "t3", status: "failed" },
			{ id: "t4", status: "failed" },
			{ id: "t5", status: "failed" },
			{ id: "t6", status: "running", stalledSince: Date.now() - 600_000 },
		]);
		const health = computeRunHealth(manifest);
		assert.ok(health.score >= 0);
		assert.ok(health.score <= 100);
	});
});

function makeManifest(tasks: { id: string; status: string; stalledSince?: number }[]) {
	return {
		runId: "test-run",
		tasks: tasks.map((t) => ({
			id: t.id,
			status: t.status,
			...(t.stalledSince !== undefined ? { stalledSince: t.stalledSince } : {}),
		})),
		createdAt: new Date().toISOString(),
	};
}
