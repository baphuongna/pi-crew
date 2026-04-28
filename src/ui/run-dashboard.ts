import * as fs from "node:fs";
import type { TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import { isDisplayActiveRun, isLikelyOrphanedActiveRun } from "../runtime/process-status.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme } from "./theme-adapter.ts";
import { applyStatusColor, iconForStatus, type RunStatus } from "./status-colors.ts";
import { pad, truncate } from "../utils/visual.ts";
import { Box, Text } from "./layout-primitives.ts";

interface DashboardComponent {
	invalidate(): void;
	render(width: number): string[];
	handleInput(data: string): void;
}

export interface RunDashboardOptions {
	placement?: "center" | "right";
	showModel?: boolean;
	showTokens?: boolean;
	showTools?: boolean;
}

export type RunDashboardAction = "status" | "summary" | "artifacts" | "api" | "events" | "agents" | "agent-events" | "agent-output" | "agent-transcript" | "reload";
export interface RunDashboardSelection {
	runId: string;
	action: RunDashboardAction;
}

const TASK_READ_TTL_MS = 200;

function formatAge(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const ms = Math.max(0, Date.now() - new Date(iso).getTime());
	if (!Number.isFinite(ms)) return undefined;
	if (ms < 1000) return "now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h`;
}

function renderLines(lines: string[], width: number): string[] {
	const box = new Box(0, 0);
	for (const line of lines) {
		box.addChild(new Text(line));
	}
	return box.render(width);
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

function readRunTasks(run: TeamRunManifest): TeamTaskState[] {
	const parse = () => {
		if (!fs.existsSync(run.tasksPath)) return [];
		const parsed = JSON.parse(fs.readFileSync(run.tasksPath, "utf-8"));
		return Array.isArray(parsed) ? (parsed as TeamTaskState[]) : [];
	};
	try {
		return readJsonFileCoalesced(run.tasksPath, TASK_READ_TTL_MS, parse);
	} catch {
		return [];
	}
}

function taskForAgent(tasks: TeamTaskState[], agent: CrewAgentRecord): TeamTaskState | undefined {
	return tasks.find((task) => task.id === agent.taskId);
}

function modelForTask(task: TeamTaskState | undefined): string | undefined {
	const attempts = task?.modelAttempts;
	if (!attempts?.length) return undefined;
	return attempts.find((attempt) => attempt.success)?.model ?? attempts.at(-1)?.model;
}

function modelForAgent(agent: CrewAgentRecord, task: TeamTaskState | undefined): string | undefined {
	return modelForTask(task) ?? agent.model;
}

function usageForAgent(agent: CrewAgentRecord, task: TeamTaskState | undefined): UsageState | undefined {
	return task?.usage ?? agent.usage;
}

function agentPreviewLine(agent: CrewAgentRecord, task: TeamTaskState | undefined, options: RunDashboardOptions): string {
	const stats = [
		agent.progress?.activityState,
		options.showModel !== false && modelForAgent(agent, task) ? `model=${modelForAgent(agent, task)}` : undefined,
		options.showTokens !== false
			? formatTokens(usageForAgent(agent, task)) ?? (agent.progress?.tokens !== undefined ? `tok=${agent.progress.tokens}` : undefined)
			: undefined,
		options.showTools !== false && agent.progress?.currentTool ? `tool=${agent.progress.currentTool}` : undefined,
		options.showTools !== false && agent.toolUses !== undefined ? `${agent.toolUses} tools` : undefined,
		agent.progress?.turns !== undefined ? `${agent.progress.turns} turns` : undefined,
		agent.progress?.failedTool ? `failedTool=${agent.progress.failedTool}` : undefined,
		agent.startedAt ? `age=${formatAge(agent.completedAt ?? agent.startedAt)}` : undefined,
	].filter((part): part is string => Boolean(part));
	const recent = agent.progress?.recentOutput?.at(-1);
	return `Agent: ${iconForStatus(agent.status)} ${agent.taskId} ${agent.role}->${agent.agent}${stats.length ? ` · ${stats.join(" · ")}` : ""}${recent ? ` ⎿ ${recent}` : ""}`;
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
		}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number });
		const header = formatTokens(totals) ? `Agents: ${formatTokens(totals)}` : "Agents:";
		return [
			header,
			...agents
				.slice(0, maxLines)
				.map((agent) => agentPreviewLine(agent, taskForAgent(tasks, agent), options)),
			...(agents.length > maxLines ? [`Agents: +${agents.length - maxLines} more`] : []),
		];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [`Agents: failed to read (${message})`];
	}
}

function agentsFor(run: TeamRunManifest): CrewAgentRecord[] {
	try {
		return readCrewAgents(run);
	} catch {
		return [];
	}
}

