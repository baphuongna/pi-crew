import { logInternalError } from "../../utils/internal-error.ts";
import { sleep } from "../../utils/sleep.ts";
import { throwIfCancelled } from "../process/cancellation.ts";

export interface RetryPolicy {
	maxAttempts: number;
	backoffMs: number;
	jitterRatio: number;
	exponentialFactor: number;
	retryableErrors?: string[];
	/**
	 * CORE-3 — per-task spawn budget cap. Maximum total worker spawns
	 * (runWorker/runChildPi calls) allowed across ALL retry attempts × model
	 * fallback iterations for a single task. When omitted or 0, the budget
	 * auto-computes as `attemptModels.length × (maxAttempts + 1)` in
	 * task-runner.ts (always ≥ 1 full attempt above the theoretical max).
	 * Set explicitly to override the auto-computed value.
	 */
	maxTotalSpawns?: number;
}

export interface RetryAttemptInfo {
	attempt: number;
	attemptId: string;
}

export interface RetryHooks {
	onAttemptFailed?: (attempt: number, error: Error, nextDelayMs: number, info: RetryAttemptInfo) => void;
	onRetryGivenUp?: (attempts: number, error: Error, info: RetryAttemptInfo) => void;
	attemptId?: (attempt: number) => string;
	signal?: AbortSignal;
	/**
	 * U6A (upgrade spec 2026-10-09 §U6 Phase A): async pre-gate consulted
	 * after a failed attempt and BEFORE the next one is queued. Returning
	 * false gives up exactly like non-retryable exhaustion (onRetryGivenUp +
	 * throw of the ORIGINAL error — the gate itself can never introduce a new
	 * failure). SOFT contract: a throwing/rejecting hook is swallowed and
	 * treated as "retry" — a broken gate must never change retry behavior.
	 * Consumer: dispatch-batch's ambient-noise classifier gate
	 * (classifyAmbientNoiseGate), dormant unless runtime.classifierEnabled.
	 */
	shouldRetry?: (attempt: number, error: Error, info: RetryAttemptInfo) => boolean | Promise<boolean>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	backoffMs: 1000,
	jitterRatio: 0.3,
	exponentialFactor: 2,
};

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function globToRegex(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function isRetryable(error: Error, policy: RetryPolicy): boolean {
	const patterns = policy.retryableErrors ?? [];
	if (!patterns.length) return true;
	return patterns.some((pattern) => globToRegex(pattern).test(error.message));
}

export function calculateRetryDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, random = Math.random): number {
	const base = policy.backoffMs * policy.exponentialFactor ** Math.max(0, attempt - 1);
	const jitter = (random() * 2 - 1) * policy.jitterRatio * base;
	return Math.max(0, base + jitter);
}

function retryAttemptInfo(attempt: number, hooks: RetryHooks): RetryAttemptInfo {
	return {
		attempt,
		attemptId: hooks.attemptId?.(attempt) ?? `retry_attempt_${attempt}`,
	};
}

export async function executeWithRetry<T>(
	fn: (attempt: number, info: RetryAttemptInfo) => Promise<T>,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
	hooks: RetryHooks = {},
): Promise<T> {
	const normalized: RetryPolicy = {
		...DEFAULT_RETRY_POLICY,
		...policy,
		maxAttempts: Math.max(1, policy.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts),
	};
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= normalized.maxAttempts; attempt += 1) {
		throwIfCancelled(hooks.signal);
		const info = retryAttemptInfo(attempt, hooks);
		try {
			return await fn(attempt, info);
		} catch (error) {
			lastError = asError(error);
			// Never retry if aborted — sleep() would immediately reject on every attempt.
			if (hooks.signal?.aborted) {
				hooks.onRetryGivenUp?.(attempt, lastError, info);
				throw lastError;
			}
			if (attempt >= normalized.maxAttempts || !isRetryable(lastError, normalized)) {
				hooks.onRetryGivenUp?.(attempt, lastError, info);
				throw lastError;
			}
			// U6A: ambient-noise pre-gate — consulted once per failed attempt,
			// after retryability, BEFORE the backoff sleep + next spawn. SOFT:
			// hook errors are logged and treated as "retry" (fallback true), so
			// the gate can only skip a queued retry, never break the loop.
			if (hooks.shouldRetry) {
				let gateDecision = true;
				try {
					gateDecision = await hooks.shouldRetry(attempt, lastError, info);
				} catch (gateError) {
					logInternalError("retry-executor.shouldRetry", gateError, "soft-fail: proceeding with the queued retry", "warn");
					gateDecision = true;
				}
				if (gateDecision === false) {
					hooks.onRetryGivenUp?.(attempt, lastError, info);
					throw lastError;
				}
			}
			const delay = calculateRetryDelay(attempt, normalized);
			hooks.onAttemptFailed?.(attempt, lastError, delay, info);
			try {
				await sleep(delay, hooks.signal);
			} catch (sleepError) {
				if (hooks.signal?.aborted) throwIfCancelled(hooks.signal);
				throw sleepError;
			}
		}
	}
	throw lastError ?? new Error("Retry failed without error.");
}
