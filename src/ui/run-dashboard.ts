import * as fs from "node:fs";
import type { TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import { isDisplayActiveRun, isLikelyOrphanedActiveRun } from "../runtime/process-status.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "./theme-adapter.ts";
import { applyStatusColor, iconForStatus, type RunStatus } from "./status-colors.ts";
import { pad, truncate } from "../utils/visual.ts";
import { Box, Text } from "./layout-primitives.ts";
import { DynamicCrewBorder } from "./dynamic-border.ts";
import { CrewFooter } from "./crew-footer.ts";
import { aggregateUsage } from "../state/usage.ts";
import { renderAgentsPane } from "./dashboard-panes/agents-pane.ts";
import { renderMailboxPane } from "./dashboard-panes/mailbox-pane.ts";
import { renderProgressPane } from "./dashboard-panes/progress-pane.ts";
import { renderTranscriptPane } from "./dashboard-panes/transcript-pane.ts";
import { renderHealthPane } from "./dashboard-panes/health-pane.ts";
import { renderMetricsPane } from "./dashboard-panes/metrics-pane.ts";
import { dashboardActionForKey } from "./keybinding-map.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "./snapshot-types.ts";
import { spinnerBucket, spinnerFrame } from "./spinner.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";

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
	snapshotCache?: RunSnapshotCache;
	runProvider?: () => TeamRunManifest[];
	registry?: MetricRegistry;
}

export type RunDashboardAction = "status" | "summary" | "artifacts" | "api" | "events" | "agents" | "agent-events" | "agent-output" | "agent-transcript" | "mailbox" | "reload" | "mailbox-detail" | "health-recovery" | "health-kill-stale" | "health-diagnostic-export" | "notifications-dismiss";
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

function snapshotFor(run: TeamRunManifest, snapshotCache?: RunSnapshotCache): RunUiSnapshot | undefined {
	try {
		return snapshotCache?.refreshIfStale(run.runId);
	} catch {
		return snapshotCache?.get(run.runId);
	}
}

function readRunTasks(run: TeamRunManifest, snapshotCache?: RunSnapshotCache): TeamTaskState[] {
	const snapshot = snapshotFor(run, snapshotCache);
	if (snapshot) return snapshot.tasks;
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
	const icon = iconForStatus(agent.status, { runningGlyph: spinnerFrame(agent.taskId) });
	return `Agent: ${icon} ${agent.taskId} ${agent.role}->${agent.agent}${stats.length ? ` · ${stats.join(" · ")}` : ""}${recent ? ` ⎿ ${recent}` : ""}`;
}