function runLabel(run: TeamRunManifest, selected: boolean): string {
	const agents = agentsFor(run);
	const stale = isLikelyOrphanedActiveRun(run, agents);
	const running = agents.find((agent) => agent.status === "running");
	const queued = agents.find((agent) => agent.status === "queued");
	const step = stale ? "orphaned queued run" : running ? `step ${running.taskId}` : queued ? `queued ${queued.taskId}` : `agents ${agents.length}`;
	const status: RunStatus = stale ? "stale" : (run.status as RunStatus);
	const marker = selected ? "›" : " ";
	return `${marker} ${iconForStatus(status)} ${run.runId.slice(-8)} ${status} | ${run.team}/${run.workflow ?? "none"} | ${step} | ${run.goal}`;
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
	const counts = new Map<RunStatus, number>();
	for (const run of runs) {
		const status: RunStatus = isLikelyOrphanedActiveRun(run, agentsFor(run)) ? "stale" : (run.status as RunStatus);
		counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none";
}

export class RunDashboard implements DashboardComponent {
	private selected = 0;
	private showFullProgress = false;
	private readonly runs: TeamRunManifest[];
	private readonly done: (selection: RunDashboardSelection | undefined) => void;
	private readonly theme: CrewTheme;
	private readonly options: RunDashboardOptions;
	private cachedWidth = 0;
	private cachedVersion = "";
	private cachedLines: string[] = [];

	constructor(
		runs: TeamRunManifest[],
		done: (selection: RunDashboardSelection | undefined) => void,
		theme: unknown = {},
		options: RunDashboardOptions = {},
	) {
		this.runs = runs;
		this.done = done;
		this.theme = asCrewTheme(theme);
		this.options = options;
	}

	private buildSignature(): string {
		const statuses = this.runs.map((run) => {
			const stale = isLikelyOrphanedActiveRun(run, agentsFor(run));
			const status: RunStatus = stale ? "stale" : (run.status as RunStatus);
			return `${run.runId}:${run.status}:${run.updatedAt}:${status}`;
		}).join("|");
		return `${this.selected}:${this.showFullProgress ? 1 : 0}:${statuses}`;
	}

	invalidate(): void {
		this.cachedVersion = "";
		this.cachedLines = [];
	}

	render(width: number): string[] {
		const signature = this.buildSignature();
		if (signature !== this.cachedVersion || this.cachedWidth !== width) {
			const innerWidth = Math.max(20, width - 4);
			const borderWidth = Math.min(innerWidth, Math.max(0, width - 2));
			const fg = (color: Parameters<CrewTheme["fg"]>[0], text: string) => this.theme.fg(color, text);
			const border = (text: string) => fg("border", text);
			
			const lines = [
				border(`╭${"─".repeat(borderWidth)}╮`),
				`│ ${pad(truncate(`${fg("accent", "▐")} ${this.theme.bold(this.options.placement === "right" ? "pi-crew right sidebar (anchored top-right)" : "pi-crew dashboard")}`, innerWidth - 1), innerWidth - 1)}│`,
				`│ ${pad(truncate(`Runs: ${this.runs.length} • ${countByStatus(this.runs)}`, innerWidth - 1), innerWidth - 1)}│`,
				`│ ${pad(truncate(`↑/↓/j/k select • r reload • p progress • s/u/a/i actions • d agents • e/v/o viewers • q close`, innerWidth - 1), innerWidth - 1)}│`,
				border(`├${"─".repeat(borderWidth)}┤`),
			];
			if (this.runs.length === 0) {
				lines.push(`│ ${pad(truncate("No runs found.", innerWidth - 1), innerWidth - 1)}│`);
			} else {
				const rows = groupedRuns(this.runs).slice(0, 16);
				const selectableRuns = rows.filter((row) => row.run);
				for (const row of rows) {
					if (!row.run) {
						lines.push(`│ ${pad(truncate(fg("accent", row.label), innerWidth - 1), innerWidth - 1)}│`);
						continue;
					}
					const index = selectableRuns.findIndex((candidate) => candidate.run?.runId === row.run?.runId);
					const rowStatus = isLikelyOrphanedActiveRun(row.run, agentsFor(row.run)) ? "stale" : (row.run.status as RunStatus);
					const label = runLabel(row.run, index === this.selected);
					lines.push(`│ ${pad(applyStatusColor(this.theme, rowStatus, label), innerWidth - 1)}│`);
				}
				const selectedRun = selectedRunFromGrouped(this.runs, this.selected);
				if (selectedRun) {
					lines.push(border(`├${"─".repeat(borderWidth)}┤`));
					const details = [
						`Selected: ${selectedRun.runId}`,
						`Status: ${isLikelyOrphanedActiveRun(selectedRun, agentsFor(selectedRun)) ? "stale" : selectedRun.status} | Team: ${selectedRun.team} | Workflow: ${selectedRun.workflow ?? "none"}`,
						`Created: ${selectedRun.createdAt}`,
						`Updated: ${selectedRun.updatedAt}`,
						`Artifacts: ${selectedRun.artifacts.length} | Workspace: ${selectedRun.workspaceMode}`,
						selectedRun.async ? `Async: pid=${selectedRun.async.pid ?? "unknown"} log=${selectedRun.async.logPath}` : "Async: no",
						`Goal: ${selectedRun.goal}`,
					];
					for (const detail of [
						...details,
						...readAgentPreview(selectedRun, this.showFullProgress ? 20 : 8, this.options),
						...readProgressPreview(selectedRun, this.showFullProgress ? 20 : 5),
					]) {
						lines.push(`│ ${pad(truncate(detail, innerWidth - 1), innerWidth - 1)}│`);
					}
				}
			}
			lines.push(border(`╰${"─".repeat(borderWidth)}╯`));
			this.cachedLines = renderLines(lines.map((line) => truncate(line, width)), width);
			this.cachedVersion = signature;
			this.cachedWidth = width;
		}
		return this.cachedLines;
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
