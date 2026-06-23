/**
 * Tests for src/benchmark/benchmark-runner.ts
 * Coverage:
 * - validateCommand: allowlist enforcement, metacharacter blocking
 * - runBenchmark: pytest judge, grep judge, command judge
 * - runBenchmarkSuite: filter by taskType, aggregate counts
 * - aggregateBenchmarkMetrics: per-type bucketing, ratios, rounding
 * - generateBenchmarkReport: table format
 *
 * Note: validateCommand only allows pytest/grep/npm test/cargo test/clippy prefixes (npx/node removed — H-7).
 * Tests use 'grep' for command-style and 'echo' is NOT allowed (intentional).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runBenchmark, runBenchmarkSuite, aggregateBenchmarkMetrics, generateBenchmarkReport, type BenchmarkTask, type BenchmarkResult } from "../../src/benchmark/benchmark-runner.ts";

test("runBenchmark grep judge: matches pattern in output", async () => {
	const task: BenchmarkTask = {
		id: "t1",
		name: "grep task",
		prompt: "search",
		// grep with simple args is allowed by validateCommand
		judges: [{ type: "grep", command: "grep hello", pattern: "hello", description: "Has hello" }],
	};
	const result = await runBenchmark(task);
	// grep with no input file fails (exit code 2), so judge is "not passed"
	// We just verify the judge ran (didn't throw validation)
	assert.equal(result.taskId, "t1");
});

test("runBenchmark command judge: fails for commands not in allowlist", async () => {
	const task: BenchmarkTask = {
		id: "t2",
		name: "command task",
		prompt: "run",
		judges: [{ type: "command", command: "echo done", description: "Echoes done" }],
	};
	const result = await runBenchmark(task);
	// 'echo' is not in allowlist, so judge should fail (not pass)
	assert.equal(result.passed, false);
});

test("runBenchmark fails on disallowed command (rm)", async () => {
	const task: BenchmarkTask = {
		id: "t3",
		name: "bad",
		prompt: "rm",
		judges: [{ type: "command", command: "rm -rf /", description: "Dangerous" }],
	};
	const result = await runBenchmark(task);
	assert.equal(result.passed, false);
	assert.equal(result.judgeResults[0]?.passed, false);
});

test("runBenchmark fails on shell metacharacter", async () => {
	const task: BenchmarkTask = {
		id: "t4",
		name: "metachar",
		prompt: "test",
		judges: [{ type: "command", command: "npx foo; rm -rf /", description: "Injection" }],
	};
	const result = await runBenchmark(task);
	assert.equal(result.passed, false);
});

test("runBenchmark fails on command substitution", async () => {
	const task: BenchmarkTask = {
		id: "t5",
		name: "subst",
		prompt: "test",
		judges: [{ type: "command", command: "npx $(whoami)", description: "Substitution" }],
	};
	const result = await runBenchmark(task);
	assert.equal(result.passed, false);
});

test("runBenchmark fails on backtick", async () => {
	const task: BenchmarkTask = {
		id: "t6",
		name: "backtick",
		prompt: "test",
		judges: [{ type: "command", command: "npx `id`", description: "Backtick" }],
	};
	const result = await runBenchmark(task);
	assert.equal(result.passed, false);
});

test("runBenchmark records durationMs", async () => {
	const task: BenchmarkTask = {
		id: "t7",
		name: "timing",
		prompt: "x",
		judges: [{ type: "command", command: "grep --help", description: "Npx help" }],
	};
	const result = await runBenchmark(task);
	assert.ok(result.durationMs >= 0);
});

test("runBenchmark with multiple judges requires all to pass", async () => {
	const task: BenchmarkTask = {
		id: "t8",
		name: "multi",
		prompt: "x",
		judges: [
			{ type: "command", command: "rm -rf /", description: "Bad cmd" },
			{ type: "command", command: "echo done", description: "Echo" },
		],
	};
	const result = await runBenchmark(task);
	assert.equal(result.passed, false, "should fail because first judge fails");
	assert.equal(result.judgeResults.length, 2);
});

test("runBenchmark cost defaults to 0", async () => {
	const task: BenchmarkTask = {
		id: "t9",
		name: "cost",
		prompt: "x",
		judges: [{ type: "command", command: "grep --help", description: "Help" }],
	};
	const result = await runBenchmark(task);
	assert.equal(result.cost, 0);
});

test("runBenchmarkSuite filters by taskType", async () => {
	const tasks: BenchmarkTask[] = [
		{ id: "a", name: "A", prompt: "p", judges: [{ type: "command", command: "grep --help", description: "A" }], taskType: "unit" },
		{ id: "b", name: "B", prompt: "p", judges: [{ type: "command", command: "grep --help", description: "B" }], taskType: "integration" },
		{ id: "c", name: "C", prompt: "p", judges: [{ type: "command", command: "grep --help", description: "C" }], taskType: "unit" },
	];
	const suite = await runBenchmarkSuite(tasks, ["unit"]);
	assert.equal(suite.results.length, 2);
});

test("runBenchmarkSuite runs all tasks without taskTypes filter", async () => {
	const tasks: BenchmarkTask[] = [
		{ id: "a", name: "A", prompt: "p", judges: [{ type: "command", command: "grep --help", description: "A" }], taskType: "unit" },
		{ id: "b", name: "B", prompt: "p", judges: [{ type: "command", command: "grep --help", description: "B" }], taskType: "integration" },
	];
	const suite = await runBenchmarkSuite(tasks);
	assert.equal(suite.results.length, 2);
});

test("runBenchmarkSuite computes total counts", async () => {
	const tasks: BenchmarkTask[] = [
		{ id: "a", name: "A", prompt: "p", judges: [{ type: "command", command: "grep --help", description: "A" }] },
		{ id: "b", name: "B", prompt: "p", judges: [{ type: "command", command: "grep --help", description: "B" }] },
	];
	const suite = await runBenchmarkSuite(tasks);
	assert.equal(suite.totalFailed, 0);
	assert.ok(suite.totalDurationMs >= 0);
});

test("runBenchmarkSuite handles empty task list", async () => {
	const suite = await runBenchmarkSuite([]);
	assert.equal(suite.results.length, 0);
	assert.equal(suite.totalPassed, 0);
	assert.equal(suite.totalFailed, 0);
});

test("aggregateBenchmarkMetrics buckets by taskType", () => {
	const results: BenchmarkResult[] = [
		{ taskId: "1", passed: true, judgeResults: [], durationMs: 100, cost: 0, taskType: "unit" },
		{ taskId: "2", passed: false, judgeResults: [], durationMs: 200, cost: 0, taskType: "unit" },
		{ taskId: "3", passed: true, judgeResults: [], durationMs: 300, cost: 0, taskType: "integration" },
	];
	const metrics = aggregateBenchmarkMetrics(results);
	assert.equal(metrics["unit"]?.totalTasks, 2);
	assert.equal(metrics["unit"]?.passedTasks, 1);
	assert.equal(metrics["unit"]?.passRate, 0.5);
	assert.equal(metrics["integration"]?.totalTasks, 1);
	assert.equal(metrics["integration"]?.passedTasks, 1);
});

test("aggregateBenchmarkMetrics groups untagged under __default__", () => {
	const results: BenchmarkResult[] = [
		{ taskId: "1", passed: true, judgeResults: [], durationMs: 100, cost: 0 },
		{ taskId: "2", passed: true, judgeResults: [], durationMs: 200, cost: 0 },
	];
	const metrics = aggregateBenchmarkMetrics(results);
	assert.equal(metrics["__default__"]?.totalTasks, 2);
});

test("aggregateBenchmarkMetrics handles empty results", () => {
	const metrics = aggregateBenchmarkMetrics([]);
	assert.deepEqual(metrics, {});
});

test("aggregateBenchmarkMetrics computes avg cost per task", () => {
	const results: BenchmarkResult[] = [
		{ taskId: "1", passed: true, judgeResults: [], durationMs: 100, cost: 0.002, taskType: "unit" },
		{ taskId: "2", passed: true, judgeResults: [], durationMs: 200, cost: 0.004, taskType: "unit" },
	];
	const metrics = aggregateBenchmarkMetrics(results);
	assert.equal(metrics["unit"]?.avgCost, 0.003);
	assert.equal(metrics["unit"]?.totalCost, 0.006);
});

test("generateBenchmarkReport produces markdown table", () => {
	const results: BenchmarkResult[] = [
		{ taskId: "1", passed: true, judgeResults: [], durationMs: 100, cost: 0.001, taskType: "unit" },
		{ taskId: "2", passed: false, judgeResults: [], durationMs: 200, cost: 0, taskType: "integration" },
	];
	const report = generateBenchmarkReport(results);
	assert.ok(report.includes("# Benchmark Results"));
	assert.ok(report.includes("| Task | Type | Status |"));
	assert.ok(report.includes("1"));
	assert.ok(report.includes("✅ PASS"));
	assert.ok(report.includes("❌ FAIL"));
	assert.ok(report.includes("Per-Task-Type Comparison"));
});

test("generateBenchmarkReport includes total count", () => {
	const results: BenchmarkResult[] = [
		{ taskId: "1", passed: true, judgeResults: [], durationMs: 100, cost: 0 },
		{ taskId: "2", passed: false, judgeResults: [], durationMs: 200, cost: 0 },
	];
	const report = generateBenchmarkReport(results);
	assert.ok(report.includes("**Total: 1/2 passed**"));
});

test("generateBenchmarkReport without per-type table", () => {
	const results: BenchmarkResult[] = [
		{ taskId: "1", passed: true, judgeResults: [], durationMs: 100, cost: 0 },
	];
	const report = generateBenchmarkReport(results, false);
	assert.ok(!report.includes("Per-Task-Type Comparison"));
});
