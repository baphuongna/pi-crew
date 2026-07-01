import assert from "node:assert/strict";
import test from "node:test";
import { detectWriteOverlap, selectNonOverlapping } from "../../src/runtime/path-overlap.ts";
import type { WorkflowStep } from "../../src/workflows/workflow-config.ts";

function makeStep(id: string, output?: string | false): WorkflowStep {
	return {
		id,
		role: id,
		task: `task for ${id}`,
		...(output !== undefined ? { output } : {}),
	};
}

test("detectWriteOverlap: identical output paths overlap", () => {
	assert.equal(detectWriteOverlap(makeStep("a", "out.md"), makeStep("b", "out.md")), true);
});

test("detectWriteOverlap: different paths do not overlap", () => {
	assert.equal(detectWriteOverlap(makeStep("a", "alpha.md"), makeStep("b", "beta.md")), false);
});

test("detectWriteOverlap: read-only or no-output steps never overlap", () => {
	// output: false
	assert.equal(detectWriteOverlap(makeStep("a", "x.md"), makeStep("b", false)), false);
	// output absent
	assert.equal(detectWriteOverlap(makeStep("a", "x.md"), makeStep("c")), false);
	// both absent
	assert.equal(detectWriteOverlap(makeStep("a"), makeStep("b")), false);
});

test("detectWriteOverlap: empty-string output treated as no-output", () => {
	assert.equal(detectWriteOverlap(makeStep("a", "x.md"), makeStep("b", "")), false);
});

test("selectNonOverlapping: greedy picks non-overlapping subset, preserves order", () => {
	const steps = [
		makeStep("a", "alpha.md"),
		makeStep("b", "alpha.md"), // conflict with a — should be skipped
		makeStep("c", "beta.md"),
		makeStep("d", "gamma.md"),
		makeStep("e", "alpha.md"), // conflict with a — skipped
	];
	const picked = selectNonOverlapping(steps, 10);
	// a, c, d should be picked; b and e skipped due to conflict with a
	assert.deepEqual(
		picked.map((s) => s.id),
		["a", "c", "d"],
	);
});

test("selectNonOverlapping: respects maxCount", () => {
	const steps = [
		makeStep("a", "a.md"),
		makeStep("b", "b.md"),
		makeStep("c", "c.md"),
		makeStep("d", "d.md"),
	];
	const picked = selectNonOverlapping(steps, 2);
	assert.equal(picked.length, 2);
	assert.deepEqual(picked.map((s) => s.id), ["a", "b"]);
});

test("selectNonOverlapping: empty input returns empty", () => {
	assert.deepEqual(selectNonOverlapping([], 5), []);
});

test("selectNonOverlapping: maxCount=0 returns empty", () => {
	const steps = [makeStep("a", "a.md"), makeStep("b", "b.md")];
	assert.deepEqual(selectNonOverlapping(steps, 0), []);
});

test("selectNonOverlapping: diamond conflict pattern", () => {
	// a writes to X, b writes to Y, c writes to X — c conflicts with a only
	const steps = [
		makeStep("a", "shared.md"),
		makeStep("b", "y.md"),
		makeStep("c", "shared.md"), // conflicts with a
		makeStep("d", "z.md"),
	];
	const picked = selectNonOverlapping(steps, 10);
	assert.deepEqual(
		picked.map((s) => s.id),
		["a", "b", "d"],
	);
});
