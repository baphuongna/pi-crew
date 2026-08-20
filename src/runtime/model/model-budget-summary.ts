/**
 * model-budget-summary.ts — R8 model-routing transparency (WP-8, T5).
 *
 * One pre-run summary line: the resolved fallback chain + the WORST-CASE
 * spawn budget per task (`attemptModels × (maxAttempts + 1)` — the RT-6
 * formula; always ≥ 1 full attempt above the theoretical max). Cost
 * surprises in multi-model fallback runs were invisible until workers
 * started burning through attempts; this makes the ceiling loud UP FRONT.
 */

import { loadConfig } from "../../config/config.ts";
import { DEFAULT_RETRY_POLICY } from "../recovery/retry-executor.ts";
import { computeSpawnBudgetMax } from "../task-runner/child-executor.ts";
import { buildConfiguredModelRouting } from "./model-fallback.ts";

export interface ModelBudgetSummary {
	/** Deduped resolved chain (requested first, then fallbacks). */
	chain: string[];
	/** Worst-case child spawns per task: chain.length × (maxAttempts + 1). */
	worstCaseSpawnsPerTask: number;
	/** Configured maxAttempts (or the default when unset/unreadable). */
	maxAttempts: number;
	/** Rendered single-line summary for console output. */
	line: string;
}

/** Compute the pre-run model budget summary. Never throws — degrades to an
 *  empty chain + default attempts on any config/catalog read failure. */
export function summarizeModelBudget(cwd: string): ModelBudgetSummary {
	let maxAttempts = DEFAULT_RETRY_POLICY.maxAttempts;
	let chain: string[] = [];
	try {
		const { config } = loadConfig(cwd);
		// The same routing pipeline tasks use (config catalog + auto tail policy):
		// the summary must describe what would ACTUALLY spawn, not a parallel
		// reconstruction of it.
		const routing = buildConfiguredModelRouting({ cwd, policy: config.runtime?.modelFallback });
		chain = routing.candidates;
		if (config.reliability?.retryPolicy?.maxAttempts !== undefined) {
			maxAttempts = config.reliability.retryPolicy.maxAttempts;
		}
	} catch {
		/* degrade: defaults below */
	}
	const worst = computeSpawnBudgetMax(Math.max(1, chain.length), maxAttempts);
	const chainText = chain.length ? chain.join(" → ") : "(default pi model)";
	return {
		chain,
		worstCaseSpawnsPerTask: worst,
		maxAttempts,
		line: `[team-tool.run] model routing: ${chainText} · worst-case ${worst} spawns/task (chain=${Math.max(1, chain.length)} × maxAttempts+1=${maxAttempts + 1})`,
	};
}
