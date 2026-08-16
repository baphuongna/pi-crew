/**
 * b5 — deep subagent tracking cost benchmark.
 *
 * Measures the cost of the deep-tracking machinery pi-crew applies per
 * subagent: run-graph build/save, observation-store record/save/load, and
 * event-log growth estimates for N subagents.
 *
 * Sizes: 1, 10, 50 subagents (each with a synthetic task + observations).
 * Reports:
 *   - buildRunGraph ms + nodes/edges count
 *   - saveRunGraph ms + bytes
 *   - ObservationStore record N obs + save + load ms + bytes
 *   - estimated per-subagent event-log bytes and tokens (bytes/4 heuristic)
 *   - collectRunMetrics cost on the synthetic tasks
 *
 * All file I/O lands in a temp dir (crew root), cleaned in `finally`.
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b5-deep-tracking.bench.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { ObservationStore } from "../src/state/stores/observation-store.ts";
import { buildRunGraph, saveRunGraph } from "../src/state/stores/run-graph.ts";
import { collectRunMetrics } from "../src/state/stores/run-metrics.ts";
import type { TeamRunManifest, TeamTaskState } from "../src/state/types.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-b5-"));

function makeTask(i: number, subagents: number): TeamTaskState {
	return {
		id: `task-${i}`,
		runId: "b5-run",
		role: `agent-${i % Math.max(1, Math.floor(subagents / 3))}`,
		agent: "worker",
		title: `task ${i}`,
		status: "completed",
		dependsOn: i > 0 ? [`task-${i - 1}`] : [],
		cwd: tmpRoot,
		startedAt: new Date(Date.now() - 60000).toISOString(),
		finishedAt: new Date().toISOString(),
		usage: { input: 1000 + i * 10, output: 200 + i, cost: 0.001 + i * 0.0001, turns: 1 },
	};
}

function makeManifest(): TeamRunManifest {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		runId: "b5-run",
		team: "bench",
		workflow: "plan-execute",
		goal: "deep tracking benchmark",
		status: "completed",
		workspaceMode: "single",
		createdAt: new Date(Date.now() - 120000).toISOString(),
		updatedAt: now,
		cwd: tmpRoot,
		stateRoot: path.join(tmpRoot, "state"),
		artifactsRoot: path.join(tmpRoot, "artifacts"),
		tasksPath: path.join(tmpRoot, "tasks.json"),
		eventsPath: path.join(tmpRoot, "events.jsonl"),
		artifacts: [],
	};
}

function makeObservation(i: number): Parameters<ObservationStore["record"]>[0] {
	return {
		tool: "read",
		input: `read src/file-${i}.ts`,
		output: `content ${"x".repeat(500)}`,
		filesRead: [`src/file-${i}.ts`],
		filesModified: [],
		timestamp: Date.now(),
		sessionId: "b5-session",
		taskId: `task-${i}`,
	};
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function main(): void {
	const rssBefore = process.memoryUsage().rss;
	const cases: Record<string, unknown> = {};
	const manifest = makeManifest();

	for (const subagents of [1, 10, 50]) {
		// 3 tasks per subagent to mimic a realistic run.
		const tasks = Array.from({ length: subagents * 3 }, (_, i) => makeTask(i, subagents));

		// Run-graph build + save.
		const g0 = performance.now();
		const graph = buildRunGraph(manifest, tasks);
		const graphBuildMs = performance.now() - g0;
		const g1 = performance.now();
		const graphPath = saveRunGraph(graph, tmpRoot);
		const graphSaveMs = performance.now() - g1;
		const graphBytes = fs.statSync(graphPath).size;

		// Observation store: record + save + load.
		const storePath = path.join(tmpRoot, `obs-${subagents}.json`);
		const store = new ObservationStore(storePath, { maxObservations: 5000, maxCompressed: 500 });
		const r0 = performance.now();
		for (let i = 0; i < subagents; i++) store.record(makeObservation(i));
		const recordMs = performance.now() - r0;
		const r1 = performance.now();
		store.save();
		const saveMs = performance.now() - r1;
		const r2 = performance.now();
		const store2 = new ObservationStore(storePath, { maxObservations: 5000, maxCompressed: 500 });
		const loadMs = performance.now() - r2;
		const obsBytes = fs.statSync(storePath).size;

		// collectRunMetrics (token/cost aggregation over tasks).
		const m0 = performance.now();
		collectRunMetrics(tmpRoot, "b5-run");
		const metricsMs = performance.now() - m0;

		// Per-subagent deep-tracking estimate: each subagent generates events
		// (spawn, progress xN, transition, message_end) and an observation.
		// bytes/4 is the standard token heuristic.
		// CAVEAT (audit): these are HEURISTIC GUESSES (8 events × 180B), NOT
		// measurements. For REAL per-subagent tokens, use analyze-run.mjs which
		// reads transcript usage. Do not cite estTokens* as measured values.
		const estEventsPerSubagent = 8;
		const estBytesPerEvent = 180;
		const estBytesPerSubagent = estEventsPerSubagent * estBytesPerEvent;
		const estTokensPerSubagent = Math.round(estBytesPerSubagent / 4);

		cases[`n${subagents}`] = {
			taskCount: tasks.length,
			graphBuildMs: round(graphBuildMs),
			graphNodes: graph.nodes.length,
			graphEdges: graph.edges.length,
			graphSaveMs: round(graphSaveMs),
			graphBytes,
			obsRecordMs: round(recordMs),
			obsSaveMs: round(saveMs),
			obsLoadMs: round(loadMs),
			obsBytes,
			collectRunMetricsMs: round(metricsMs),
			estBytesPerSubagent,
			estTokensPerSubagent,
			estTokensForRun: estTokensPerSubagent * subagents,
		};
		console.log(
			`b5 n=${subagents}: graph=${round(graphBuildMs)}ms (${graph.nodes.length}N/${graph.edges.length}E, ${graphBytes}B) obs=${round(recordMs + saveMs)}ms (${obsBytes}B) estTok/sub=${estTokensPerSubagent}`,
		);
	}

	const result = {
		name: "b5.deep-tracking",
		unit: "ms",
		sizes: [1, 10, 50],
		cases,
		rssDeltaBytes: process.memoryUsage().rss - rssBefore,
	};
	console.log(JSON.stringify(result));
}

try {
	main();
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}
