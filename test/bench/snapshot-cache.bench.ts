/**
 * Bench: RunSnapshotCache.refresh() over a synthetic run with N tasks/events.
 *
 * Creates a temp project, scaffolds 1 run with 10 tasks, 200 events, then
 * measures cold/warm refresh latency.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { appendEvent } from "../../src/state/event-log/event-log.ts";
import { createRunManifest, saveRunTasks } from "../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import { createRunSnapshotCache } from "../../src/ui/run-snapshot-cache.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const ITERS = Number(process.env.BENCH_ITERS ?? 50);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-bench-snap-"));
try {
	// Mark as a project root so projectCrewRoot() returns <tmpRoot>/.crew
	fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}\n", "utf-8");
	fs.mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });

	const team: TeamConfig = {
		name: "default",
		description: "bench",
		source: "builtin",
		filePath: "<bench>",
		roles: [{ name: "executor", agent: "executor" }],
		defaultWorkflow: "default",
		workspaceMode: "single",
	};
	const workflow: WorkflowConfig = {
		name: "default",
		description: "bench workflow",
		source: "builtin",
		filePath: "<bench>",
		steps: Array.from({ length: 10 }, (_v, i) => ({
			id: `step-${i}`,
			role: "executor",
			task: `task ${i}`,
			dependsOn: i === 0 ? [] : [`step-${i - 1}`],
		})),
	};

	const { manifest, tasks } = createRunManifest({
		cwd: tmpRoot,
		team,
		workflow,
		goal: "bench",
	});
	const updatedTasks: TeamTaskState[] = tasks.map((t, idx) => ({
		...t,
		status: idx < 4 ? "completed" : idx < 6 ? "running" : "queued",
	}));
	saveRunTasks(manifest, updatedTasks);
	for (let j = 0; j < 200; j++) {
		appendEvent(manifest.eventsPath, {
			type: "task.progress",
			runId: manifest.runId,
			taskId: updatedTasks[j % updatedTasks.length].id,
			data: { i: j },
		});
	}

	const cache = createRunSnapshotCache(tmpRoot, { ttlMs: 0 });

	// Warm-up
	for (let i = 0; i < 3; i++) cache.refresh(manifest.runId);

	const cold: number[] = [];
	const warm: number[] = [];
	for (let i = 0; i < ITERS; i++) {
		cache.invalidate(manifest.runId);
		const t0 = performance.now();
		cache.refresh(manifest.runId);
		cold.push(performance.now() - t0);

		const t1 = performance.now();
		cache.refresh(manifest.runId);
		warm.push(performance.now() - t1);
	}
	cold.sort((a, b) => a - b);
	warm.sort((a, b) => a - b);

	const out = {
		name: "snapshot-cache",
		unit: "ms",
		iters: ITERS,
		tasks: updatedTasks.length,
		events: 200,
		cold: stats(cold),
		warm: stats(warm),
	};
	process.stdout.write(JSON.stringify(out) + "\n");
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function stats(samples: number[]) {
	return {
		min: round(samples[0]),
		p50: round(percentile(samples, 0.5)),
		p95: round(percentile(samples, 0.95)),
		p99: round(percentile(samples, 0.99)),
		max: round(samples[samples.length - 1]),
	};
}
function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
	return sorted[idx];
}
function round(n: number): number {
	return Math.round(n * 100) / 100;
}
