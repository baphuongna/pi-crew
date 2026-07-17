/**
 * RetryRunner - Execute tasks with retry support and summary accumulation.
 *
 * Based on pi-boomerang's --rethrow pattern:
 * - Retries failed tasks up to maxAttempts
 * - Generates handoffs between attempts
 * - Accumulates context from previous attempts
 * - Supports exponential backoff
 * - Limits handoff accumulation to prevent memory leaks
 *
 * @see docs/pi-boomerang-integration-plan.md
 */

import type { HandoffManager, HandoffSummary, TaskPacket, TaskResult } from "./handoff-manager.ts";

/**
 * Retry configuration.
 */
export interface RetryConfig {
	/** Maximum number of retry attempts */
	maxAttempts: number;
	/** Generate summary between attempts for context accumulation */
	summaryBetweenAttempts?: boolean;
	/** Stop retrying if task succeeds */
	stopOnSuccess?: boolean;
	/** Base backoff delay in milliseconds (multiplied by attempt number) */
	backoffMs?: number;
	/** Backoff multiplier (default: 1) */
	backoffMultiplier?: number;
	/** Maximum backoff delay cap in milliseconds */
	maxBackoffMs?: number;
	/** Custom retry condition (return true to retry) */
	retryCondition?: (result: TaskResult, attempt: number) => boolean;
	/** Maximum handoffs to retain (default: 100) - prevents memory leaks */
	maxHandoffs?: number;
}

/**
 * Result of a single attempt.
 */
export interface AttemptResult {
	attempt: number;
	result: TaskResult;
	summary?: HandoffSummary;
	duration: number;
	error?: string;
	timestamp: number;
}

/**
 * Final retry result.
 */
export interface RetryResult {
	success: boolean;
	attempts: AttemptResult[];
	finalResult?: TaskResult;
	totalHandoffs: HandoffSummary[];
	totalDuration: number;
}

/**
 * Task runner interface (minimal for retry functionality).
 */
export interface TaskRunnerLike {
	runTask(packet: TaskPacket): Promise<TaskResult>;
}

/**
 * RetryRunner handles task execution with automatic retry and summary accumulation.
 */
export class RetryRunner {
	private _disposed = false;

	private taskRunner: TaskRunnerLike;
	private handoffManager: HandoffManager;
	private _handoffs: HandoffSummary[] = [];

	constructor(taskRunner: TaskRunnerLike, handoffManager: HandoffManager) {
		this.taskRunner = taskRunner;
		this.handoffManager = handoffManager;
	}

	/**
	 * Check if this runner has been disposed.
	 */
	get isDisposed(): boolean {
		return this._disposed;
	}

	/**
	 * Dispose of resources held by this runner.
	 * Clears any accumulated state and prevents further operations.
	 */
	dispose(): void {
		this._disposed = true;
	}

	/**
	 * Clear accumulated handoffs to free memory.
	 * Useful when you want to reset state without disposing.
	 */
	clearHandoffs(): void {
		this._handoffs = [];
	}

	/**
	 * Get the effective max handoffs limit from config or default.
	 */
	private getMaxHandoffs(config: RetryConfig): number {
		return config.maxHandoffs ?? 100;
	}

	/**
	 * Trim handoffs array to max size, keeping most recent.
	 */
	private trimHandoffs(handoffs: HandoffSummary[], maxSize: number): HandoffSummary[] {
		if (handoffs.length <= maxSize) {
			return handoffs;
		}
		// Keep the most recent handoffs (last maxSize items)
		return handoffs.slice(-maxSize);
	}

