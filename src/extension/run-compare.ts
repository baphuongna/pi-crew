import { readEvents } from "../state/event-log/event-log.ts";
import { writeArtifact } from "../state/stores/artifact-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { formatCost, formatTokens } from "../state/usage.ts";
import { formatDuration } from "../ui/format-helpers.ts";

/**
 * US-021 (2026-09-22) — run comparison (before/after diff of two runs).
 *
 * Scope per spec docs/specs/US-021.md: status delta, per-task
 * status/duration/tokens/cost deltas, event-type set diff, model routing diff.
 * NOT in scope: visual UI, git integration.
 *
 * Determinism: the markdown body contains NO wall-clock (the spec pins this so
 * comparisons are byte-diffable — same pattern as US-022's injectable `now`).
 * Everything rendered derives from run data; the artifact's own write time is
 * filesystem metadata, not content. The output also deliberately contains NO
 * absolute paths (ids, statuses and deltas only), so the run-export
 * `redactHomePaths` pass is unnecessary here — noted because the spec asked.
 */

export interface TaskDelta {
	id: string;
	statusA?: string;
	statusB?: string;
	/** b − a; undefined when either side lacks the data (task missing, or no timestamps). */
	durationDeltaMs?: number;
	/** b − a; undefined when either side lacks usage. */
	tokensDelta?: number;
	/** b − a; undefined when either side lacks cost. */
	costDelta?: number;
}

export interface ModelRoutingDiff {
	taskId: string;
	modelA?: string;
	modelB?: string;
}

export interface RunComparison {
	runA: string;
	runB: string;
	status: { a: string; b: string };
	/** True when every compared field matches (the self-diff invariant). */
	identical: boolean;
	/** One row per task id present in EITHER run. */
	tasks: TaskDelta[];
	tasksOnlyInA: string[];
	tasksOnlyInB: string[];
	events: { addedTypes: string[]; removedTypes: string[] };
	models: ModelRoutingDiff[];
	usage: { tokensDelta: number; costDelta: number; tokensA: number; tokensB: number; costA: number; costB: number };
}

