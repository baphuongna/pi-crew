import assert from "node:assert/strict";
import test from "node:test";
import {
	aggregateFailurePatterns,
	formatFailurePatterns,
	normalizeErrorSignature,
} from "../../../../src/extension/team-tool/failure-patterns.ts";

test("normalizeErrorSignature strips run ids, task ids, paths, numbers", () => {
	const sig = normalizeErrorSignature("Task team_20260615180014_a1b2c3d4e5f60718 02_exec failed at /home/bom/x.ts:42 after 3000ms");
	// Should normalize to a signature without those specifics.
	assert.ok(!sig.includes("team_20260615"), "run id stripped");
	assert.ok(!sig.includes("02_exec"), "task id stripped");
	assert.ok(!sig.includes("/home/bom"), "abs path stripped");
	assert.ok(!sig.includes("3000"), "number stripped");
	assert.ok(sig.includes("<run>"), "run placeholder present");
	assert.ok(sig.includes("<task>"), "task placeholder present");
});

test("normalizeErrorSignature returns placeholder for undefined", () => {
	assert.equal(normalizeErrorSignature(undefined), "(no error detail)");
	assert.equal(normalizeErrorSignature(""), "(no error detail)");
});

test("normalizeErrorSignature groups semantically identical errors", () => {
	const a = normalizeErrorSignature("Task 02_exec failed: model routing exhausted (2 candidates) at attempt 3");
	const b = normalizeErrorSignature("Task 05_exec failed: model routing exhausted (5 candidates) at attempt 1");
	assert.equal(a, b, "same root cause → same signature");
});

test("aggregateFailurePatterns returns [] when no failures", () => {
	assert.deepEqual(
		aggregateFailurePatterns([
			{ id: "01", status: "completed" },
			{ id: "02", status: "running" },
		]),
		[],
	);
});

test("aggregateFailurePatterns returns [] when failures are all unique (no repeats)", () => {
	const out = aggregateFailurePatterns([
		{
			id: "01",
			status: "failed",
			error: "unique error A about filesystem",
		},
		{
			id: "02",
			status: "failed",
			error: "totally different error about network",
		},
	]);
	assert.equal(out.length, 0, "singletons are not patterns");
});

test("aggregateFailurePatterns groups repeated root causes", () => {
	const out = aggregateFailurePatterns([
		{
			id: "02_exec",
			status: "failed",
			error: "model routing fallback failed: all 2 candidates exhausted",
		},
		{
			id: "03_exec",
			status: "failed",
			error: "model routing fallback failed: all 5 candidates exhausted",
		},
		{
			id: "04_exec",
			status: "failed",
			error: "model routing fallback failed: all 1 candidates exhausted",
		},
		{ id: "05_exec", status: "failed", error: "EPERM rename /tmp/foo" },
		{ id: "06_exec", status: "failed", error: "EPERM rename /tmp/bar" },
	]);
	assert.equal(out.length, 2, "two distinct root causes");
	const top = out[0];
	assert.equal(top.count, 3, "model routing is the top pattern (3 hits)");
	assert.deepEqual(top.taskIds, ["02_exec", "03_exec", "04_exec"]);
	assert.match(top.representative, /model routing/);
});

test("aggregateFailurePatterns includes cancelled tasks as failures", () => {
	const out = aggregateFailurePatterns([
		{ id: "01", status: "cancelled", error: "aborted by user" },
		{ id: "02", status: "cancelled", error: "aborted by user" },
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0].count, 2);
});

test("aggregateFailurePatterns sorts by count descending", () => {
	const out = aggregateFailurePatterns([
		{ id: "a", status: "failed", error: "rare X" },
		{ id: "b", status: "failed", error: "rare X" },
		{ id: "c", status: "failed", error: "common Y" },
		{ id: "d", status: "failed", error: "common Y" },
		{ id: "e", status: "failed", error: "common Y" },
	]);
	assert.equal(out[0].count, 3);
	assert.equal(out[1].count, 2);
});

test("formatFailurePatterns returns [] when no repeated patterns", () => {
	assert.deepEqual(
		formatFailurePatterns([
			{ id: "01", status: "failed", error: "unique A" },
			{ id: "02", status: "failed", error: "unique B" },
		]),
		[],
	);
});

test("formatFailurePatterns renders a header + grouped lines", () => {
	const lines = formatFailurePatterns([
		{
			id: "02_exec",
			status: "failed",
			error: "model routing failed: 2 candidates",
		},
		{
			id: "03_exec",
			status: "failed",
			error: "model routing failed: 5 candidates",
		},
		{ id: "05_exec", status: "failed", error: "EPERM rename" },
		{ id: "06_exec", status: "failed", error: "EPERM rename" },
		{ id: "07_exec", status: "failed", error: "one-off unique problem" },
	]);
	const text = lines.join("\n");
	assert.match(text, /Common failure patterns \(4 of 5 failures share 2 root causes\):/);
	assert.match(text, /\[×2\] model routing failed/);
	assert.match(text, /tasks: 02_exec, 03_exec/);
});

test("formatFailurePatterns truncates long representative errors", () => {
	const longErr = "A".repeat(200);
	const lines = formatFailurePatterns([
		{ id: "a", status: "failed", error: longErr },
		{ id: "b", status: "failed", error: longErr },
	]);
	const text = lines.join("\n");
	assert.ok(text.includes("…"), "long error truncated with ellipsis");
});

test("formatFailurePatterns handles +N more when many tasks in a bucket", () => {
	const tasks = Array.from({ length: 10 }, (_, i) => ({
		id: `t${i}`,
		status: "failed" as const,
		error: "same root cause",
	}));
	const lines = formatFailurePatterns(tasks);
	const text = lines.join("\n");
	assert.match(text, /tasks: t0, t1, t2, t3, t4, t5, \+4 more/);
});