	/**
	 * Execute task with retry support.
	 * Summaries accumulate between attempts for better context.
	 *
	 * @param packet - Task packet to execute
	 * @param config - Retry configuration (stopOnSuccess defaults to true)
	 * @returns Final retry result with all attempts
	 */
	async runWithRetry(packet: TaskPacket, config: RetryConfig): Promise<RetryResult> {
		if (this._disposed) {
			throw new Error("RetryRunner has been disposed");
		}

		const attempts: AttemptResult[] = [];
		const handoffs: HandoffSummary[] = [];
		const startTime = Date.now();
		const maxHandoffs = this.getMaxHandoffs(config);

		// Clear previous handoffs at start of each retry run
		this._handoffs = [];

		for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
			if (this._disposed) {
				throw new Error("RetryRunner was disposed during retry");
			}
			const attemptStart = Date.now();

			try {
				// Inject accumulated handoffs into context
				const enrichedPacket = this.enrichPacketWithHandoffs(packet, handoffs, attempt);

				// Execute task
				const result = await this.taskRunner.runTask(enrichedPacket);

				const attemptResult: AttemptResult = {
					attempt,
					result,
					duration: Date.now() - attemptStart,
					timestamp: Date.now(),
				};

				// Generate summary between attempts
				if (config.summaryBetweenAttempts !== false) {
					const summary = await this.handoffManager.generateSummary(packet, result);
					attemptResult.summary = summary;
					handoffs.push(summary);

					// Trim handoffs to prevent memory leak
					if (handoffs.length > maxHandoffs) {
						handoffs.splice(0, handoffs.length - maxHandoffs);
					}
				}

				attempts.push(attemptResult);

				// Stop on success if configured (default to true when undefined)
				if ((config.stopOnSuccess ?? true) && result.outcome === "success") {
					return {
						success: true,
						attempts,
						finalResult: result,
						totalHandoffs: handoffs,
						totalDuration: Date.now() - startTime,
					};
				}

				// Check custom retry condition
				if (config.retryCondition && !config.retryCondition(result, attempt)) {
					break;
				}

				// Check default retry condition (retry on failure)
				if (result.outcome !== "success" && attempt < config.maxAttempts) {
					// Apply backoff before retry
					const backoffDelay = this.calculateBackoff(
						config.backoffMs ?? 1000,
						attempt,
						config.backoffMultiplier ?? 1,
						config.maxBackoffMs,
					);
					if (backoffDelay > 0) {
						await this.sleep(backoffDelay);
					}
				}
			} catch (error) {
				attempts.push({
					attempt,
					result: {
						outcome: "failure",
						error: error instanceof Error ? error.message : String(error),
					},
					duration: Date.now() - attemptStart,
					timestamp: Date.now(),
					error: error instanceof Error ? error.message : String(error),
				});

				// Apply backoff before retry on error
				if (config.backoffMs && attempt < config.maxAttempts) {
					const backoffDelay = this.calculateBackoff(
						config.backoffMs,
						attempt,
						config.backoffMultiplier ?? 1,
						config.maxBackoffMs,
					);
					if (backoffDelay > 0) {
						await this.sleep(backoffDelay);
					}
				}
			}
		}

		const finalAttempt = attempts[attempts.length - 1];
		return {
			success: finalAttempt?.result.outcome === "success",
			attempts,
			finalResult: finalAttempt?.result,
			totalHandoffs: this.trimHandoffs(handoffs, maxHandoffs),
			totalDuration: Date.now() - startTime,
		};
	}

	/**
	 * Enrich packet with accumulated handoffs from previous attempts.
	 */
	private enrichPacketWithHandoffs(packet: TaskPacket, handoffs: HandoffSummary[], attempt: number): TaskPacket {
		if (handoffs.length === 0) {
			return packet;
		}

		// Build accumulated context from previous attempts
		const accumulatedContext = handoffs
			.map(
				(h, index) =>
					`## Attempt ${index + 1}: ${h.task}\n` +
					`Outcome: ${h.outcome}\n` +
					`Files: created=${h.filesCreated.join(", ")}, modified=${h.filesModified.join(", ")}\n` +
					`Decisions: ${h.decisions.map((d) => d.rationale).join("; ")}\n` +
					`Blockers: ${h.blockers.join(", ")}\n` +
					`Next Steps: ${h.nextSteps.join(", ")}\n`,
			)
			.join("\n---\n");

		return {
			...packet,
			context: {
				...packet.context,
				__boomerangAttempts: attempt,
				__boomerangHandoffs: handoffs,
				__boomerangContext: `Previous attempts summary:\n${accumulatedContext}`,
			},
		};
	}

	/**
	 * Calculate backoff delay with optional capping.
	 */
	private calculateBackoff(baseMs: number, attempt: number, multiplier: number, maxBackoffMs?: number): number {
		let delay = baseMs * multiplier ** (attempt - 1);
		if (maxBackoffMs !== undefined) {
			delay = Math.min(delay, maxBackoffMs);
		}
		return delay;
	}

	/**
	 * Sleep helper.
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Create a RetryRunner with default dependencies.
 */
export function createRetryRunner(taskRunner: TaskRunnerLike, handoffManager: HandoffManager): RetryRunner {
	return new RetryRunner(taskRunner, handoffManager);
}

/**
 * Default retry config for common scenarios.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 3,
	summaryBetweenAttempts: true,
	stopOnSuccess: true,
	backoffMs: 1000,
	backoffMultiplier: 2,
	maxBackoffMs: 30000,
};

/**
 * Retry config for transient failures (quick retries).
 */
export const TRANSIENT_FAILURE_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 2,
	summaryBetweenAttempts: false,
	stopOnSuccess: true,
	backoffMs: 500,
	backoffMultiplier: 1,
};

/**
 * Retry config for persistent failures (exponential backoff).
 */
export const PERSISTENT_FAILURE_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 5,
	summaryBetweenAttempts: true,
	stopOnSuccess: true,
	backoffMs: 2000,
	backoffMultiplier: 2,
	maxBackoffMs: 60000,
};
