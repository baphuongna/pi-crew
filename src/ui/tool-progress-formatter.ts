import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { spinnerClockNow } from "./spinner.ts";

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

// ── Producer↔consumer contract (audit P1-13) ───────────────────────────

/**
 * Every token that `formatCompactToolProgress` (producer) emits and that the
 * `team`/`agent` tool renderers (consumer, `parseCompactToolProgress` below)
 * look for. The two sides used to be coupled only by hand-written regexes, so a
 * one-character format change made the streaming progress block silently empty.
 * Both sides now read the tokens from here.
 */
export const PROGRESS_FORMAT = {
	/** Header: `agent=<id> status=<status> elapsed=<n>s` (`agent` with no id). */
	agentKey: "agent",
	statusKey: "status",
	elapsedKey: "elapsed",
	/** Unit suffix for `elapsed=` (seconds). */
	elapsedUnit: "s",
	/** Task tally: `tasks <completed>/<total> done <status>=<n> …`. */
	tasksKey: "tasks",
	tallySeparator: "/",
	doneWord: "done",
	/** Active worker row: `<role>-><agent> turn=<n> tokens=<n>`. */
	roleSeparator: "->",
	turnKey: "turn",
	tokensKey: "tokens",
	/** Current tool row: `tool: <name> (#<n>)`. */
	toolKey: "tool",
	toolSeparator: ":",
	/** Pending-run row: `run=<id> (starting)`. */
	runKey: "run",
	/** Failure row: `error: <text>`. */
	errorKey: "error",
	/** Fallback row before the run materializes. */
	waitingLine: "waiting for run to start",
} as const;

/**
 * Structured image of a compact progress block. Consumed by the tool renderers;
 * `null` from the parser means "nothing progress-like in this text".
 */
export interface ParsedToolProgress {
	/** `elapsed=<n>s` in milliseconds (0 when absent). */
	elapsedMs: number;
	/** `status=<x>` value (note: the renderer only surfaces it when no task counts exist). */
	status: string | null;
	/** Completed task count from the tally row (null when absent). */
	completed: number | null;
	/** Total task count from the tally row (completed + remaining for the legacy bucket form). */
	total: number | null;
	/** `<role>/<agent>` of the active worker row, if present. */
	activeAgent: string | null;
	/** Current tool name from `tool: <name>`, if present. */
	currentTool: string | null;
	/** Turn count of the active worker row, if present. */
	turns: number | null;
	/** Token count of the active worker row, if present. */
	tokens: number | null;
}

const ELAPSED_RE = new RegExp(`${PROGRESS_FORMAT.elapsedKey}=(\\d+)${PROGRESS_FORMAT.elapsedUnit}`);
const STATUS_RE = new RegExp(`${PROGRESS_FORMAT.statusKey}=(\\w+)`);
const TALLY_RE = new RegExp(
	`${PROGRESS_FORMAT.tasksKey}\\s+(\\d+)${PROGRESS_FORMAT.tallySeparator}(\\d+)\\s+${PROGRESS_FORMAT.doneWord}\\b`,
);
// Legacy bucket form (`tasks completed=2 running=1`) — kept for older/foreign
// producers; the tally form above wins when both are present.
const BUCKETS_RE = new RegExp(
	`${PROGRESS_FORMAT.tasksKey}[^\\n]*(?:completed|${PROGRESS_FORMAT.doneWord})=(\\d+)[^\\n]*(?:running|waiting|queued)=(\\d+)`,
);
const AGENT_ROW_RE = new RegExp(`\\s+(\\w+)${PROGRESS_FORMAT.roleSeparator}(\\w+)\\s+${PROGRESS_FORMAT.turnKey}=`);
const TURN_RE = new RegExp(`${PROGRESS_FORMAT.turnKey}=(\\d+)`);
const TOKENS_RE = new RegExp(`${PROGRESS_FORMAT.tokensKey}=(\\d+)`);
const TOOL_ROW_RE = new RegExp(`${PROGRESS_FORMAT.toolKey}${PROGRESS_FORMAT.toolSeparator}\\s+(\\S+)`);

