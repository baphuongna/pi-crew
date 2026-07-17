/**
 * Tiered Evaluation System
 *
 * Inspired by agent-eval's judge tiers, this module provides a hierarchical
 * evaluation system where checks are grouped by computational cost and reliability:
 *
 * - Tier 1 (deterministic): Fast checks (~1s timeout) - file exists, parse errors, etc.
 * - Tier 2 (pattern): Medium checks (~5s timeout) - grep, regex, structural checks
 * - Tier 3 (llm): Expensive checks (~60s timeout) - LLM-based evaluation
 */

import type { EvalResult, EvalTier, TierConfig } from "./types-eval.ts";

/**
 * Default tier configurations with increasing timeouts for more expensive evaluations.
 */
export const TIER_CONFIGS: Record<EvalTier, TierConfig> = {
	1: {
		tier: 1,
		name: "deterministic",
		description: "File exists, parse errors, fast checks",
		timeoutMs: 1000,
	},
	2: {
		tier: 2,
		name: "pattern",
		description: "grep, regex, structural checks",
		timeoutMs: 5000,
	},
	3: {
		tier: 3,
		name: "llm",
		description: "LLM-based evaluation",
		timeoutMs: 60000,
	},
};

/**
 * Default tier configurations (re-exported for convenience).
 */
export const DEFAULT_TIER_CONFIGS = TIER_CONFIGS;

export type { EvalResult, EvalTier, TierConfig };

/**
 * Individual evaluation check with its assigned tier.
 */
export interface EvalCheck<T = unknown> {
	/** The evaluation tier for this check */
	tier: EvalTier;
	/** The check function - returns true if passed */
	check: () => Promise<boolean> | boolean;
	/** Optional metadata about this check */
	metadata?: T;
}

/**
 * Configuration for the TieredEvalRunner.
 */
export interface TieredEvalRunnerConfig {
	/** Override default tier configurations */
	tierConfigs?: Partial<Record<EvalTier, TierConfig>>;
	/** Default timeout multiplier for all tiers (default: 1.0) */
	timeoutMultiplier?: number;
	/** Whether to sort checks by tier before execution (default: true) */
	sortByTier?: boolean;
	/** Custom error message for timeouts */
	timeoutMessage?: string;
}

/**
 * Result of a single evaluation check.
 */
export interface CheckResult extends EvalResult {
	/** The check function returned true */
	passed: boolean;
	/** Error message if check failed or timed out */
	error?: string;
	/** Check index in the original array */
	index: number;
}

/**
 * Extended result type for multi-check evaluations.
 */
export interface TieredEvalResult {
	/** Overall success status - all checks passed */
	passed: boolean;
	/** Results for each individual check */
	results: CheckResult[];
	/** Total duration of all checks in milliseconds */
	totalDurationMs: number;
	/** Tier at which evaluation failed (if any) */
	failedAtTier?: EvalTier;
	/** Index of first failing check (if any) */
	failedAtIndex?: number;
}

/**
 * TieredEvalRunner executes evaluation checks in tiered order,
 * with appropriate timeouts for each tier level.
 *
 * Supports two execution modes:
 * - runTieredEval: Runs all checks regardless of failures
 * - runTieredEvalFailFast: Stops at first failure (like ECC promotion gates)
 *
 * @example
 * ```typescript
 * const runner = new TieredEvalRunner();
 *
 * // Run all checks
 * const allResults = await runner.runTieredEval('task-1', [
 *   { tier: 1, check: () => fs.existsSync('output.json') },
 *   { tier: 2, check: async () => (await run('grep', ['pattern', 'output.json'])).exitCode === 0 }
 * ]);
 *
 * // Fail-fast mode
 * const failFastResult = await runner.runTieredEvalFailFast('task-2', [
 *   { tier: 1, check: () => fs.existsSync('output.json') },
 *   { tier: 2, check: async () => (await run('grep', ['pattern', 'output.json'])).exitCode === 0 }
 * ]);
 * ```
 */
export class TieredEvalRunner {
	private readonly tierConfigs: Record<EvalTier, TierConfig>;
	private readonly timeoutMultiplier: number;
	private readonly sortByTier: boolean;
	private readonly timeoutMessage: string;

	/**
	 * Creates a new TieredEvalRunner instance.
	 *
	 * @param config - Optional configuration to override defaults
	 */
	constructor(config?: TieredEvalRunnerConfig) {
		this.tierConfigs = { ...TIER_CONFIGS };
		this.timeoutMultiplier = config?.timeoutMultiplier ?? 1.0;
		this.sortByTier = config?.sortByTier ?? true;
		this.timeoutMessage = config?.timeoutMessage ?? "Evaluation timed out";

		// Apply tier config overrides
		if (config?.tierConfigs) {
			for (const [tierStr, tierConfig] of Object.entries(config.tierConfigs)) {
				const tier = Number(tierStr) as EvalTier;
				if (tierConfig && !Number.isNaN(tier)) {
					this.tierConfigs[tier] = {
						...this.tierConfigs[tier],
						...tierConfig,
					};
				}
			}
		}
	}

