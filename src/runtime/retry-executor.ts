import { sleep } from "../utils/sleep.ts";

export interface RetryPolicy {
	maxAttempts: number;
	backoffMs: number;
	jitterRatio: number;
	exponentialFactor: number;
	retryableErrors?: string[];
}

export interface RetryHooks {
	onAttemptFailed?: (attempt: number, error: Error, nextDelayMs: number) => void;
	onRetryGivenUp?: (attempts: number, error: Error) => void;
	signal?: AbortSignal;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, backoffMs: 1000, jitterRatio: 0.3, exponentialFactor: 2 };

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

function isRetryable(error: Error, policy: RetryPolicy): boolean {
	const patterns = policy.retryableErrors ?? [];
	if (!patterns.length) return true;
	return patterns.some((pattern) => globToRegex(pattern).test(error.message));
}

export function calculateRetryDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, random = Math.random): number {
	const base = policy.backoffMs * Math.pow(policy.exponentialFactor, Math.max(0, attempt - 1));
	const jitter = (random() * 2 - 1) * policy.jitterRatio * base;
	return Math.max(0, base + jitter);
}

export async function executeWithRetry<T>(fn: (attempt: number) => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY_POLICY, hooks: RetryHooks = {}): Promise<T> {
	const normalized: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy, maxAttempts: Math.max(1, policy.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts) };
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= normalized.maxAttempts; attempt += 1) {
		if (hooks.signal?.aborted) throw new Error("Retry aborted.");
		try {
			return await fn(attempt);
		} catch (error) {
			lastError = asError(error);
			if (attempt >= normalized.maxAttempts || !isRetryable(lastError, normalized)) {
				hooks.onRetryGivenUp?.(attempt, lastError);
				throw lastError;
			}
			const delay = calculateRetryDelay(attempt, normalized);
			hooks.onAttemptFailed?.(attempt, lastError, delay);
			await sleep(delay, hooks.signal);
		}
	}
	throw lastError ?? new Error("Retry failed without error.");
}