function taskDurationMs(task: TeamTaskState): number | undefined {
	if (!task.startedAt || !task.finishedAt) return undefined;
	const ms = new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

function taskTokens(task: TeamTaskState): number | undefined {
	if (!task.usage) return undefined;
	const { input, output } = task.usage;
	if (input === undefined && output === undefined) return undefined;
	return (input ?? 0) + (output ?? 0);
}

function taskCost(task: TeamTaskState): number | undefined {
	const cost = task.usage?.cost;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

function sumTokens(tasks: TeamTaskState[]): number {
	return tasks.reduce((acc, task) => acc + (taskTokens(task) ?? 0), 0);
}

function sumCost(tasks: TeamTaskState[]): number {
	return tasks.reduce((acc, task) => acc + (taskCost(task) ?? 0), 0);
}

function eventTypeSet(eventsPath: string): Set<string> {
	const types = new Set<string>();
	for (const event of readEvents(eventsPath)) {
		if (event.type) types.add(event.type);
	}
	return types;
}

export function compareRuns(
	manifestA: TeamRunManifest,
	tasksA: TeamTaskState[],
	manifestB: TeamRunManifest,
	tasksB: TeamTaskState[],
): RunComparison {
	const byIdA = new Map(tasksA.map((task) => [task.id, task] as const));
	const byIdB = new Map(tasksB.map((task) => [task.id, task] as const));
	const allIds = [...new Set([...byIdA.keys(), ...byIdB.keys()])].sort();

	const tasks: TaskDelta[] = allIds.map((id) => {
		const a = byIdA.get(id);
		const b = byIdB.get(id);
		const delta: TaskDelta = { id };
		if (a) delta.statusA = a.status;
		if (b) delta.statusB = b.status;
		const durA = a ? taskDurationMs(a) : undefined;
		const durB = b ? taskDurationMs(b) : undefined;
		if (durA !== undefined && durB !== undefined) delta.durationDeltaMs = durB - durA;
		const tokA = a ? taskTokens(a) : undefined;
		const tokB = b ? taskTokens(b) : undefined;
		if (tokA !== undefined && tokB !== undefined) delta.tokensDelta = tokB - tokA;
		const costA = a ? taskCost(a) : undefined;
		const costB = b ? taskCost(b) : undefined;
		if (costA !== undefined && costB !== undefined) delta.costDelta = costB - costA;
		return delta;
	});

	const typesA = eventTypeSet(manifestA.eventsPath);
	const typesB = eventTypeSet(manifestB.eventsPath);

	const models: ModelRoutingDiff[] = allIds
		.filter((id) => {
			const a = byIdA.get(id)?.model;
			const b = byIdB.get(id)?.model;
			return a !== undefined || b !== undefined;
		})
		.map((id) => ({ taskId: id, modelA: byIdA.get(id)?.model, modelB: byIdB.get(id)?.model }))
		.filter((diff) => diff.modelA !== diff.modelB);

	const statusEqual = manifestA.status === manifestB.status;
	const noTaskDeltas = tasks.every(
		(delta) =>
			delta.statusA === delta.statusB &&
			(delta.durationDeltaMs ?? 0) === 0 &&
			(delta.tokensDelta ?? 0) === 0 &&
			(delta.costDelta ?? 0) === 0,
	);
	const tokensA = sumTokens(tasksA);
	const tokensB = sumTokens(tasksB);
	const costA = sumCost(tasksA);
	const costB = sumCost(tasksB);

	return {
		runA: manifestA.runId,
		runB: manifestB.runId,
		status: { a: manifestA.status, b: manifestB.status },
		identical:
			statusEqual && noTaskDeltas && tasksA.length === tasksB.length && tokensA === tokensB && costA === costB && models.length === 0,
		tasks,
		tasksOnlyInA: tasksA.map((t) => t.id).filter((id) => !byIdB.has(id)),
		tasksOnlyInB: tasksB.map((t) => t.id).filter((id) => !byIdA.has(id)),
		events: {
			addedTypes: [...typesB].filter((t) => !typesA.has(t)).sort(),
			removedTypes: [...typesA].filter((t) => !typesB.has(t)).sort(),
		},
		models,
		usage: { tokensDelta: tokensB - tokensA, costDelta: costB - costA, tokensA, tokensB, costA, costB },
	};
}

function signed(value: number, format: (abs: number) => string): string {
	if (value === 0) return "0";
	return value > 0 ? `+${format(value)}` : `-${format(-value)}`;
}

export function renderComparisonMarkdown(comparison: RunComparison): string {
	const lines: string[] = [
		`# pi-crew comparison ${comparison.runA} vs ${comparison.runB}`,
		"",
		`Status: a=${comparison.status.a} b=${comparison.status.b}`,
		`Comparison: ${comparison.identical ? "identical" : "different"}`,
		"",
		"## Tasks",
		...(comparison.tasks.length
			? comparison.tasks.map((delta) => {
					const parts = [`- ${delta.id}: a=${delta.statusA ?? "(absent)"} b=${delta.statusB ?? "(absent)"}`];
					if (delta.durationDeltaMs !== undefined) parts.push(`Δdur=${signed(delta.durationDeltaMs, formatDuration)}`);
					if (delta.tokensDelta !== undefined) parts.push(`Δtok=${signed(delta.tokensDelta, formatTokens)}`);
					if (delta.costDelta !== undefined) parts.push(`Δcost=${signed(delta.costDelta, formatCost)}`);
					return parts.join(" ");
				})
			: ["- (none)"]),
		`Only in a: ${comparison.tasksOnlyInA.length ? comparison.tasksOnlyInA.join(", ") : "(none)"}`,
		`Only in b: ${comparison.tasksOnlyInB.length ? comparison.tasksOnlyInB.join(", ") : "(none)"}`,
		"",
		"## Models",
		...(comparison.models.length
			? comparison.models.map((m) => `- ${m.taskId}: ${m.modelA ?? "(none)"} -> ${m.modelB ?? "(none)"}`)
			: ["- (no routing differences)"]),
		"",
		"## Events",
		`Added types: ${comparison.events.addedTypes.length ? comparison.events.addedTypes.join(", ") : "(none)"}`,
		`Removed types: ${comparison.events.removedTypes.length ? comparison.events.removedTypes.join(", ") : "(none)"}`,
		"",
		"## Totals",
		`Tokens: a=${formatTokens(comparison.usage.tokensA)} b=${formatTokens(comparison.usage.tokensB)} Δ=${signed(comparison.usage.tokensDelta, formatTokens)}`,
		`Cost: a=${formatCost(comparison.usage.costA)} b=${formatCost(comparison.usage.costB)} Δ=${signed(comparison.usage.costDelta, formatCost)}`,
		"",
	];
	return lines.join("\n");
}

/**
 * Compare two runs and write the markdown artifact under the FIRST run's
 * artifactsRoot (spec AC-5) at `compare/<runA>__<runB>.md`.
 */
export function runCompareBundle(
	manifestA: TeamRunManifest,
	tasksA: TeamTaskState[],
	manifestB: TeamRunManifest,
	tasksB: TeamTaskState[],
): { comparison: RunComparison; markdownPath: string } {
	const comparison = compareRuns(manifestA, tasksA, manifestB, tasksB);
	const artifact = writeArtifact(manifestA.artifactsRoot, {
		kind: "summary",
		relativePath: `compare/${manifestA.runId}__${manifestB.runId}.md`,
		producer: "run-compare",
		content: renderComparisonMarkdown(comparison),
	});
	return { comparison, markdownPath: artifact.path };
}