/** Parse a compact progress block back into structured fields (see PROGRESS_FORMAT). */
export function parseCompactToolProgress(text: string): ParsedToolProgress | null {
	if (!text) return null;

	const elapsedMatch = ELAPSED_RE.exec(text);
	const elapsedMs = elapsedMatch ? Number.parseInt(elapsedMatch[1]!, 10) * 1000 : 0;

	let completed: number | null = null;
	let total: number | null = null;
	const tally = TALLY_RE.exec(text);
	if (tally) {
		completed = Number.parseInt(tally[1]!, 10);
		total = Number.parseInt(tally[2]!, 10);
	} else {
		const buckets = BUCKETS_RE.exec(text);
		if (buckets) {
			completed = Number.parseInt(buckets[1]!, 10);
			total = completed + Number.parseInt(buckets[2]!, 10);
		}
	}

	// Nothing progress-like: mirrors the historical "no elapsed/task signal → null".
	if (elapsedMs === 0 && completed === null) return null;

	const agentRow = AGENT_ROW_RE.exec(text);
	const toolRow = TOOL_ROW_RE.exec(text);
	const turns = TURN_RE.exec(text);
	const tokens = TOKENS_RE.exec(text);
	return {
		elapsedMs,
		status: STATUS_RE.exec(text)?.[1] ?? null,
		completed,
		total,
		activeAgent: agentRow ? `${agentRow[1]}/${agentRow[2]}` : null,
		currentTool: toolRow ? toolRow[1]! : null,
		turns: turns ? Number.parseInt(turns[1]!, 10) : null,
		tokens: tokens ? Number.parseInt(tokens[1]!, 10) : null,
	};
}

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
	return `${PROGRESS_FORMAT.tasksKey} ${completed}${PROGRESS_FORMAT.tallySeparator}${total} ${PROGRESS_FORMAT.doneWord} ${summary}`;
}

/**
 * Format a compact 3-4 line progress block used as streaming `onUpdate`
 * content for the `Agent` and `team` tool calls. Keeps each line short so
 * the chat widget overlay does not jitter.
 */
export function formatCompactToolProgress(input: ToolProgressInput): string {
	const elapsedSec = Math.max(0, Math.round((spinnerClockNow() - input.startedAt) / 1000));
	const head = input.agentId ? `${PROGRESS_FORMAT.agentKey}=${input.agentId}` : PROGRESS_FORMAT.agentKey;
	// Emitted from PROGRESS_FORMAT so the parser can never drift from the wire format.
	const lines: string[] = [
		`${head} ${PROGRESS_FORMAT.statusKey}=${input.status} ${PROGRESS_FORMAT.elapsedKey}=${elapsedSec}${PROGRESS_FORMAT.elapsedUnit}`,
	];

	const counts = taskCounts(input.tasks);
	if (counts) lines.push(`  ${counts}`);

	const active = pickActiveAgent(input.agents);
	if (active) {
		const turns = active.progress?.turns ?? 0;
		const tokens = totalTokens(active);
		lines.push(
			`  ${active.role}${PROGRESS_FORMAT.roleSeparator}${active.agent} ${PROGRESS_FORMAT.turnKey}=${turns} ${PROGRESS_FORMAT.tokensKey}=${tokens}`,
		);
		if (active.progress?.currentTool) {
			const count = active.progress.toolCount ? ` (#${active.progress.toolCount})` : "";
			lines.push(`  ${PROGRESS_FORMAT.toolKey}${PROGRESS_FORMAT.toolSeparator} ${active.progress.currentTool}${count}`);
		}
		const recent = active.progress?.recentOutput?.at(-1);
		if (recent?.trim()) lines.push(`  ${trimLine(recent)}`);
	} else if (input.runId && !counts) {
		lines.push(`  ${PROGRESS_FORMAT.runKey}=${input.runId} (starting)`);
	} else if (input.error) {
		lines.push(`  ${PROGRESS_FORMAT.errorKey}: ${trimLine(input.error)}`);
	} else if (!counts) {
		lines.push(`  ${PROGRESS_FORMAT.waitingLine}`);
	}
	return lines.join("\n");
}
