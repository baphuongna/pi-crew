import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry, type MetricRegistry } from "../../../../src/observability/metric-registry.ts";
import { HeartbeatWatcher } from "../../../../src/runtime/heartbeat/heartbeat-watcher.ts";
import { createManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import { createRunManifest, saveRunTasks, updateRunStatus } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as never;
const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as never;

function labelsFor(registry: MetricRegistry, name: string): Record<string, unknown>[] {
	const metric = registry.snapshot().find((entry) => entry.name === name);
	assert.ok(metric, `metric ${name} registered`);
	return (metric.values as { labels: Record<string, unknown> }[]).map((point) => point.labels);
}

function canonicalize(dir: string): string {
	try {
		const real = fs.realpathSync.native(dir);
		return real.startsWith("\\\\?\\") ? real.slice(4) : real;
	} catch {
		return dir;
	}
}

/** Create a run that is running on disk with one running task carrying a heartbeat. */
function makeRunningRun(cwd: string, goal: string, lastSeenAt: string): TeamRunManifest {
	const created = createRunManifest({ cwd, team, workflow, goal });
	const running = updateRunStatus(created.manifest, "running", "running");
	saveRunTasks(
		running,
		created.tasks.map((task) => ({
			...task,
			status: "running" as const,
			heartbeat: { workerId: task.id, lastSeenAt, alive: true },
		})),
	);
	return running;
}

/**
 * FIX 2 (LABEL-GC): run-scoped label values ({runId,taskId} gauge + {runId,level}
 * counter) must be released once the run stops being active — otherwise the
 * registry grows forever (the 10_000 FIFO cap is never reached in practice).
 */
test("HeartbeatWatcher releases run-scoped labels when a run stops being active", async () => {
	const cwd = canonicalize(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-hb-label-release-")));
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const lastSeenAt = new Date(t0 - 1000).toISOString();
		const runA = makeRunningRun(cwd, "a", lastSeenAt);
		const runB = makeRunningRun(cwd, "b", lastSeenAt);
		const cache = createManifestCache(cwd, { watch: false, debounceMs: 0 });
		const registry = createMetricRegistry();
		const watcher = new HeartbeatWatcher({
			cwd,
			manifestCache: cache,
			registry,
			router: { enqueue: () => true },
			deadletterTickThreshold: 99,
		});

		watcher.tick(t0);
		const gaugeRunIds = new Set(labelsFor(registry, "crew.heartbeat.staleness_ms").map((labels) => labels.runId));
		assert.ok(gaugeRunIds.has(runA.runId), "running run A emits gauge labels");
		assert.ok(gaugeRunIds.has(runB.runId), "running run B emits gauge labels");
		assert.ok(
			labelsFor(registry, "crew.heartbeat.level_total").some((labels) => labels.runId === runA.runId),
			"running run A emits counter labels",
		);

		// runA reaches a terminal status on disk; runB keeps running.
		updateRunStatus(runA, "completed", "done");
		cache.clear();
		watcher.tick(t0 + 5000);

		const afterGauge = labelsFor(registry, "crew.heartbeat.staleness_ms");
		assert.equal(
			afterGauge.some((labels) => labels.runId === runA.runId),
			false,
			"terminal run's gauge labels released on the next tick",
		);
		assert.equal(
			labelsFor(registry, "crew.heartbeat.level_total").some((labels) => labels.runId === runA.runId),
			false,
			"terminal run's counter labels released too",
		);
		assert.ok(
			afterGauge.some((labels) => labels.runId === runB.runId),
			"still-running run keeps its labels",
		);

		watcher.dispose();
		cache.dispose();
	} finally {
		await removeDirWithRetry(cwd);
	}
});

/**
 * A BLOCKED run (parked on `ask`, resumable — blocked is terminal-for-UI but
 * unblockable) must NOT have its labels released.
 */
test("HeartbeatWatcher keeps labels for a blocked run", async () => {
	const cwd = canonicalize(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-hb-label-blocked-")));
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const run = makeRunningRun(cwd, "blocked", new Date(t0 - 1000).toISOString());
		const cache = createManifestCache(cwd, { watch: false, debounceMs: 0 });
		const registry = createMetricRegistry();
		const watcher = new HeartbeatWatcher({
			cwd,
			manifestCache: cache,
			registry,
			router: { enqueue: () => true },
			deadletterTickThreshold: 99,
		});

		watcher.tick(t0);
		assert.ok(labelsFor(registry, "crew.heartbeat.staleness_ms").some((labels) => labels.runId === run.runId));

		updateRunStatus(run, "blocked", "parked on ask");
		cache.clear();
		watcher.tick(t0 + 5000);
		watcher.tick(t0 + 10000);

		assert.ok(
			labelsFor(registry, "crew.heartbeat.staleness_ms").some((labels) => labels.runId === run.runId),
			"blocked run retains its gauge labels",
		);
		assert.ok(
			labelsFor(registry, "crew.heartbeat.level_total").some((labels) => labels.runId === run.runId),
			"blocked run retains its counter labels",
		);

		// Once the blocked run is cancelled for real, the labels go.
		updateRunStatus(run, "cancelled", "gave up");
		cache.clear();
		watcher.tick(t0 + 15000);
		assert.equal(
			labelsFor(registry, "crew.heartbeat.staleness_ms").some((labels) => labels.runId === run.runId),
			false,
			"labels released after the blocked run truly terminated",
		);

		watcher.dispose();
		cache.dispose();
	} finally {
		await removeDirWithRetry(cwd);
	}
});
