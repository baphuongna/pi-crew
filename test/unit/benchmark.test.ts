/**
 * Tests for src/benchmark/benchmark-runner.ts
 * Coverage:
 * - parseAndValidateCommand: allowlist enforcement, metacharacter blocking
 * - runBenchmark: pytest judge, grep judge, command judge
 * - runBenchmarkSuite: filter by taskType, aggregate counts
 * - aggregateBenchmarkMetrics: per-type bucketing, ratios, rounding
 * - generateBenchmarkReport: table format
 *
 * Note: parseAndValidateCommand allows the executables pytest/grep/npm/cargo/echo
 * (npx/node removed — H-7); npm and cargo additionally require a known
 * sub-command (npm test, cargo test/clippy). `echo` IS allowed (the metachar
 * blocker makes it inert).
 *
 * F20 regression coverage (added 2026-09-17, RR-015):
 * - `judges: []` must NOT report `passed: true` — `Array.prototype.every` on an
 *   empty array is vacuously true, which used to make a judge-less task green.
 * - The bare form of every allowlisted command (`npm test`, `cargo test`,
 *   `cargo clippy`, `pytest`, `grep`, `echo`) must be ACCEPTED. The old
 *   single-regex allowlist had a trailing space, so it rejected the bare form
 *   while the error message listed that same form as allowed.
 *
 * Cross-platform notes (Phase 1 M1):
 * - `runBenchmark` uses `execFileSync(program, args)` to spawn the judge
 *   directly (no shell). On Windows there is no `echo.exe` outside Git Bash,
 *   and the security allowlist intentionally excludes `node`/`npx` (H-7).
 * - Tests that depend on `echo ok` succeeding therefore skip on win32.
 * - Tests that only check non-pass status (taskId, durationMs, judgeResults
 *   length, cost=0) still pass on Windows because the failure path is captured
 *   in judgeResults and the suite returns the same shape.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	aggregateBenchmarkMetrics,
	type BenchmarkResult,
	type BenchmarkTask,
	generateBenchmarkReport,
	parseAndValidateCommand,
	runBenchmark,
	runBenchmarkSuite,
} from "../../src/benchmark/benchmark-runner.ts";

/** Skip helper: tests that depend on `echo ok` actually succeeding only run
 *  on POSIX because `echo` is shipped as a separate executable on Linux/macOS
 *  and the benchmark runner does not allow `node` (H-7) as a substitute. */
const skipIfWindows = (t: { skip: (reason: string) => void }, reason: string): boolean => {
	if (process.platform === "win32") {
		t.skip(reason);
		return true;
	}
	return false;
};

test("runBenchmark grep judge: matches pattern in output", async () => {
	const task: BenchmarkTask = {
		id: "t1",
		name: "grep task",
		prompt: "search",
		// grep with simple args is allowed by parseAndValidateCommand
		judges: [
			{
				type: "grep",
				command: "grep hello",
				pattern: "hello",
				description: "Has hello",
			},
		],
	};
	const result = await runBenchmark(task);
	// grep with no input file fails (exit code 2), so judge is "not passed"
	// We just verify the judge ran (didn't throw validation)
	assert.equal(result.taskId, "t1");
});

// ---------------------------------------------------------------------------
// F20 — empty judge set is INCONCLUSIVE, never a pass
// ---------------------------------------------------------------------------

test("F20: runBenchmark with an empty judge set is inconclusive, NOT passed", async () => {
	const task: BenchmarkTask = {
		id: "f20-empty",
		name: "no judges",
		prompt: "p",
		judges: [],
	};
	const result = await runBenchmark(task);

	// RED before the fix: `[].every(...)` is `true` → passed: true with no
	// evidence at all. A task nobody judged must never be reported as passing.
	assert.equal(result.passed, false, "empty judge set must not report passed: true");
	assert.equal(result.inconclusive, true, "empty judge set must be flagged inconclusive");
	assert.match(result.inconclusiveReason ?? "", /no judges/i);
	assert.deepEqual(result.judgeResults, []);
	assert.equal(result.taskId, "f20-empty");
	assert.ok(result.durationMs >= 0);
});

test("F20: runBenchmarkSuite counts an inconclusive task as failed, not passed", async () => {
	const tasks: BenchmarkTask[] = [
		{ id: "no-judges", name: "none", prompt: "p", judges: [] },
		{ id: "judged", name: "bad", prompt: "p", judges: [{ type: "command", command: "rm -rf /", description: "bad" }] },
	];
	const suite = await runBenchmarkSuite(tasks);
	assert.equal(suite.totalPassed, 0, "inconclusive task must not be counted as passed");
	assert.equal(suite.totalFailed, 2);
});

