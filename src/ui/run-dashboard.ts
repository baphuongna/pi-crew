import * as fs from "node:fs";
import type { TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import { isDisplayActiveRun, isLikelyOrphanedActiveRun } from "../runtime/process-status.ts";

interface DashboardComponent {
	invalidate(): void;
	render(width: number): string[];
	handleInput(data: string): void;
}

type DashboardTheme = { fg?: (color: string, text: string) => string; bold?: (text: string) => string };

export interface RunDashboardOptions {
	showModel?: boolean;
	showTokens?: boolean;
	showTools?: boolean;
}

export type RunDashboardAction = "status" | "summary" | "artifacts" | "api" | "events" | "agents" | "agent-events" | "agent-output" | "agent-transcript" | "reload";
export interface RunDashboardSelection {
	runId: string;
	action: RunDashboardAction;
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function visibleLength(value: string): number {
	return value.replace(ANSI_PATTERN, "").length;
}

function truncate(value: string, width: number): string {
	if (width <= 0) return "";
	if (visibleLength(value) <= width) return value;
	if (width <= 1) return "…";
	let output = "";
	let visible = 0;
	for (let index = 0; index < value.length;) {
		const slice = value.slice(index);
		const ansi = slice.match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
		if (ansi?.[0]) {
			output += ansi[0];
			index += ansi[0].length;
			continue;
		}
		const char = value[index]!;
		if (visible >= width - 1) break;
		output += char;
		visible += 1;
		index += char.length;
	}
	return `${output}\u001b[0m…`;
}

function padVisible(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function colorForStatus(status: string): string {
	if (status === "completed") return "success";
	if (status === "failed" || status === "stale") return "error";
	if (status === "cancelled" || status === "blocked") return "warning";
	if (status === "running") return "accent";
	return "dim";
}

function statusIcon(status: string): string {
	if (status === "completed") return "✓";
	if (status === "failed" || status === "stale") return "✗";
	if (status === "cancelled") return "!";
	if (status === "running") return "▶";
	if (status === "blocked") return "■";
	return "·";
}

function readProgressPreview(run: TeamRunManifest, maxLines = 5): string[] {
	const progress = [...run.artifacts].reverse().find((artifact) => artifact.kind === "progress");
	if (!progress || !fs.existsSync(progress.path)) return ["Progress: (none)"];
	try {
		return ["Progress:", ...fs.readFileSync(progress.path, "utf-8").split(/\r?\n/).filter(Boolean).slice(0, maxLines)];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [`Progress: failed to read (${message})`];
	}
}

function formatAge(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const ms = Math.max(0, Date.now() - new Date(iso).getTime());
	if (!Number.isFinite(ms)) return undefined;
	if (ms < 1000) return "now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h`;
}

function readRunTasks(run: TeamRunManifest): TeamTaskState[] {
	try {
		if (!fs.existsSync(run.tasksPath)) return [];
		const parsed = JSON.parse(fs.readFileSync(run.tasksPath, "utf-8"));
		return Array.isArray(parsed) ? parsed as TeamTaskState[] : [];
	} catch { return []; }
}

function formatTokens(usage: UsageState | undefined): string | undefined {
	if (!usage) return undefined;
	const total = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (!total) return undefined;
	const compact = total >= 1000 ? `${(total / 1000).toFixed(total >= 10_000 ? 0 : 1)}k` : `${total}`;
	const parts = [`tok=${compact}`];
	if (usage.input) parts.push(`in=${usage.input}`);
	if (usage.output) parts.push(`out=${usage.output}`);
	if (usage.cacheRead) parts.push(`cache=${usage.cacheRead}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join("/");
}

function taskForAgent(tasks: TeamTaskState[], agent: CrewAgentRecord): TeamTaskState | undefined {
	return tasks.find((task) => task.id === agent.taskId);
}

function modelForTask(task: TeamTaskState | undefined): string | undefined {
	const attempts = task?.modelAttempts;
	if (!attempts?.length) return undefined;
	return attempts.find((attempt) => attempt.success)?.model ?? attempts.at(-1)?.model;
}

function agentPreviewLine(agent: CrewAgentRecord, task: TeamTaskState | undefined, options: RunDashboardOptions): string {
	const stats = [
		agent.progress?.activityState,
		options.showModel !== false && modelForTask(task) ? `model=${modelForTask(task)}` : undefined,
		options.showTokens !== false ? formatTokens(task?.usage) ?? (agent.progress?.tokens !== undefined ? `tok=${agent.progress.tokens}` : undefined) : undefined,
		options.showTools !== false && agent.progress?.currentTool ? `tool=${agent.progress.currentTool}` : undefined,
		options.showTools !== false && agent.toolUses !== undefined ? `${agent.toolUses} tools` : undefined,
		agent.progress?.turns !== undefined ? `${agent.progress.turns} turns` : undefined,
		agent.progress?.failedTool ? `failedTool=${agent.progress.failedTool}` : undefined,
		agent.startedAt ? `age=${formatAge(agent.completedAt ?? agent.startedAt)}` : undefined,
	].filter((part): part is string => Boolean(part));
	const recent = agent.progress?.recentOutput?.at(-1);
	return `Agent: ${statusIcon(agent.status)} ${agent.taskId} ${agent.role}->${agent.agent}${stats.length ? ` · ${stats.join(" · ")}` : ""}${recent ? ` ⎿ ${recent}` : ""}`;
}

function readAgentPreview(run: TeamRunManifest, maxLines = 5, options: RunDashboardOptions = {}): string[] {
	try {
		const agents = readCrewAgents(run);
		const tasks = readRunTasks(run);
		if (!agents.length) return ["Agents: (none)"];
		const totals = tasks.reduce((acc, task) => {
			acc.input += task.usage?.input ?? 0;
			acc.output += task.usage?.output ?? 0;
			acc.cacheRead += task.usage?.cacheRead ?? 0;
			acc.cacheWrite += task.usage?.cacheWrite ?? 0;
			acc.cost += task.usage?.cost ?? 0;
			return acc;
		}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
		const header = formatTokens(totals) ? `Agents: ${formatTokens(totals)}` : "Agents:";
		return [header, ...agents.slice(0, maxLines).map((agent) => agentPreviewLine(agent, taskForAgent(tasks, agent), options)), ...(agents.length > maxLines ? [`Agents: +${agents.length - maxLines} more`] : [])];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [`Agents: failed to read (${message})`];
	}
}

function agentsFor(run: TeamRunManifest): CrewAgentRecord[] {
	try { return readCrewAgents(run); } catch { return []; }
}

function runLabel(run: TeamRunManifest, selected: boolean): string {
	const agents = agentsFor(run);
	const stale = isLikelyOrphanedActiveRun(run, agents);
	const running = agents.find((agent) => agent.status === "running");
	const queued = agents.find((agent) => agent.status === "queued");
	const step = stale ? "orphaned queued run" : running ? `step ${running.taskId}` : queued ? `queued ${queued.taskId}` : `agents ${agents.length}`;
	const status = stale ? "stale" : run.status;
	const marker = selected ? "›" : " ";
	return `${marker} ${statusIcon(status)} ${run.runId.slice(-8)} ${status} | ${run.team}/${run.workflow ?? "none"} | ${step} | ${run.goal}`;
}

function groupedRuns(runs: TeamRunManifest[]): Array<{ label: string; run?: TeamRunManifest }> {
	const active = runs.filter((run) => isDisplayActiveRun(run, agentsFor(run)));
	const recent = runs.filter((run) => !isDisplayActiveRun(run, agentsFor(run)));
	const rows: Array<{ label: string; run?: TeamRunManifest }> = [];
	if (active.length) rows.push({ label: "Active" }, ...active.map((run) => ({ label: run.runId, run })));
	if (recent.length) rows.push({ label: "Recent" }, ...recent.map((run) => ({ label: run.runId, run })));
	return rows;
}

function selectedRunFromGrouped(runs: TeamRunManifest[], selected: number): TeamRunManifest | undefined {
	return groupedRuns(runs).filter((row) => row.run)[selected]?.run;
}

function countByStatus(runs: TeamRunManifest[]): string {
	const counts = new Map<string, number>();
	for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
	return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none";
}

export class RunDashboard implements DashboardComponent {
	private selected = 0;
	private showFullProgress = false;
	private readonly runs: TeamRunManifest[];
	private readonly done: (selection: RunDashboardSelection | undefined) => void;
	private readonly theme: DashboardTheme;
	private readonly options: RunDashboardOptions;

	constructor(runs: TeamRunManifest[], done: (selection: RunDashboardSelection | undefined) => void, theme: unknown = {}, options: RunDashboardOptions = {}) {
		this.runs = runs;
		this.done = done;
		this.theme = theme as DashboardTheme;
		this.options = options;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const fg = this.theme.fg?.bind(this.theme) ?? ((_color: string, text: string) => text);
		const bold = this.theme.bold?.bind(this.theme) ?? ((text: string) => text);
		const innerWidth = Math.max(20, width - 4);
		const borderWidth = Math.min(innerWidth, Math.max(0, width - 2));
		const border = (text: string) => fg("border", text);
		const lines = [
			border(`╭${"─".repeat(borderWidth)}╮`),
			`│ ${padVisible(truncate(`${fg("accent", "●")} ${bold("pi-crew dashboard")}`, innerWidth - 1), innerWidth - 1)}│`,
			`│ ${padVisible(truncate(fg("dim", "↑/↓/j/k select • r reload • p progress • s/u/a/i actions • d agents • e/v/o viewers • q close"), innerWidth - 1), innerWidth - 1)}│`,
			`│ ${padVisible(truncate(`Runs: ${this.runs.length} • ${countByStatus(this.runs)}`, innerWidth - 1), innerWidth - 1)}│`,
			border(`├${"─".repeat(borderWidth)}┤`),
		];
		if (this.runs.length === 0) {
			lines.push(`│ ${padVisible(truncate("No runs found.", innerWidth - 1), innerWidth - 1)}│`);
		} else {
			const rows = groupedRuns(this.runs).slice(0, 16);
			const runRows = rows.filter((row) => row.run);
			for (const row of rows) {
				if (!row.run) {
					lines.push(`│ ${padVisible(truncate(fg("accent", row.label), innerWidth - 1), innerWidth - 1)}│`);
					continue;
				}
				const index = runRows.findIndex((candidate) => candidate.run?.runId === row.run?.runId);
				const label = runLabel(row.run, index === this.selected);
				const status = isLikelyOrphanedActiveRun(row.run, agentsFor(row.run)) ? "stale" : row.run.status;
				lines.push(`│ ${padVisible(truncate(fg(colorForStatus(status), label), innerWidth - 1), innerWidth - 1)}│`);
			}
			const selectedRun = selectedRunFromGrouped(this.runs, this.selected);
			if (selectedRun) {
				lines.push(border(`├${"─".repeat(borderWidth)}┤`));
				const details = [
					`Selected: ${selectedRun.runId}`,
					`Status: ${selectedRun.status} | Team: ${selectedRun.team} | Workflow: ${selectedRun.workflow ?? "none"}`,
					`Created: ${selectedRun.createdAt}`,
					`Updated: ${selectedRun.updatedAt}`,
					`Artifacts: ${selectedRun.artifacts.length} | Workspace: ${selectedRun.workspaceMode}`,
					selectedRun.async ? `Async: pid=${selectedRun.async.pid ?? "unknown"} log=${selectedRun.async.logPath}` : "Async: no",
					`Goal: ${selectedRun.goal}`,
				];
				for (const detail of [...details, ...readAgentPreview(selectedRun, this.showFullProgress ? 20 : 8, this.options), ...readProgressPreview(selectedRun, this.showFullProgress ? 20 : 5)]) {
					lines.push(`│ ${padVisible(truncate(detail, innerWidth - 1), innerWidth - 1)}│`);
				}
			}
		}
		lines.push(border(`╰${"─".repeat(borderWidth)}╯`));
		return lines.map((line) => truncate(line, width));
	}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b") {
			this.done(undefined);
			return;
		}
		if (data === "\r" || data === "\n" || data === "s") {
			const runId = selectedRunFromGrouped(this.runs, this.selected)?.runId;
			this.done(runId ? { runId, action: "status" } : undefined);
			return;
		}
		if (data === "u") {
			const runId = selectedRunFromGrouped(this.runs, this.selected)?.runId;
			this.done(runId ? { runId, action: "summary" } : undefined);
			return;
		}
		if (data === "a") {
			const runId = selectedRunFromGrouped(this.runs, this.selected)?.runId;
			this.done(runId ? { runId, action: "artifacts" } : undefined);
			return;
		}
		if (data === "i") {
			const runId = selectedRunFromGrouped(this.runs, this.selected)?.runId;
			this.done(runId ? { runId, action: "api" } : undefined);
			return;
		}
		if (data === "d") {
			const runId = selectedRunFromGrouped(this.runs, this.selected)?.runId;
			this.done(runId ? { runId, action: "agents" } : undefined);
			return;
		}
		if (data === "e") {
			const runId = selectedRunFromGrouped(this.runs, this.selected)?.runId;
			this.done(runId ? { runId, action: "agent-events" } : undefined);
			return;
		}
		if (data === "o") {
			const runId = selectedRunFromGrouped(this.runs, this.selected)?.runId;
			this.done(runId ? { runId, action: "agent-output" } : undefined);
			return;
		}
		if (data === "v") {
			const runId = selectedRunFromGrouped(this.runs, this.selected)?.runId;
			this.done(runId ? { runId, action: "agent-transcript" } : undefined);
			return;
		}
		if (data === "r") {
			this.done({ runId: selectedRunFromGrouped(this.runs, this.selected)?.runId ?? "", action: "reload" });
			return;
		}
		if (data === "p") {
			this.showFullProgress = !this.showFullProgress;
			return;
		}
		if (data === "k" || data === "\u001b[A") {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (data === "j" || data === "\u001b[B") {
			const selectableCount = groupedRuns(this.runs).filter((row) => row.run).length;
			this.selected = Math.min(Math.max(0, selectableCount - 1), this.selected + 1);
		}
	}
}