	/**
	 * Gets the effective timeout for a given tier.
	 *
	 * @param tier - The evaluation tier
	 * @returns The timeout in milliseconds (after multiplier is applied)
	 */
	getTimeout(tier: EvalTier): number {
		return this.tierConfigs[tier].timeoutMs * this.timeoutMultiplier;
	}

	/**
	 * Gets the configuration for a specific tier.
	 *
	 * @param tier - The evaluation tier
	 * @returns The tier configuration
	 */
	getTierConfig(tier: EvalTier): TierConfig {
		return this.tierConfigs[tier];
	}

	/**
	 * Runs a check with the specified timeout.
	 *
	 * @param check - The check function to run
	 * @param tier - The tier this check belongs to
	 * @returns The result of the check
	 */
	private async runCheckWithTimeout(check: () => Promise<boolean> | boolean, tier: EvalTier): Promise<CheckResult> {
		const timeout = this.getTimeout(tier);
		const startTime = Date.now();

		return new Promise<CheckResult>((resolve) => {
			const timeoutHandle = setTimeout(() => {
				resolve({
					tier,
					passed: false,
					durationMs: timeout,
					message: this.timeoutMessage,
					error: `Check timed out after ${timeout}ms`,
					index: -1,
				});
			}, timeout);

			// Execute the check
			Promise.resolve(check())
				.then((result) => {
					clearTimeout(timeoutHandle);
					const durationMs = Date.now() - startTime;
					resolve({
						tier,
						passed: result === true,
						durationMs,
						index: -1,
						error: result !== true ? "Check returned false" : undefined,
					});
				})
				.catch((error) => {
					clearTimeout(timeoutHandle);
					const durationMs = Date.now() - startTime;
					resolve({
						tier,
						passed: false,
						durationMs,
						message: error instanceof Error ? error.message : String(error),
						error: error instanceof Error ? error.message : String(error),
						index: -1,
					});
				});
		});
	}

	/**
	 * Runs all evaluation checks and returns results for each.
	 *
	 * @param taskId - Identifier for the task being evaluated
	 * @param checks - Array of checks to run, each with a tier assignment
	 * @returns Array of evaluation results for each check
	 *
	 * @example
	 * ```typescript
	 * const results = await runner.runTieredEval('task-123', [
	 *   { tier: 1, check: () => fs.existsSync('output.json') },
	 *   { tier: 2, check: async () => (await grep('output.json', 'pattern')).found },
	 *   { tier: 3, check: async () => llmJudge.evaluate(output) }
	 * ]);
	 *
	 * // Check if all passed
	 * const allPassed = results.every(r => r.passed);
	 * ```
	 */
	async runTieredEval(
		taskId: string,
		checks: Array<{
			tier: EvalTier;
			check: () => Promise<boolean> | boolean;
		}>,
	): Promise<EvalResult[]> {
		// Sort checks by tier if configured (lower tiers first)
		const sortedChecks = this.sortByTier ? [...checks].sort((a, b) => a.tier - b.tier) : checks;

		const results: EvalResult[] = [];

		for (let i = 0; i < sortedChecks.length; i++) {
			const { tier, check } = sortedChecks[i];
			const result = await this.runCheckWithTimeout(check, tier);
			results.push(result);
		}

		return results;
	}

	/**
	 * Runs evaluation checks in fail-fast mode, stopping at the first failure.
	 *
	 * This is useful for promotion gates where cheaper checks should run first
	 * and any failure should stop the evaluation immediately.
	 *
	 * @param taskId - Identifier for the task being evaluated
	 * @param checks - Array of checks to run, each with a tier assignment
	 * @returns Array of evaluation results (may be shorter than input if fail-fast triggered)
	 *
	 * @example
	 * ```typescript
	 * const results = await runner.runTieredEvalFailFast('task-123', [
	 *   { tier: 1, check: () => fs.existsSync('output.json') },
	 *   { tier: 2, check: async () => (await grep('output.json', 'pattern')).found },
	 *   { tier: 3, check: async () => llmJudge.evaluate(output) }
	 * ]);
	 *
	 * if (results.length < checks.length) {
	 *   console.log(`Failed at tier ${results[results.length - 1].tier}`);
	 * }
	 * ```
	 */
	async runTieredEvalFailFast(
		taskId: string,
		checks: Array<{
			tier: EvalTier;
			check: () => Promise<boolean> | boolean;
		}>,
	): Promise<EvalResult[]> {
		// Sort checks by tier if configured (lower tiers first)
		const sortedChecks = this.sortByTier ? [...checks].sort((a, b) => a.tier - b.tier) : checks;

		const results: EvalResult[] = [];

		for (let i = 0; i < sortedChecks.length; i++) {
			const { tier, check } = sortedChecks[i];
			const result = await this.runCheckWithTimeout(check, tier);
			results.push(result);

			// Fail-fast: stop at first failure
			if (!result.passed) {
				break;
			}
		}

		return results;
	}