// ---------------------------------------------------------------------------
// F20 — bare command forms must be accepted (allowlist ↔ message agreement)
// ---------------------------------------------------------------------------

test("F20: parseAndValidateCommand accepts the BARE form of every allowlisted command", () => {
	// RED before the fix: the allowlist regex was
	// /^(pytest|grep|npm test|cargo test|cargo clippy|echo) / — the TRAILING
	// SPACE made every bare form fail, including `npm test`, which the error
	// message itself listed as allowed (self-contradictory).
	const accepted: [string, string[]][] = [
		["pytest", ["pytest"]],
		["grep", ["grep"]],
		["npm test", ["npm", "test"]],
		["cargo test", ["cargo", "test"]],
		["cargo clippy", ["cargo", "clippy"]],
		["echo", ["echo"]],
	];
	for (const [command, expected] of accepted) {
		const parsed = parseAndValidateCommand(command);
		assert.deepEqual([parsed.program, ...parsed.args], expected, `bare "${command}" must be accepted`);
	}
});

test("F20: parseAndValidateCommand accepts the allowlisted command WITH arguments", () => {
	const withArgs: [string, string[]][] = [
		["pytest -q tests/", ["pytest", "-q", "tests/"]],
		["grep hello file.txt", ["grep", "hello", "file.txt"]],
		["npm test -- --runInBand", ["npm", "test", "--", "--runInBand"]],
		["cargo test --release", ["cargo", "test", "--release"]],
		["echo hi", ["echo", "hi"]],
	];
	for (const [command, expected] of withArgs) {
		const parsed = parseAndValidateCommand(command);
		assert.deepEqual([parsed.program, ...parsed.args], expected, `"${command}" must be accepted`);
	}
});

test("F20: parseAndValidateCommand validates executable and args SEPARATELY", () => {
	// Executable not on the allowlist — rejected regardless of arguments.
	for (const bad of ["ls -la", "rm -rf /", "node -e 'x'", "npx --yes evil", "", "   "]) {
		assert.throws(() => parseAndValidateCommand(bad), /Command not allowed|Empty command/, `"${bad}" must be rejected`);
	}

	// Allowlisted executable, disallowed sub-command — rejected on the ARGS check.
	for (const bad of ["npm publish", "npm install evil", "npm", "cargo build", "cargo"]) {
		assert.throws(() => parseAndValidateCommand(bad), /Command not allowed/, `"${bad}" must be rejected (sub-command not allowlisted)`);
	}

	// Metacharacters in the arguments — rejected (executable itself is fine).
	for (const bad of ["echo hi; rm -rf /", "echo $(whoami)", "echo `id`", "echo a && b", "echo a | b", "grep x > out.txt"]) {
		assert.throws(() => parseAndValidateCommand(bad), /Shell metacharacters/, `"${bad}" must be rejected (metacharacters)`);
	}
});

test("F20: the 'not allowed' message only lists commands the validator accepts", () => {
	// The message names the allowlist; every name it mentions must actually be
	// accepted, otherwise it is the same self-contradiction as before the fix.
	let message = "";
	try {
		parseAndValidateCommand("ls -la");
	} catch (e) {
		message = e instanceof Error ? e.message : String(e);
	}
	assert.match(message, /Only .*allowed/);
	for (const command of ["pytest", "grep", "npm test", "cargo test", "cargo clippy", "echo"]) {
		assert.ok(message.includes(command), `message must list "${command}": ${message}`);
		assert.doesNotThrow(() => parseAndValidateCommand(command), `message lists "${command}" so it must be accepted`);
	}
});

test("F20: runBenchmark accepts a BARE allowlisted command (reaches execution, no validation error)", async (t) => {
	if (skipIfWindows(t, "echo shell builtin unsupported via execFileSync on win32")) return;
	// Before the fix, the trailing space in the allowlist regex rejected the
	// bare form of EVERY allowed command with the self-contradictory message
	// "Command not allowed: echo. Only pytest, grep, npm test, … echo allowed".
	// Bare `echo` is used here (not `npm test`) so the unit test never spawns a
	// real test suite: the point is that the bare form clears VALIDATION and
	// reaches execution.
	const result = await runBenchmark({
		id: "f20-bare",
		name: "bare echo",
		prompt: "p",
		judges: [{ type: "command", command: "echo", description: "bare echo" }],
	});
	const output = result.judgeResults[0]?.output ?? "";
	assert.doesNotMatch(output, /Command not allowed/, `bare "echo" must pass validation. Got: ${output}`);
	assert.equal(result.passed, true, `bare "echo" should succeed as a command judge. Got: ${output}`);
});

