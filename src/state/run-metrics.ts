import * as fs from "node:fs";
import * as path from "node:path";
import { projectCrewRoot } from "../utils/paths.ts";
import { assertSafePathId } from "../utils/safe-paths.ts";
import { atomicWriteJson, readJsonFile } from "./atomic-write.ts";
import { loadRunManifestById } from "./state-store.ts";

/**
 * Run metrics snapshot captured after a run completes (or on demand).
 */
export interface RunMetrics {
	runId: string;
	timestamp: string;
	taskCount: number;
	completedCount: number;
	failedCount: number;
	totalTokens: number;
	totalCost: number;
	durationMs: number;
	consistencyScore: number;
}

/** Number of recent metric files to scan when building a summary. */
const MAX_METRIC_FILES_TO_SCAN = 500;

function metricsDir(cwd: string): string {
	const repoRoot = projectCrewRoot(cwd);
	return path.join(repoRoot, "state", "metrics");
}

function metricsFilePath(cwd: string, runId: string): string {
	assertSafePathId("runId", runId);
	return path.join(metricsDir(cwd), `${runId}.json`);
}

/**
 * Collect metrics for a run by reading its manifest, tasks, and event log.
 * Returns undefined if the run cannot be loaded.
 */
export function collectRunMetrics(cwd: string, runId: string): RunMetrics | undefined {
	assertSafePathId("runId", runId);
	const result = loadRunManifestById(cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
	if (!result) return undefined;

	const { manifest, tasks } = result;
	const now = new Date().toISOString();

	// Aggregate token/cost from all tasks that have usage data.
	let totalTokens = 0;
	let totalCost = 0;
	for (const task of tasks) {
		if (task.usage) {
			totalTokens += (task.usage.input ?? 0) + (task.usage.output ?? 0);
			totalCost += task.usage.cost ?? 0;
		}
	}

	// Count completed vs failed tasks.
	let completedCount = 0;
	let failedCount = 0;
	for (const task of tasks) {
		if (task.status === "completed") completedCount++;
		else if (task.status === "failed") failedCount++;
	}

	// Duration: from run createdAt to updatedAt (manifest timestamps), or 0 if unavailable.
	const createdAt = new Date(manifest.createdAt).getTime();
	const updatedAt = new Date(manifest.updatedAt).getTime();
	const durationMs = Number.isNaN(createdAt) || Number.isNaN(updatedAt) ? 0 : Math.max(0, updatedAt - createdAt);

	// Consistency score: proportion of tasks that completed successfully among all non-skipped tasks.
	const nonSkippedTasks = tasks.filter((t) => t.status !== "skipped");
	const consistencyScore = nonSkippedTasks.length > 0 ? completedCount / nonSkippedTasks.length : 1.0;

	return {
		runId,
		timestamp: now,
		taskCount: tasks.length,
		completedCount,
		failedCount,
		totalTokens,
		totalCost,
		durationMs,
		consistencyScore: Math.round(consistencyScore * 1000) / 1000, // 3 decimal places
	};
}

/**
 * Persist a metrics snapshot to .crew/state/metrics/<runId>.json.
 * Uses atomicWriteJson to ensure safe writes.
 */
export function saveRunMetrics(cwd: string, metrics: RunMetrics): void {
	const dir = metricsDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	atomicWriteJson(metricsFilePath(cwd, metrics.runId), metrics);
}

/**
 * Load a previously saved metrics snapshot.
 * Returns undefined if the file does not exist or cannot be parsed.
 */
export function loadRunMetrics(cwd: string, runId: string): RunMetrics | undefined {
	return readJsonFile<RunMetrics>(metricsFilePath(cwd, runId));
}

/**
 * List recent metrics files up to `limit` entries (newest first).
 * Returns an array of { runId, timestamp, taskCount, completedCount, failedCount, totalTokens, totalCost, durationMs, consistencyScore }.
 * Gracefully skips files that cannot be read or parsed.
 */
export function getRunMetricsSummary(cwd: string, limit = 25): RunMetrics[] {
	const dir = metricsDir(cwd);
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const metrics: RunMetrics[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const runId = entry.name.replace(/\.json$/, "");
		const m = loadRunMetrics(cwd, runId);
		if (m) metrics.push(m);
		if (metrics.length >= MAX_METRIC_FILES_TO_SCAN) break;
	}

	// Sort newest first (by timestamp, then runId as tiebreaker).
	metrics.sort((a, b) => {
		const diff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
		if (diff !== 0) return diff;
		return b.runId.localeCompare(a.runId);
	});

	return metrics.slice(0, limit);
}
