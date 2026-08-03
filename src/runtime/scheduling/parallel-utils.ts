export interface RunnerSubagentStep {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	modelCandidates?: string[];
	tools?: string[];
	extensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string | null;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	outputPath?: string;
	sessionFile?: string;
	maxSubagentDepth?: number;
}

export interface ParallelStepGroup {
	parallel: RunnerSubagentStep[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup;

export function isParallelGroup(step: RunnerStep): step is ParallelStepGroup {
	return "parallel" in step && Array.isArray(step.parallel);
}

export function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[] {
	const flat: RunnerSubagentStep[] = [];
	for (const step of steps) {
		if (isParallelGroup(step)) {
			for (const task of step.parallel) flat.push(task);
		} else {
			flat.push(step);
		}
	}
	return flat;
}

export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	// P12 (perf): single-item fast path. Skip the Promise.all + worker-pool
	// setup when there's exactly one item — just call fn directly. Same return
	// shape, no concurrency overhead, no micro-task allocation.
	if (items.length === 1) return [await fn(items[0], 0)];
	if (items.length === 0) return [];
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: R[] = new Array(items.length);
	let next = 0;

	const worker = async (_workerIndex: number): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	};

	await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, (_, workerIndex) => worker(workerIndex)));
	return results;
}

/**
 * Phase 6: mapConcurrent with AbortSignal and fail-fast support.
 * On abort: returns partial results (may contain undefined entries).
 * On error: throws immediately (fail-fast) and cancels remaining work.
 */
/** @internal */
async function mapConcurrentWithSignal<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number, signal: AbortSignal) => Promise<R>,
	signal?: AbortSignal,
): Promise<{ results: (R | undefined)[]; aborted: boolean }> {
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: (R | undefined)[] = new Array(items.length);
	let next = 0;
	let aborted = false;

	const abortController = new AbortController();
	const workerSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	let rejectFirst: (error: unknown) => void;
	const firstErrorPromise = new Promise<never>((_, reject) => {
		rejectFirst = reject;
	});

	const worker = async (): Promise<void> => {
		while (!workerSignal.aborted) {
			const i = next++;
			if (i >= items.length) return;
			try {
				results[i] = await fn(items[i], i, workerSignal);
			} catch (error) {
				if (!workerSignal.aborted) {
					abortController.abort();
					rejectFirst(error);
					throw error;
				}
			}
		}
	};

	const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => worker());

	try {
		await Promise.race([Promise.all(workers), firstErrorPromise]);
	} catch (error) {
		if (signal?.aborted) {
			aborted = true;
			return { results, aborted };
		}
		throw error;
	}

	return { results, aborted: signal?.aborted ?? false };
}

export interface ParallelTaskResult {
	agent: string;
	taskIndex?: number;
	output: string;
	exitCode: number | null;
	error?: string;
	model?: string;
	attemptedModels?: string[];
	outputTargetPath?: string;
	outputTargetExists?: boolean;
}

export function aggregateParallelOutputs(
	results: ParallelTaskResult[],
	headerFormat: (index: number, agent: string) => string = (i, agent) => `=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
	return results
		.map((r, i) => {
			const header = headerFormat(r.taskIndex ?? i, r.agent);
			const hasOutput = Boolean(r.output?.trim());
			const status =
				r.exitCode === -1
					? "SKIPPED"
					: r.exitCode == null || r.exitCode !== 0
						? `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
						: r.error
							? `WARNING: ${r.error}`
							: !hasOutput && r.outputTargetPath && r.outputTargetExists === false
								? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
								: !hasOutput && !r.outputTargetPath
									? "EMPTY OUTPUT (no textual response returned)"
									: "";
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

export const MAX_PARALLEL_CONCURRENCY = 4;