	/**
	 * Runs evaluation checks and returns a structured result object.
	 *
	 * @param taskId - Identifier for the task being evaluated
	 * @param checks - Array of checks to run, each with a tier assignment
	 * @param failFast - Whether to stop at first failure (default: false)
	 * @returns Structured evaluation result with metadata
	 */
	async runEval(
		taskId: string,
		checks: Array<{
			tier: EvalTier;
			check: () => Promise<boolean> | boolean;
		}>,
		failFast = false,
	): Promise<TieredEvalResult> {
		const sortedChecks = this.sortByTier ? [...checks].sort((a, b) => a.tier - b.tier) : checks;

		const results: CheckResult[] = [];
		let totalDurationMs = 0;

		for (let i = 0; i < sortedChecks.length; i++) {
			const { tier, check } = sortedChecks[i];
			const result = await this.runCheckWithTimeout(check, tier);
			result.index = i;
			results.push(result);
			totalDurationMs += result.durationMs;

			// Fail-fast: stop at first failure
			if (failFast && !result.passed) {
				return {
					passed: false,
					results,
					totalDurationMs,
					failedAtTier: tier,
					failedAtIndex: i,
				};
			}
		}

		return {
			passed: results.every((r) => r.passed),
			results,
			totalDurationMs,
		};
	}

	/**
	 * Runs checks in parallel within each tier, but sequentially across tiers.
	 *
	 * This optimizes execution time when multiple checks exist at the same tier level.
	 *
	 * @param taskId - Identifier for the task being evaluated
	 * @param checks - Array of checks to run
	 * @param failFast - Whether to stop at first failure (default: false)
	 * @returns Structured evaluation result
	 */
	async runTieredEvalParallel(
		taskId: string,
		checks: Array<{
			tier: EvalTier;
			check: () => Promise<boolean> | boolean;
		}>,
		failFast = false,
	): Promise<TieredEvalResult> {
		// Group checks by tier
		const checksByTier = new Map<
			EvalTier,
			Array<{
				check: () => Promise<boolean> | boolean;
				originalIndex: number;
			}>
		>();

		checks.forEach((c, originalIndex) => {
			const existing = checksByTier.get(c.tier) || [];
			existing.push({ check: c.check, originalIndex });
			checksByTier.set(c.tier, existing);
		});

		// Execute tiers in order
		const results: CheckResult[] = [];
		let totalDurationMs = 0;

		for (const tier of [1, 2, 3] as EvalTier[]) {
			const tierChecks = checksByTier.get(tier);
			if (!tierChecks || tierChecks.length === 0) continue;

			// Run all checks for this tier in parallel
			const tierResults = await Promise.all(
				tierChecks.map(async ({ check, originalIndex }) => {
					const result = await this.runCheckWithTimeout(check, tier);
					result.index = originalIndex;
					return result;
				}),
			);

			tierResults.forEach((result) => {
				results.push(result);
				totalDurationMs += result.durationMs;
			});

			// Check for any failures in this tier
			const tierFailed = tierResults.some((r) => !r.passed);
			if (failFast && tierFailed) {
				const failedIndex = tierResults.findIndex((r) => !r.passed);
				return {
					passed: false,
					results,
					totalDurationMs,
					failedAtTier: tier,
					failedAtIndex: tierResults[failedIndex].index,
				};
			}
		}

		// Sort results by original index
		results.sort((a, b) => a.index - b.index);

		return {
			passed: results.every((r) => r.passed),
			results,
			totalDurationMs,
		};
	}

	/**
	 * Creates a new runner with overridden tier configurations.
	 *
	 * @param overrides - Tier configurations to override
	 * @returns A new TieredEvalRunner instance
	 */
	withConfig(overrides: Partial<Record<EvalTier, TierConfig>>): TieredEvalRunner {
		return new TieredEvalRunner({
			tierConfigs: overrides,
			timeoutMultiplier: this.timeoutMultiplier,
			sortByTier: this.sortByTier,
			timeoutMessage: this.timeoutMessage,
		});
	}
}

/**
 * Convenience function to create a TieredEvalRunner with default configuration.
 *
 * @param config - Optional configuration overrides
 * @returns A new TieredEvalRunner instance
 *
 * @example
 * ```typescript
 * const runner = createRunner({
 *   timeoutMultiplier: 2.0,  // Double all timeouts
 *   tierConfigs: {
 *     3: { timeoutMs: 120000 }  // 2 minutes for LLM tier
 *   }
 * });
 * ```
 */
export function createRunner(config?: TieredEvalRunnerConfig): TieredEvalRunner {
	return new TieredEvalRunner(config);
}

/**
 * Default runner instance with standard configuration.
 */
export const defaultRunner = new TieredEvalRunner();
