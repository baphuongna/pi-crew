/**
 * Benchmark runner - agent-eval inspired benchmarking system.
 * Provides tiered evaluation for workflow tasks.
 */

import { execFileSync } from "node:child_process";

export interface BenchmarkJudge {
	type: "pytest" | "grep" | "command";
	command?: string;
	pattern?: string;
	description: string;
}

export interface BenchmarkTask {
	id: string;
	name: string;
	prompt: string;
	judges: BenchmarkJudge[];
	/** Optional task-type label used for aggregate metrics grouping. */
	taskType?: string;
}

export interface BenchmarkResult {
	taskId: string;
	/** Task-type label for aggregation grouping. */
	taskType?: string;
	passed: boolean;
	judgeResults: { description: string; passed: boolean; output?: string }[];
	durationMs: number;
	/** Estimated cost in dollars (0 if not tracked). */
	cost: number;
}

/**
 * Validate command against allowlist to prevent shell injection.
 * Only allows specific safe commands with arguments.
 */
/**
 * Validate command against allowlist to prevent shell injection.
 * Uses comprehensive shell metacharacter blocking similar to safe-bash.ts.
 */
function validateCommand(command: string): void {
  // Basic allowlist - must start with an allowed command.
  // SECURITY (H-7): `npx`/`node` were removed because they enable arbitrary code
  // execution without any shell metacharacter (e.g. `npx --yes evil-package`
  // or `node -e "require('fs')…"`). Use `npm test`/`npm run …` instead of raw
  // `node`/`npx` in benchmark task definitions.
  const allowlist = /^(pytest|grep|npm test|cargo test|cargo clippy) /;
  if (!allowlist.test(command)) {
    throw new Error(`Command not allowed: ${command}. Only pytest, grep, npm test, cargo test/clippy allowed.`);
  }
  
  // Block shell metacharacters after command name
  const afterCommand = command.substring(command.indexOf(" ") + 1);
  
  // Block dangerous shell metacharacters
  const dangerousPatterns = [
    /[;&|`$(){}[\]<>\\]/,                    // Shell metacharacters
    /\$\([^)]*\)/,                            // Command substitution $(...)
    /`[^`]*`/,                                // Backtick command substitution
    /\|/,                                     // Pipe
    /&&/,                                     // And
    /\|\|/,                                   // Or
    />>/,                                     // Append redirect
    /2>&1/,                                   // stderr redirect
    />/,                                      // Output redirect
    /</,                                      // Input redirect
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(afterCommand)) {
      throw new Error(`Shell metacharacters not allowed in command arguments`);
    }
  }
}

/**
 * Run a single benchmark task with tiered judges.
 * Tier 1: pytest (fast, deterministic)
 * Tier 2: grep pattern matching
 * Tier 3: command execution
 * Fails fast on first tier failure.
 */
function splitCommand(command: string): { program: string; args: string[] } {
	// Naive split on whitespace. validateCommand already rejects shell
	// metacharacters, so a simple split is safe.
	const parts = command.trim().split(/\s+/);
	if (parts.length === 0) {
		throw new Error("Empty command");
	}
	return { program: parts[0]!, args: parts.slice(1) };
}

export async function runBenchmark(task: BenchmarkTask): Promise<BenchmarkResult> {
	const startTime = Date.now();
	const judgeResults: BenchmarkResult["judgeResults"] = [];

	for (const judge of task.judges) {
		try {
			let passed = false;
			let output: string | undefined;

			if (judge.type === "pytest" && judge.command) {
				// Validate command before execution (defense-in-depth)
				validateCommand(judge.command);
				// Use execFileSync to avoid shell parsing. validateCommand
				// already rejects metacharacters, so a simple split is safe.
				const { program, args } = splitCommand(judge.command);
				// Tier 1: pytest - fast deterministic check
				output = execFileSync(program, args, {
					timeout: 5000,
					encoding: "utf-8",
					cwd: process.cwd(),
				});
				// Look for pytest summary line with passed count
				passed = output.includes("passed");
			} else if (judge.type === "grep" && judge.pattern && judge.command) {
				// Validate command before execution (defense-in-depth)
				validateCommand(judge.command);
				const { program, args } = splitCommand(judge.command);
				// Tier 2: grep pattern matching
				output = execFileSync(program, args, {
					timeout: 5000,
					encoding: "utf-8",
					cwd: process.cwd(),
				});
				passed = output.includes(judge.pattern);
			} else if (judge.type === "command" && judge.command) {
				// Validate command before execution (defense-in-depth)
				validateCommand(judge.command);
				const { program, args } = splitCommand(judge.command);
				// Tier 3: command execution
				output = execFileSync(program, args, {
					timeout: 10000,
					encoding: "utf-8",
					cwd: process.cwd(),
				});
				passed = true; // Command succeeded = pass
			}

			judgeResults.push({ description: judge.description, passed: passed ?? false, output });
		} catch (e: unknown) {
			const error = e as { message?: string };
			judgeResults.push({ description: judge.description, passed: false, output: error.message ?? String(e) });
		}
	}

	return {
		taskId: task.id,
		passed: judgeResults.every((j) => j.passed),
		judgeResults,
		durationMs: Date.now() - startTime,
		cost: 0,
		taskType: task.taskType,
	};
}

/**
 * Aggregate metrics computed over a group of benchmark results for a single task type.
 */
export interface BenchmarkMetrics {
	taskType: string;
	totalTasks: number;
	passedTasks: number;
	/** Ratio of passed/total (0–1). */
	passRate: number;
	/** Mean execution duration in milliseconds. */
	avgTimeMs: number;
	/** Total estimated cost in dollars across all tasks. */
	totalCost: number;
	/** Mean cost in dollars per task. */
	avgCost: number;
}

/**
 * Per-task-type aggregate metrics map.
 * Keys are task-type labels; "__default__" is used when a task has no label.
 */
export type AggregateMetrics = Record<string, BenchmarkMetrics>;

/**
 * Run multiple benchmark tasks and aggregate results.
 *
 * @param tasks - Benchmark tasks to execute. Each task may carry a `taskType` label.
 * @param taskTypes - Optional subset of task-type labels to run. If provided, only tasks
 *   whose `taskType` is in this set will be executed. If omitted, all tasks run.
 */
export async function runBenchmarkSuite(
	tasks: BenchmarkTask[],
	taskTypes?: string[],
): Promise<{
	results: BenchmarkResult[];
	totalPassed: number;
	totalFailed: number;
	totalDurationMs: number;
	totalCost: number;
}> {
	const filtered = taskTypes
		? tasks.filter((t) => t.taskType && taskTypes.includes(t.taskType))
		: tasks;

	const results: BenchmarkResult[] = [];

	for (const task of filtered) {
		const result = await runBenchmark(task);
		results.push(result);
	}

	const totalPassed = results.filter((r) => r.passed).length;
	const totalFailed = results.length - totalPassed;
	const totalDurationMs = results.reduce((a, b) => a + b.durationMs, 0);
	const totalCost = results.reduce((a, b) => a + b.cost, 0);

	return { results, totalPassed, totalFailed, totalDurationMs, totalCost };
}

/**
 * Aggregate benchmark results into per-task-type metrics.
 *
 * @param results - Raw benchmark results (may include any task-type mix).
 * @returns A map from task-type label to `BenchmarkMetrics`. Tasks with no label
 *   are grouped under `"__default__"`.
 */
export function aggregateBenchmarkMetrics(results: BenchmarkResult[]): AggregateMetrics {
	const buckets: Record<string, BenchmarkResult[]> = {};

	for (const result of results) {
		const key = result.taskType ?? "__default__";
		if (!buckets[key]) buckets[key] = [];
		buckets[key].push(result);
	}

	const metrics: AggregateMetrics = {};

	for (const [taskType, group] of Object.entries(buckets)) {
		const totalTasks = group.length;
		const passedTasks = group.filter((r) => r.passed).length;
		const passRate = totalTasks > 0 ? passedTasks / totalTasks : 0;
		const avgTimeMs =
			totalTasks > 0 ? group.reduce((s, r) => s + r.durationMs, 0) / totalTasks : 0;
		const totalCost = group.reduce((s, r) => s + r.cost, 0);
		const avgCost = totalTasks > 0 ? totalCost / totalTasks : 0;

		metrics[taskType] = {
			taskType,
			totalTasks,
			passedTasks,
			passRate: Math.round(passRate * 1000) / 1000,
			avgTimeMs: Math.round(avgTimeMs),
			totalCost: Math.round(totalCost * 1e6) / 1e6,
			avgCost: Math.round(avgCost * 1e6) / 1e6,
		};
	}

	return metrics;
}

/**
 * Generate a markdown comparison table for benchmark results including per-type aggregates.
 *
 * @param results - Benchmark results to report.
 * @param includeTaskTypeComparison - When true (default), appends a per-task-type aggregate table.
 */
export function generateBenchmarkReport(
	results: BenchmarkResult[],
	includeTaskTypeComparison = true,
): string {
	const lines: string[] = ["# Benchmark Results", ""];

	lines.push("| Task | Type | Status | Duration | Cost |");
	lines.push("|------|------|--------|---------|------|");

	for (const r of results) {
		const status = r.passed ? "✅ PASS" : "❌ FAIL";
		const type = r.taskType ?? "—";
		const cost = r.cost > 0 ? `$${r.cost.toFixed(4)}` : "—";
		lines.push(`| ${r.taskId} | ${type} | ${status} | ${r.durationMs}ms | ${cost} |`);
	}

	lines.push("");

	// Per-type aggregate table.
	if (includeTaskTypeComparison && results.length > 0) {
		const metrics = aggregateBenchmarkMetrics(results);
		const types = Object.keys(metrics).sort();

		if (types.length > 0) {
			lines.push("## Per-Task-Type Comparison", "");
			lines.push("| Task Type | Total | Passed | Pass Rate | Avg Time | Avg Cost |");
			lines.push("|-----------|-------|--------|-----------|----------|---------|");

			for (const t of types) {
				const m = metrics[t];
				const passRatePct = `${(m.passRate * 100).toFixed(1)}%`;
				const avgCostStr = m.avgCost > 0 ? `$${m.avgCost.toFixed(4)}` : "—";
				lines.push(
					`| ${m.taskType} | ${m.totalTasks} | ${m.passedTasks} | ${passRatePct} | ${m.avgTimeMs}ms | ${avgCostStr} |`,
				);
			}
		}
	}

	const passed = results.filter((r) => r.passed).length;
	lines.push("");
	lines.push(`**Total: ${passed}/${results.length} passed**`);

	return lines.join("\n");
}