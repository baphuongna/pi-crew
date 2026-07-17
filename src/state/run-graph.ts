import * as fs from "node:fs";
import * as path from "node:path";
import { projectCrewRoot } from "../utils/paths.ts";
import { assertSafePathId } from "../utils/safe-paths.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import type { TeamRunManifest, TeamTaskState } from "./types.ts";

export interface RunGraphNode {
	id: string;
	type: "run" | "task" | "agent" | "artifact" | "file";
	name: string;
	metadata?: Record<string, unknown>;
}

export interface RunGraphEdge {
	source: string;
	target: string;
	type: "dependsOn" | "produces" | "runs" | "contains";
	weight?: number;
}

export interface RunGraphLayer {
	name: string;
	nodeIds: string[];
}

export interface RunGraph {
	version: "1.0.0";
	runId: string;
	team: string;
	workflow: string;
	createdAt: string;
	completedAt?: string;
	status: string;
	nodes: RunGraphNode[];
	edges: RunGraphEdge[];
	layers: RunGraphLayer[];
}

/**
 * Build a unified run graph from manifest + tasks.
 * Consolidates state into a single graph JSON for dashboard/API use.
 */
export function buildRunGraph(manifest: TeamRunManifest, tasks: TeamTaskState[]): RunGraph {
	const nodes: RunGraphNode[] = [];
	const edges: RunGraphEdge[] = [];
	const nodeIds = new Set<string>();

	// Add run node
	const runId = manifest.runId;
	nodes.push({
		id: `run:${runId}`,
		type: "run",
		name: manifest.goal ?? runId,
		metadata: {
			team: manifest.team,
			workflow: manifest.workflow,
			status: manifest.status,
			createdAt: manifest.createdAt,
		},
	});
	nodeIds.add(`run:${runId}`);

	// Add task nodes
	for (const task of tasks) {
		const taskId = `task:${task.id}`;
		if (nodeIds.has(taskId)) continue;
		nodeIds.add(taskId);

		nodes.push({
			id: taskId,
			type: "task",
			name: task.role,
			metadata: {
				status: task.status,
				startedAt: task.startedAt,
				finishedAt: task.finishedAt,
			},
		});

		// Edge from run to task
		edges.push({
			source: `run:${runId}`,
			target: taskId,
			type: "contains",
		});

		// Edges from dependencies
		for (const dep of task.dependsOn ?? []) {
			edges.push({
				source: `task:${dep}`,
				target: taskId,
				type: "dependsOn",
				weight: 1.0,
			});
		}
	}

	// Group by layer (based on phase or role)
	const layerMap = new Map<string, string[]>();
	for (const task of tasks) {
		const layerName = task.adaptive?.phase ?? task.role;
		if (!layerMap.has(layerName)) layerMap.set(layerName, []);
		layerMap.get(layerName)!.push(`task:${task.id}`);
	}

	const layers: RunGraphLayer[] = [...layerMap.entries()].map(([name, nodeIdList]) => ({
		name,
		nodeIds: nodeIdList,
	}));

	return {
		version: "1.0.0",
		runId,
		team: manifest.team ?? "unknown",
		workflow: manifest.workflow ?? "unknown",
		createdAt: manifest.createdAt,
		completedAt: manifest.updatedAt,
		status: manifest.status,
		nodes,
		edges,
		layers,
	};
}

/**
 * Save run graph to disk.
 * Uses projectCrewRoot() to honour the .pi/teams/ fallback for .pi-based
 * projects (issue #29 follow-up). Graph files now live alongside the
 * manifest at `<crewRoot>/graphs/<runId>.json`.
 */
export function saveRunGraph(graph: RunGraph, cwd: string): string {
	assertSafePathId("runId", graph.runId);
	const crewRoot = projectCrewRoot(cwd);
	const graphsDir = path.join(crewRoot, "graphs");

	if (!fs.existsSync(graphsDir)) {
		fs.mkdirSync(graphsDir, { recursive: true });
	}

	const graphPath = path.join(graphsDir, `${graph.runId}.json`);
	atomicWriteFile(graphPath, JSON.stringify(graph, null, 2));

	return graphPath;
}

/**
 * Load run graph from disk.
 */
export function loadRunGraph(cwd: string, runId: string): RunGraph | null {
	assertSafePathId("runId", runId);
	const crewRoot = projectCrewRoot(cwd);
	const graphPath = path.join(crewRoot, "graphs", `${runId}.json`);
	if (!fs.existsSync(graphPath)) return null;

	try {
		return JSON.parse(fs.readFileSync(graphPath, "utf-8")) as RunGraph;
	} catch {
		return null;
	}
}

/**
 * List all archived run graphs.
 */
export function listRunGraphs(cwd: string): string[] {
	const crewRoot = projectCrewRoot(cwd);
	const graphsDir = path.join(crewRoot, "graphs");
	if (!fs.existsSync(graphsDir)) return [];

	return fs
		.readdirSync(graphsDir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""));
}

/**
 * Build and save run graph from manifest + tasks.
 */
export function buildAndSaveRunGraph(manifest: TeamRunManifest, tasks: TeamTaskState[], cwd: string): string {
	const graph = buildRunGraph(manifest, tasks);
	return saveRunGraph(graph, cwd);
}