function readAgentPreview(run: TeamRunManifest, maxLines = 5, options: RunDashboardOptions = {}): string[] {
	try {
		const snapshot = snapshotFor(run, options.snapshotCache);
		const agents = snapshot?.agents ?? readCrewAgents(run);
		const tasks = snapshot?.tasks ?? readRunTasks(run, options.snapshotCache);
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

function agentsFor(run: TeamRunManifest, snapshotCache?: RunSnapshotCache): CrewAgentRecord[] {
	const snapshot = snapshotFor(run, snapshotCache);
	if (snapshot) return snapshot.agents;
	try {
		return readCrewAgents(run);
	} catch {
		return [];
	}
}

function runLabel(run: TeamRunManifest, selected: boolean, snapshotCache?: RunSnapshotCache): string {
	const agents = agentsFor(run, snapshotCache);
	const stale = isLikelyOrphanedActiveRun(run, agents);
	const running = agents.find((agent) => agent.status === "running");
	const queued = agents.find((agent) => agent.status === "queued");
	const step = stale ? "orphaned queued run" : running ? `step ${running.taskId}` : queued ? `queued ${queued.taskId}` : `agents ${agents.length}`;
	const status: RunStatus = stale ? "stale" : (run.status as RunStatus);
	const marker = selected ? "›" : " ";
	return `${marker} ${iconForStatus(status, { runningGlyph: spinnerFrame(run.runId) })} ${run.runId.slice(-8)} ${status} | ${run.team}/${run.workflow ?? "none"} | ${step} | ${run.goal}`;
}

function groupedRuns(runs: TeamRunManifest[], snapshotCache?: RunSnapshotCache): Array<{ label: string; run?: TeamRunManifest }> {
	const active = runs.filter((run) => isDisplayActiveRun(snapshotFor(run, snapshotCache)?.manifest ?? run, agentsFor(run, snapshotCache)));
	const recent = runs.filter((run) => !isDisplayActiveRun(snapshotFor(run, snapshotCache)?.manifest ?? run, agentsFor(run, snapshotCache)));
	const rows: Array<{ label: string; run?: TeamRunManifest }> = [];
	if (active.length) rows.push({ label: "Active" }, ...active.map((run) => ({ label: run.runId, run })));
	if (recent.length) rows.push({ label: "Recent" }, ...recent.map((run) => ({ label: run.runId, run })));
	return rows;
}

function selectedRunFromGrouped(runs: TeamRunManifest[], selected: number, snapshotCache?: RunSnapshotCache): TeamRunManifest | undefined {
	return groupedRuns(runs, snapshotCache).filter((row) => row.run)[selected]?.run;
}

function countByStatus(runs: TeamRunManifest[], snapshotCache?: RunSnapshotCache): string {
	const counts = new Map<RunStatus, number>();
	for (const run of runs) {
		const snapshot = snapshotFor(run, snapshotCache);
		const displayRun = snapshot?.manifest ?? run;
		const status: RunStatus = isLikelyOrphanedActiveRun(displayRun, snapshot?.agents ?? agentsFor(run, snapshotCache)) ? "stale" : (displayRun.status as RunStatus);
		counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none";
}

export class RunDashboard implements DashboardComponent {
	private selected = 0;
	private showFullProgress = false;
	private activePane: "agents" | "progress" | "mailbox" | "output" | "health" | "metrics" = "agents";
	private runs: TeamRunManifest[];
	private readonly done: (selection: RunDashboardSelection | undefined) => void;
	private readonly theme: CrewTheme;
	private readonly options: RunDashboardOptions;
	private cachedWidth = 0;
	private cachedVersion = "";
	private cachedLines: string[] = [];
	private readonly unsubscribeTheme: () => void;

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
		this.unsubscribeTheme = subscribeThemeChange(theme, () => this.invalidate());
	}

	private refreshRuns(): void {
		if (!this.options.runProvider) return;
		const selectedRunId = this.selectedRunId();
		this.runs = this.options.runProvider();
		if (selectedRunId) {
			const nextIndex = groupedRuns(this.runs, this.options.snapshotCache).filter((row) => row.run).findIndex((row) => row.run?.runId === selectedRunId);
			if (nextIndex >= 0) this.selected = nextIndex;
		}
	}

	private buildSignature(): string {
		let hasRunning = false;
		const statuses = this.runs.map((run) => {
			const snapshot = snapshotFor(run, this.options.snapshotCache);
			const displayRun = snapshot?.manifest ?? run;
			const agents = snapshot?.agents ?? agentsFor(run, this.options.snapshotCache);
			const stale = isLikelyOrphanedActiveRun(displayRun, agents);
			const status: RunStatus = stale ? "stale" : (displayRun.status as RunStatus);
			if (status === "running" || agents.some((agent) => agent.status === "running")) hasRunning = true;
			return snapshot?.signature ?? `${displayRun.runId}:${displayRun.status}:${displayRun.updatedAt}:${status}`;
		}).join("|");
		const metricsSig = this.activePane === "metrics" ? `:metrics=${this.options.registry?.snapshot().length ?? 0}:${spinnerBucket()}` : "";
		return `${this.selected}:${this.showFullProgress ? 1 : 0}:${this.activePane}:${statuses}${hasRunning ? `:spin=${spinnerBucket()}` : ""}${metricsSig}`;
	}

	invalidate(): void {
		this.cachedVersion = "";
		this.cachedLines = [];
	}

	dispose(): void {
		this.unsubscribeTheme();
	}

	private selectedRunId(): string | undefined {
		return selectedRunFromGrouped(this.runs, this.selected, this.options.snapshotCache)?.runId;
	}

	render(width: number): string[] {
		this.refreshRuns();
		const signature = this.buildSignature();
		if (signature !== this.cachedVersion || this.cachedWidth !== width) {
			const innerWidth = Math.max(20, width - 4);
			const borderWidth = Math.min(innerWidth, Math.max(0, width - 2));
			const fg = (color: Parameters<CrewTheme["fg"]>[0], text: string) => this.theme.fg(color, text);
			const borderFill = (count: number) => new DynamicCrewBorder(this.theme).render(count)[0];
			const border = (left: string, right: string) => `${fg("border", left)}${borderFill(borderWidth)}${fg("border", right)}`;
			
			const lines = [
				border("╭", "╮"),
				`│ ${pad(truncate(`${fg("accent", "▐")} ${this.theme.bold(this.options.placement === "right" ? "pi-crew right sidebar (anchored top-right)" : "pi-crew dashboard")}`, innerWidth - 1), innerWidth - 1)}│`,
				`│ ${pad(truncate(`Runs: ${this.runs.length} • ${countByStatus(this.runs, this.options.snapshotCache)}`, innerWidth - 1), innerWidth - 1)}│`,
				`│ ${pad(truncate(`↑/↓ select • 1 agents 2 progress 3 mailbox 4 output 5 health 6 metrics • s/u/a/i actions • R/K/D health • H hush`, innerWidth - 1), innerWidth - 1)}│`,
				border("├", "┤"),
			];
			if (this.runs.length === 0) {
				lines.push(`│ ${pad(truncate("No runs found.", innerWidth - 1), innerWidth - 1)}│`);
			} else {
				const rows = groupedRuns(this.runs, this.options.snapshotCache).slice(0, 16);
				const selectableRuns = rows.filter((row) => row.run);
				for (const row of rows) {
					if (!row.run) {
						lines.push(`│ ${pad(truncate(fg("accent", row.label), innerWidth - 1), innerWidth - 1)}│`);
						continue;
					}
					const index = selectableRuns.findIndex((candidate) => candidate.run?.runId === row.run?.runId);
					const rowSnapshot = snapshotFor(row.run, this.options.snapshotCache);
					const rowRun = rowSnapshot?.manifest ?? row.run;
					const rowAgents = rowSnapshot?.agents ?? agentsFor(row.run, this.options.snapshotCache);
					const rowStatus = isLikelyOrphanedActiveRun(rowRun, rowAgents) ? "stale" : (rowRun.status as RunStatus);
					const label = runLabel(rowRun, index === this.selected, this.options.snapshotCache);
					lines.push(`│ ${pad(applyStatusColor(this.theme, rowStatus, label), innerWidth - 1)}│`);
				}
				const selectedRun = selectedRunFromGrouped(this.runs, this.selected, this.options.snapshotCache);
				if (selectedRun) {
					const selectedSnapshot = snapshotFor(selectedRun, this.options.snapshotCache);
					const selectedDisplayRun = selectedSnapshot?.manifest ?? selectedRun;
					const selectedAgents = selectedSnapshot?.agents ?? agentsFor(selectedRun, this.options.snapshotCache);
					lines.push(border("├", "┤"));
					const details = [
						`Selected: ${selectedDisplayRun.runId}`,
						`Status: ${isLikelyOrphanedActiveRun(selectedDisplayRun, selectedAgents) ? "stale" : selectedDisplayRun.status} | Team: ${selectedDisplayRun.team} | Workflow: ${selectedDisplayRun.workflow ?? "none"}`,
						`Created: ${selectedDisplayRun.createdAt}`,
						`Updated: ${selectedDisplayRun.updatedAt}`,
						`Artifacts: ${selectedDisplayRun.artifacts.length} | Workspace: ${selectedDisplayRun.workspaceMode}`,
						selectedDisplayRun.async ? `Async: pid=${selectedDisplayRun.async.pid ?? "unknown"} log=${selectedDisplayRun.async.logPath}` : "Async: no",
						`Goal: ${selectedDisplayRun.goal}`,
					];
					const paneLines = selectedSnapshot
						? this.activePane === "agents"
							? renderAgentsPane(selectedSnapshot, this.options)
							: this.activePane === "progress"
								? renderProgressPane(selectedSnapshot)
								: this.activePane === "mailbox"
									? renderMailboxPane(selectedSnapshot)
									: this.activePane === "health"
										? renderHealthPane(selectedSnapshot, { isForeground: selectedDisplayRun.async ? false : true })
										: this.activePane === "metrics"
											? renderMetricsPane(selectedSnapshot, { registry: this.options.registry })
											: renderTranscriptPane(selectedSnapshot)
						: [
							...readAgentPreview(selectedDisplayRun, this.showFullProgress ? 20 : 8, this.options),
							...readProgressPreview(selectedDisplayRun, this.showFullProgress ? 20 : 5),
						];
					for (const detail of [
						...details,
						`Pane: ${this.activePane}`,
						...paneLines,
						...(this.showFullProgress ? readProgressPreview(selectedDisplayRun, 20) : []),
					]) {
						lines.push(`│ ${pad(truncate(detail, innerWidth - 1), innerWidth - 1)}│`);
					}
					const selectedTasks = selectedSnapshot?.tasks ?? readRunTasks(selectedDisplayRun, this.options.snapshotCache);
					const footer = new CrewFooter({
						pwd: selectedDisplayRun.cwd,
						runId: selectedDisplayRun.runId,
						status: isLikelyOrphanedActiveRun(selectedDisplayRun, selectedAgents) ? "stale" : selectedDisplayRun.status,
						usage: aggregateUsage(selectedTasks),
						badges: [`team ${selectedDisplayRun.team}`, `workflow ${selectedDisplayRun.workflow ?? "none"}`, `${selectedDisplayRun.artifacts.length} artifacts`, selectedDisplayRun.workspaceMode],
					}, this.theme);
					lines.push(border("├", "┤"));
					for (const footerLine of footer.render(innerWidth - 1)) {
						lines.push(`│ ${pad(truncate(footerLine, innerWidth - 1), innerWidth - 1)}│`);
					}
				}
			}
			lines.push(border("╰", "╯"));
			this.cachedLines = renderLines(lines.map((line) => truncate(line, width)), width);
			this.cachedVersion = signature;
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}

	handleInput(data: string): void {
		const action = dashboardActionForKey(data, this.activePane);
		const selectedRunId = this.selectedRunId();
		if (action === "close") {
			this.done(undefined);
			return;
		}
		if (action === "select") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "status" } : undefined);
			return;
		}
		if (action === "summary" || action === "artifacts" || action === "api" || action === "agents" || action === "mailbox" || action === "reload" || action === "mailbox-detail" || action === "health-recovery" || action === "health-kill-stale" || action === "health-diagnostic-export" || action === "notifications-dismiss") {
			this.done(selectedRunId ? { runId: selectedRunId, action } : action === "reload" ? { runId: "", action } : undefined);
			return;
		}
		if (action === "events") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "agent-events" } : undefined);
			return;
		}
		if (action === "output") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "agent-output" } : undefined);
			return;
		}
		if (action === "transcript") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "agent-transcript" } : undefined);
			return;
		}
		if (action === "progressToggle") {
			this.showFullProgress = !this.showFullProgress;
			this.invalidate();
			return;
		}
		if (action === "pane-agents") this.activePane = "agents";
		else if (action === "pane-progress") this.activePane = "progress";
		else if (action === "pane-mailbox") this.activePane = "mailbox";
		else if (action === "pane-output") this.activePane = "output";
		else if (action === "pane-health") this.activePane = "health";
		else if (action === "pane-metrics") this.activePane = "metrics";
		else if (action === "up") this.selected = Math.max(0, this.selected - 1);
		else if (action === "down") {
			const selectableCount = groupedRuns(this.runs, this.options.snapshotCache).filter((row) => row.run).length;
			this.selected = Math.min(Math.max(0, selectableCount - 1), this.selected + 1);
		}
		if (action) this.invalidate();
	}
}
