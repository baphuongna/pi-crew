import { DEFAULT_CONCURRENCY } from "../config/defaults.ts";
import { getWorkerCapCapacity } from "./global-worker-cap.ts";

export interface ResolveBatchConcurrencyInput {
	workflowName: string;
	workflowMaxConcurrency?: number;
	teamMaxConcurrency?: number;
	limitMaxConcurrentWorkers?: number;
	allowUnboundedConcurrency?: boolean;
	hardCap?: number;
	/** Optional override for the global worker cap (test determinism). Defaults to getWorkerCapCapacity(). */
	workerCap?: number;
	readyCount: number;
	workspaceMode?: "single" | "worktree";
	readyRoles?: string[];
}

export interface BatchConcurrencyDecision {
	maxConcurrent: number;
	selectedCount: number;
	defaultConcurrency: number;
	reason: string;
}

export function defaultWorkflowConcurrency(workflowName: string, workflowMaxConcurrency?: number): number {
	if (workflowMaxConcurrency !== undefined) return workflowMaxConcurrency;
	if (workflowName === "parallel-research") return DEFAULT_CONCURRENCY.workflow.parallelResearch;
	if (workflowName === "research") return DEFAULT_CONCURRENCY.workflow.research;
	if (workflowName === "implementation") return DEFAULT_CONCURRENCY.workflow.implementation;
	if (workflowName === "review") return DEFAULT_CONCURRENCY.workflow.review;
	if (workflowName === "default") return DEFAULT_CONCURRENCY.workflow.default;
	return DEFAULT_CONCURRENCY.fallback;
}

function positiveInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(1, Math.trunc(value));
}

export function resolveBatchConcurrency(input: ResolveBatchConcurrencyInput): BatchConcurrencyDecision {
	const workflowMax = positiveInteger(input.workflowMaxConcurrency);
	const defaultConcurrency = defaultWorkflowConcurrency(input.workflowName, workflowMax);
	const limitMax = positiveInteger(input.limitMaxConcurrentWorkers);
	const teamMax = positiveInteger(input.teamMaxConcurrency);
	const requested = limitMax ?? teamMax ?? workflowMax ?? defaultWorkflowConcurrency(input.workflowName);
	let source: "limit" | "team" | "workflow";
	if (limitMax !== undefined) source = "limit";
	else if (teamMax !== undefined) source = "team";
	else source = "workflow";
	const hardCap = positiveInteger(input.hardCap) ?? DEFAULT_CONCURRENCY.hardCap;
	// P1-7: consult the global worker cap so the scheduler doesn't over-dispatch
	// (e.g. dispatch 4 while the global semaphore holds 2 on a 4-core machine).
	const workerCap = positiveInteger(input.workerCap) ?? getWorkerCapCapacity();
	const maxConcurrent = input.allowUnboundedConcurrency ? requested : Math.min(requested, hardCap, workerCap);
	const readyCount = Math.max(0, Math.trunc(Number.isFinite(input.readyCount) ? input.readyCount : 0));
	const cappedReason = maxConcurrent < requested ? `;capped:hard=${hardCap},worker=${workerCap}` : "";
	const unboundedReason = input.allowUnboundedConcurrency && requested > hardCap ? `;unbounded:${hardCap}` : "";
	return {
		maxConcurrent,
		selectedCount: readyCount === 0 ? 0 : Math.min(readyCount, maxConcurrent),
		defaultConcurrency,
		reason: `${source}:${requested}${cappedReason}${unboundedReason};ready:${readyCount}`,
	};
}
