/**
 * b6 — usage/token tracking overhead benchmark.
 *
 * Measures the in-process cost of the usage aggregation layer
 * (src/state/usage.ts) over synthetic task arrays:
 *   - aggregateUsage (total token/cost rollup)
 *   - aggregateUsageByRole (per-role cost attribution)
 *   - formatCostReport (full multi-line cost report)
 *
 * Sizes: 1k, 10k, 100k task-shaped objects. Pure in-process, no I/O.
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b6-usage-tracking.bench.ts
 */

import { performance } from "node:perf_hooks";
import type { TeamTaskState } from "../src/state/types.ts";
import { aggregateUsage, aggregateUsageByRole, formatCostReport } from "../src/state/usage.ts";

const ROLES = ["planner", "writer", "reviewer", "verifier", "explorer", "test-engineer"];

function makeTask(i: number): TeamTaskState {
	return {
		id: `task-${i}`,
		runId: "b6-run",
		role: ROLES[i % ROLES.length],
		agent: "worker",
		title: `task ${i}`,
		status: "completed",
		dependsOn: [],
		cwd: "/tmp",
		usage: {
			input: 1000 + (i % 97) * 13,
			output: 200 + (i % 53) * 7,
			cacheRead: 500 + (i % 31) * 5,
			cacheWrite: 100 + (i % 11) * 3,
			cost: 0.001 + (i % 17) * 0.0002,
			turns: 1 + (i % 5),
		},
	};
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function bench(count: number): Record<string, unknown> {
	const tasks = Array.from({ length: count }, (_, i) => makeTask(i));

	const t0 = performance.now();
	const total = aggregateUsage(tasks);
	const t1 = performance.now();

	const t2 = performance.now();
	const byRole = aggregateUsageByRole(tasks);
	const t3 = performance.now();

	const t4 = performance.now();
	const report = formatCostReport(tasks);
	const t5 = performance.now();

	return {
		taskCount: count,
		aggregateMs: round(t1 - t0),
		aggregateByRoleMs: round(t3 - t2),
		formatReportMs: round(t5 - t4),
		totalMs: round(t5 - t0),
		rolesCount: byRole.length,
		reportChars: report.length,
		aggregatedTokens: (total?.input ?? 0) + (total?.output ?? 0),
		tokensPerMs: round(((total?.input ?? 0) + (total?.output ?? 0)) / Math.max(0.001, t5 - t0)),
	};
}

function main(): void {
	const rssBefore = process.memoryUsage().rss;
	const cases: Record<string, unknown> = {};
	for (const count of [1000, 10000, 100000]) {
		const res = bench(count);
		cases[`n${count}`] = res;
		console.log(
			`b6 n=${count}: aggregate=${res.aggregateMs}ms byRole=${res.aggregateByRoleMs}ms report=${res.formatReportMs}ms total=${res.totalMs}ms tok/ms=${res.tokensPerMs}`,
		);
	}

	const result = {
		name: "b6.usage-tracking",
		unit: "ms",
		sizes: [1000, 10000, 100000],
		cases,
		rssDeltaBytes: process.memoryUsage().rss - rssBefore,
	};
	console.log(JSON.stringify(result));
}

main();
