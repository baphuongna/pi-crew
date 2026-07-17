import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";

export interface ToolProgressInput {
	/** Subagent record id or synthetic agent label shown in the header. */
	agentId?: string;
	/** Subagent/run status string ("queued", "running", "blocked", ...). */
	status: string;
	/** Optional run id once the underlying team run has been created. */
	runId?: string;
	/** Timestamp (ms) when the parent tool call started. */
	startedAt: number;
	/** Optional manifest snapshot for richer detail. */
	manifest?: TeamRunManifest;
	/** Optional materialized task list for waiting/running counts. */
	tasks?: TeamTaskState[];
	/** Optional crew agent records to surface the currently active worker. */
	agents?: CrewAgentRecord[];
	/** Optional last error to surface (e.g. spawn failure). */
	error?: string;
}

const MAX_OUTPUT_LINE = 80;

function pickActiveAgent(agents: CrewAgentRecord[] | undefined): CrewAgentRecord | undefined {
	if (!agents || agents.length === 0) return undefined;
	return (
		agents.find((agent) => agent.status === "running") ??
		agents.find((agent) => agent.status === "waiting") ??
		agents.find((agent) => agent.status === "queued") ??
		agents[agents.length - 1]
	);
}

function totalTokens(agent: CrewAgentRecord): number {
	const fromProgress = agent.progress?.tokens;
	if (typeof fromProgress === "number" && fromProgress > 0) return fromProgress;
	const usage = agent.usage;
	if (!usage) return 0;
	const input = typeof usage.input === "number" ? usage.input : 0;
	const output = typeof usage.output === "number" ? usage.output : 0;
	return input + output;
}

function trimLine(value: string): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= MAX_OUTPUT_LINE) return oneLine;
	return `${oneLine.slice(0, MAX_OUTPUT_LINE - 3)}...`;
}

function taskCounts(tasks: TeamTaskState[] | undefined): string | undefined {
	if (!tasks || tasks.length === 0) return undefined;
	const total = tasks.length;
	const completed = tasks.filter((t) => t.status === "completed").length;
	const buckets = new Map<string, number>();
	for (const task of tasks) buckets.set(task.status, (buckets.get(task.status) ?? 0) + 1);
	const summary = [...buckets.entries()].map(([status, count]) => `${status}=${count}`).join(" ");
	return `tasks ${completed}/${total} done ${summary}`;
}

/**
 * Format a compact 3-4 line progress block used as streaming `onUpdate`
 * content for the `Agent` and `team` tool calls. Keeps each line short so
 * the chat widget overlay does not jitter.
 */
export function formatCompactToolProgress(input: ToolProgressInput): string {
	const elapsedSec = Math.max(0, Math.round((Date.now() - input.startedAt) / 1000));
	const head = input.agentId ? `agent=${input.agentId}` : "agent";
	const lines: string[] = [`${head} status=${input.status} elapsed=${elapsedSec}s`];

	const counts = taskCounts(input.tasks);
	if (counts) lines.push(`  ${counts}`);

	const active = pickActiveAgent(input.agents);
	if (active) {
		const turns = active.progress?.turns ?? 0;
		const tokens = totalTokens(active);
		lines.push(`  ${active.role}->${active.agent} turn=${turns} tokens=${tokens}`);
		if (active.progress?.currentTool) {
			const count = active.progress.toolCount ? ` (#${active.progress.toolCount})` : "";
			lines.push(`  tool: ${active.progress.currentTool}${count}`);
		}
		const recent = active.progress?.recentOutput?.at(-1);
		if (recent?.trim()) lines.push(`  ${trimLine(recent)}`);
	} else if (input.runId && !counts) {
		lines.push(`  run=${input.runId} (starting)`);
	} else if (input.error) {
		lines.push(`  error: ${trimLine(input.error)}`);
	} else if (!counts) {
		lines.push("  waiting for run to start");
	}
	return lines.join("\n");
}