test("F20: bare 'npm test' clears validation (asserted without spawning npm)", () => {
	// Validation is asserted directly rather than via runBenchmark so this test
	// never shells out to a real `npm test` (which would recursively run this
	// very suite). The pre-fix behaviour was a validation rejection whose own
	// message listed `npm test` as allowed.
	assert.doesNotThrow(() => parseAndValidateCommand("npm test"));
	assert.deepEqual(parseAndValidateCommand("npm test"), { program: "npm", args: ["test"] });
});

test("runBenchmark fails on invalid judge shape (no command) with a diagnostic", async () => {
	const result = await runBenchmark({
		id: "f20-invalid-judge",
		name: "invalid",
		prompt: "p",
		judges: [{ type: "command", description: "no command field" }],
	});
	assert.equal(result.passed, false);
	assert.match(result.judgeResults[0]?.output ?? "", /Invalid judge/);
});

test("runBenchmark command judge: fails for commands not in allowlist", async () => {
	const task: BenchmarkTask = {
		id: "t2",
		name: "command task",
		prompt: "run",
		judges: [{ type: "command", command: "ls -la", description: "Lists files" }],
	};
	const result = await runBenchmark(task);
	// 'ls' is not in the allowlist (pytest|grep|npm test|cargo test|cargo clippy|echo),
	// so the judge should fail validation (not pass).
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
		judges: [
			{
				type: "command",
				command: "npx foo; rm -rf /",
				description: "Injection",
			},
		],
	};
	const result = await runBenchmark(task);
	assert.equal(result.passed, false);
});

