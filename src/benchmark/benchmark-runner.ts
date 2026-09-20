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
	/**
	 * F20: true when the task produced NO verdict at all (e.g. `judges: []`).
	 * An inconclusive result is never a pass — `passed` stays `false` because
	 * `Array.prototype.every` on an empty array is vacuously `true`, which used
	 * to report a judge-less task as `passed: true`.
	 */
	inconclusive?: boolean;
	/** Why the result is inconclusive (present iff `inconclusive` is true). */
	inconclusiveReason?: string;
	judgeResults: { description: string; passed: boolean; output?: string }[];
	durationMs: number;
	/** Estimated cost in dollars (0 if not tracked). */
	cost: number;
}

/**
 * Executables the runner may spawn directly (no shell is involved: the
 * executable and its args are passed to `execFileSync` as separate argv
 * entries, so no shell parsing happens at all).
 *
 * SECURITY (H-7): `npx`/`node` are NOT allowed because they enable arbitrary
 * code execution without any shell metacharacter (e.g. `npx --yes
 * evil-package` or `node -e "require('fs')…"`). `echo` is allowed because the
 * metacharacter blocker below rejects command substitution (`$(...)`,
 * backticks), so `echo $(evil)` cannot run; bare `echo …` only prints. It is
 * the canonical exit-0 command used in benchmark fixtures across
 * Linux/macOS/Windows(sh).
 */
const ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set(["pytest", "grep", "npm", "cargo", "echo"]);

/**
 * Executables that additionally require a specific first argument. Without this
 * the allowlist entry `npm` would admit `npm publish` / `npm install <evil>`.
 */
const REQUIRED_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
	npm: ["test"],
	cargo: ["test", "clippy"],
};

/** Human-readable allowlist used in error messages (must match the code above). */
const ALLOWED_SUMMARY = "pytest, grep, npm test, cargo test, cargo clippy, echo";