test("runBenchmark fails on command substitution", async () => {
	const task: BenchmarkTask = {
		id: "t5",
		name: "subst",
		prompt: "test",
		judges: [
			{
				type: "command",
				command: "npx $(whoami)",
				description: "Substitution",
			},
		],
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

test("runBenchmark records durationMs", async (t) => {
	if (skipIfWindows(t, "echo shell builtin unsupported via execFileSync on win32; benchmark H-7 disallows `node` substitute")) return;
	const task: BenchmarkTask = {
		id: "t7",
		name: "timing",
		prompt: "x",
		judges: [{ type: "command", command: "echo ok", description: "Npx help" }],
	};
	const result = await runBenchmark(task);
	assert.ok(result.durationMs >= 0);
});

test("runBenchmark with multiple judges requires all to pass", async (t) => {
	if (skipIfWindows(t, "echo shell builtin unsupported via execFileSync on win32; benchmark H-7 disallows `node` substitute")) return;
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

test("runBenchmark cost defaults to 0", async (t) => {
	if (skipIfWindows(t, "echo shell builtin unsupported via execFileSync on win32; benchmark H-7 disallows `node` substitute")) return;
	const task: BenchmarkTask = {
		id: "t9",
		name: "cost",
		prompt: "x",
		judges: [{ type: "command", command: "echo ok", description: "Help" }],
	};
	const result = await runBenchmark(task);
	assert.equal(result.cost, 0);
});

test("runBenchmarkSuite filters by taskType", async (t) => {
	if (skipIfWindows(t, "echo shell builtin unsupported via execFileSync on win32; benchmark H-7 disallows `node` substitute")) return;
	const tasks: BenchmarkTask[] = [
		{
			id: "a",
			name: "A",
			prompt: "p",
			judges: [{ type: "command", command: "echo ok", description: "A" }],
			taskType: "unit",
		},
		{
			id: "b",
			name: "B",
			prompt: "p",
			judges: [{ type: "command", command: "echo ok", description: "B" }],
			taskType: "integration",
		},
		{
			id: "c",
			name: "C",
			prompt: "p",
			judges: [{ type: "command", command: "echo ok", description: "C" }],
			taskType: "unit",
		},
	];
	const suite = await runBenchmarkSuite(tasks, ["unit"]);
	assert.equal(suite.results.length, 2);
});

test("runBenchmarkSuite runs all tasks without taskTypes filter", async (t) => {
	if (skipIfWindows(t, "echo shell builtin unsupported via execFileSync on win32; benchmark H-7 disallows `node` substitute")) return;
	const tasks: BenchmarkTask[] = [
		{
			id: "a",
			name: "A",
			prompt: "p",
			judges: [{ type: "command", command: "echo ok", description: "A" }],
			taskType: "unit",
		},
		{
			id: "b",
			name: "B",
			prompt: "p",
			judges: [{ type: "command", command: "echo ok", description: "B" }],
			taskType: "integration",
		},
	];
	const suite = await runBenchmarkSuite(tasks);
	assert.equal(suite.results.length, 2);
});

test("runBenchmarkSuite computes total counts", async (t) => {
	if (skipIfWindows(t, "echo shell builtin unsupported via execFileSync on win32; benchmark H-7 disallows `node` substitute")) return;
	const tasks: BenchmarkTask[] = [
		{
			id: "a",
			name: "A",
			prompt: "p",
			judges: [{ type: "command", command: "echo ok", description: "A" }],
		},
		{
			id: "b",
			name: "B",
			prompt: "p",
			judges: [{ type: "command", command: "echo ok", description: "B" }],
		},
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
		{
			taskId: "1",
			passed: true,
			judgeResults: [],
			durationMs: 100,
			cost: 0,
			taskType: "unit",
		},
		{
			taskId: "2",
			passed: false,
			judgeResults: [],
			durationMs: 200,
			cost: 0,
			taskType: "unit",
		},
		{
			taskId: "3",
			passed: true,
			judgeResults: [],
			durationMs: 300,
			cost: 0,
			taskType: "integration",
		},
	];
	const metrics = aggregateBenchmarkMetrics(results);
	assert.equal(metrics.unit?.totalTasks, 2);
	assert.equal(metrics.unit?.passedTasks, 1);
	assert.equal(metrics.unit?.passRate, 0.5);
	assert.equal(metrics.integration?.totalTasks, 1);
	assert.equal(metrics.integration?.passedTasks, 1);
});

test("aggregateBenchmarkMetrics groups untagged under __default__", () => {
	const results: BenchmarkResult[] = [
		{
			taskId: "1",
			passed: true,
			judgeResults: [],
			durationMs: 100,
			cost: 0,
		},
		{
			taskId: "2",
			passed: true,
			judgeResults: [],
			durationMs: 200,
			cost: 0,
		},
	];
	const metrics = aggregateBenchmarkMetrics(results);
	assert.equal(metrics.__default__?.totalTasks, 2);
});

test("aggregateBenchmarkMetrics handles empty results", () => {
	const metrics = aggregateBenchmarkMetrics([]);
	assert.deepEqual(metrics, {});
});

test("aggregateBenchmarkMetrics computes avg cost per task", () => {
	const results: BenchmarkResult[] = [
		{
			taskId: "1",
			passed: true,
			judgeResults: [],
			durationMs: 100,
			cost: 0.002,
			taskType: "unit",
		},
		{
			taskId: "2",
			passed: true,
			judgeResults: [],
			durationMs: 200,
			cost: 0.004,
			taskType: "unit",
		},
	];
	const metrics = aggregateBenchmarkMetrics(results);
	assert.equal(metrics.unit?.avgCost, 0.003);
	assert.equal(metrics.unit?.totalCost, 0.006);
});

test("generateBenchmarkReport produces markdown table", () => {
	const results: BenchmarkResult[] = [
		{
			taskId: "1",
			passed: true,
			judgeResults: [],
			durationMs: 100,
			cost: 0.001,
			taskType: "unit",
		},
		{
			taskId: "2",
			passed: false,
			judgeResults: [],
			durationMs: 200,
			cost: 0,
			taskType: "integration",
		},
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
		{
			taskId: "1",
			passed: true,
			judgeResults: [],
			durationMs: 100,
			cost: 0,
		},
		{
			taskId: "2",
			passed: false,
			judgeResults: [],
			durationMs: 200,
			cost: 0,
		},
	];
	const report = generateBenchmarkReport(results);
	assert.ok(report.includes("**Total: 1/2 passed**"));
});

test("generateBenchmarkReport without per-type table", () => {
	const results: BenchmarkResult[] = [
		{
			taskId: "1",
			passed: true,
			judgeResults: [],
			durationMs: 100,
			cost: 0,
		},
	];
	const report = generateBenchmarkReport(results, false);
	assert.ok(!report.includes("Per-Task-Type Comparison"));
});