/** Shell metacharacters blocked inside command arguments. */
const DANGEROUS_ARG_PATTERNS: readonly RegExp[] = [
	/[;&|`$(){}[\]<>\\]/, // Shell metacharacters
	/\$\([^)]*\)/, // Command substitution $(...)
	/`[^`]*`/, // Backtick command substitution
	/\|/, // Pipe
	/&&/, // And
	/\|\|/, // Or
	/>>/, // Append redirect
	/2>&1/, // stderr redirect
	/>/, // Output redirect
	/</, // Input redirect
];

/**
 * Validate a benchmark judge command and split it into executable + args.
 *
 * F20: the previous implementation used a single regex
 * (`/^(pytest|grep|npm test|cargo test|cargo clippy|echo) /`) with a TRAILING
 * SPACE, so the bare form of every allowed command was rejected — while the
 * error message listed that same bare command as allowed
 * ("Command not allowed: npm test. Only pytest, grep, npm test, …"). The
 * executable and the sub-command are now validated as separate tokens, so
 * `npm test` is accepted and `npm publish` / `npm install x` are not.
 *
 * Exported for direct unit testing of the validation boundary.
 */
export function parseAndValidateCommand(command: string): { program: string; args: string[] } {
	const trimmed = (command ?? "").trim();
	if (trimmed.length === 0) throw new Error("Empty command");

	// Naive split on whitespace: the metacharacter blocker below (plus the
	// executable allowlist) means a simple split cannot smuggle shell syntax.
	const parts = trimmed.split(/\s+/);
	const program = parts[0]!;
	const args = parts.slice(1);

	if (!ALLOWED_EXECUTABLES.has(program)) {
		throw new Error(`Command not allowed: ${command}. Only ${ALLOWED_SUMMARY} allowed.`);
	}

	const required = REQUIRED_SUBCOMMANDS[program];
	if (required && !required.includes(args[0] ?? "")) {
		const forms = required.map((sub) => `"${program} ${sub}"`).join(" or ");
		throw new Error(`Command not allowed: ${command}. "${program}" must be invoked as ${forms}.`);
	}

	// Block shell metacharacters in the ARGUMENTS. The executable is matched
	// against the allowlist above, so it can never carry metacharacters itself.
	const argsText = args.join(" ");
	for (const pattern of DANGEROUS_ARG_PATTERNS) {
		if (pattern.test(argsText)) {
			throw new Error(`Shell metacharacters not allowed in command arguments`);
		}
	}

	return { program, args };
}

export async function runBenchmark(task: BenchmarkTask): Promise<BenchmarkResult> {
	const startTime = Date.now();
	const judgeResults: BenchmarkResult["judgeResults"] = [];
	const judges = task.judges ?? [];

	// FAIL CLOSED (F20): a task with no judges produces no evidence. `every()` on
	// an empty array is vacuously TRUE, so `judges: []` used to be reported as
	// `passed: true`. Return an explicit inconclusive result instead — never a pass.
	if (judges.length === 0) {
		return {
			taskId: task.id,
			passed: false,
			inconclusive: true,
			inconclusiveReason: "task defines no judges — nothing was evaluated, so pass/fail cannot be decided",
			judgeResults: [],
			durationMs: Date.now() - startTime,
			cost: 0,
			taskType: task.taskType,
		};
	}

	for (const judge of judges) {
		try {
			let passed = false;
			let output: string | undefined;

			if (judge.type === "pytest" && judge.command) {
				// Validate the executable + args before execution (defense-in-depth)
				const { program, args } = parseAndValidateCommand(judge.command);
				// Tier 1: pytest - fast deterministic check
				output = execFileSync(program, args, {
					timeout: 5000,
					encoding: "utf-8",
					cwd: process.cwd(),
				});
				// Look for pytest summary line with passed count
				passed = output.includes("passed");
			} else if (judge.type === "grep" && judge.pattern && judge.command) {
				const { program, args } = parseAndValidateCommand(judge.command);
				// Tier 2: grep pattern matching
				output = execFileSync(program, args, {
					timeout: 5000,
					encoding: "utf-8",
					cwd: process.cwd(),
				});
				passed = output.includes(judge.pattern);
			} else if (judge.type === "command" && judge.command) {
				const { program, args } = parseAndValidateCommand(judge.command);
				// Tier 3: command execution
				output = execFileSync(program, args, {
					timeout: 10000,
					encoding: "utf-8",
					cwd: process.cwd(),
				});
				passed = true; // Command succeeded = pass
			} else {
				// Malformed judge (no command, or grep without a pattern). Fail the
				// judge with an explicit diagnostic instead of silently recording an
				// unexplained `passed: false` with no output.
				throw new Error(
					`Invalid judge "${judge.description}": type "${judge.type}" requires ${judge.type === "grep" ? "command + pattern" : "command"}`,
				);
			}

			judgeResults.push({
				description: judge.description,
				passed,
				output,
			});
		} catch (e: unknown) {
			const error = e as { message?: string };
			judgeResults.push({
				description: judge.description,
				passed: false,
				output: error.message ?? String(e),
			});
		}
	}

	return {
		taskId: task.id,
		// F20: explicit `length > 0` guard. `every()` is vacuously true on an
		// empty array, so a judge list that produced no verdicts must never be
		// read as success (the empty case is short-circuited above, but the
		// guard keeps the invariant local to this expression).
		passed: judgeResults.length > 0 && judgeResults.every((j) => j.passed),
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
	const filtered = taskTypes ? tasks.filter((t) => t.taskType && taskTypes.includes(t.taskType)) : tasks;

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
		const avgTimeMs = totalTasks > 0 ? group.reduce((s, r) => s + r.durationMs, 0) / totalTasks : 0;
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
export function generateBenchmarkReport(results: BenchmarkResult[], includeTaskTypeComparison = true): string {
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
				lines.push(`| ${m.taskType} | ${m.totalTasks} | ${m.passedTasks} | ${passRatePct} | ${m.avgTimeMs}ms | ${avgCostStr} |`);
			}
		}
	}

	const passed = results.filter((r) => r.passed).length;
	lines.push("");
	lines.push(`**Total: ${passed}/${results.length} passed**`);

	return lines.join("\n");
}
