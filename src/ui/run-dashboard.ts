import * as fs from "node:fs";
import type { TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { getLiveAgentContextPercent } from "../runtime/live-agent-manager.ts";
import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import { isDisplayActiveRun, isLikelyOrphanedActiveRun } from "../runtime/process-status.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "./theme-adapter.ts";
import { applyStatusColor, iconForStatus, type RunStatus } from "./status-colors.ts";
import { pad, truncate, sanitizeLine } from "../utils/visual.ts";
import { Box, Text } from "./layout-primitives.ts";
import { DynamicCrewBorder } from "./dynamic-border.ts";
import { aggregateUsage } from "../state/usage.ts";
import { logInternalError } from "../utils/internal-error.ts";
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
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { runEventBus } from "./run-event-bus.ts";

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
	/**
	 * Workspace/session ID for filtering runs and live agents. When provided,
	 * only runs with matching ownerSessionId and live agents with matching
	 * workspaceId are shown. This ensures session isolation in the UI.
	 */
	workspaceId?: string;
	/**
	 * Poke the host TUI to repaint after a state change. Must be wired from
	 * `commands.ts` (`() => requestRenderTarget(tui)`) so keypresses and event-bus
	 * updates immediately refresh the overlay instead of waiting on the next
	 * host tick. Without this the overlay can desync and base content (chat,
	 * status line) can paint through stale cells.
	 */
	requestRender?: () => void;
}

/**
 * Persisted per-process so that pressing `r` (reload) or closing+reopening the
 * dashboard within the same Pi session keeps the user on the pane they were
 * looking at. Resetting to "agents" on every `new RunDashboard(...)` was a
 * UX regression.
 */
let lastActivePane: "agents" | "progress" | "mailbox" | "output" | "health" | "metrics" = "agents";

export type RunDashboardAction = "status" | "summary" | "artifacts" | "api" | "events" | "agents" | "agent-events" | "agent-output" | "agent-transcript" | "agent-live" | "mailbox" | "reload" | "mailbox-detail" | "health-recovery" | "health-kill-stale" | "health-diagnostic-export" | "notifications-dismiss";
export interface RunDashboardSelection {
	runId: string;
	action: RunDashboardAction;
}

const TASK_READ_TTL_MS = 1000;

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
	if (!progress) return ["Progress: (none)"];
	try {
		const progressPath = resolveRealContainedPath(run.artifactsRoot, progress.path);
		if (!fs.existsSync(progressPath)) return ["Progress: (none)"];
		return ["Progress:", ...fs.readFileSync(progressPath, "utf-8").split(/\r?\n/).filter(Boolean).slice(0, maxLines)];
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
	return sanitizeLine(`Agent: ${icon} ${agent.taskId} ${agent.role}->${agent.agent}${stats.length ? ` · ${stats.join(" · ")}` : ""}${recent ? ` ⎿ ${recent}` : ""}`);
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
	return sanitizeLine(`${marker} ${iconForStatus(status, { runningGlyph: spinnerFrame(run.runId) })} ${run.runId.slice(-8)} ${status} | ${run.team}/${run.workflow ?? "none"} | ${step} | ${run.goal}`);
}

interface ResolvedRun {
	manifest: TeamRunManifest;
	snapshot: RunUiSnapshot | undefined;
	agents: CrewAgentRecord[];
	status: RunStatus;
}

function resolveRuns(runs: TeamRunManifest[], snapshotCache?: RunSnapshotCache): Map<string, ResolvedRun> {
	const map = new Map<string, ResolvedRun>();
	for (const run of runs) {
		const snapshot = snapshotFor(run, snapshotCache);
		const agents = snapshot?.agents ?? agentsFor(run, snapshotCache);
		const displayRun = snapshot?.manifest ?? run;
		const status: RunStatus = isLikelyOrphanedActiveRun(displayRun, agents) ? "stale" : (displayRun.status as RunStatus);
		map.set(run.runId, { manifest: run, snapshot, agents, status });
	}
	return map;
}

function groupedRuns(runs: TeamRunManifest[], snapshotCache?: RunSnapshotCache): Array<{ label: string; run?: TeamRunManifest }> {
	const resolved = resolveRuns(runs, snapshotCache);
	const rows: Array<{ label: string; run?: TeamRunManifest }> = [];
	const active = runs.filter((run) => isDisplayActiveRun(resolved.get(run.runId)?.snapshot?.manifest ?? run, resolved.get(run.runId)?.agents ?? []));
	const rest = runs.filter((run) => !isDisplayActiveRun(resolved.get(run.runId)?.snapshot?.manifest ?? run, resolved.get(run.runId)?.agents ?? []));
	if (active.length) rows.push({ label: "Active" }, ...active.map((run) => ({ label: run.runId, run })));
	if (rest.length) rows.push({ label: "Recent" }, ...rest.map((run) => ({ label: run.runId, run })));
	return rows;
}

function selectedRunFromGrouped(runs: TeamRunManifest[], selected: number, snapshotCache?: RunSnapshotCache): TeamRunManifest | undefined {
	return groupedRuns(runs, snapshotCache).filter((row) => row.run)[selected]?.run;
}

function countByStatus(runs: TeamRunManifest[], snapshotCache?: RunSnapshotCache): string {
	const resolved = resolveRuns(runs, snapshotCache);
	const counts = new Map<RunStatus, number>();
	for (const r of resolved.values()) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
	return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none";
}

export class RunDashboard implements DashboardComponent {
	private selected = 0;
	private showFullProgress = false;
	private activePane: "agents" | "progress" | "mailbox" | "output" | "health" | "metrics" = lastActivePane;
	private runs: TeamRunManifest[];
	private readonly done: (selection: RunDashboardSelection | undefined) => void;
	private readonly theme: CrewTheme;
	private readonly options: RunDashboardOptions;
	private cachedWidth = 0;
	private cachedVersion = "";
	private cachedLines: string[] = [];
	private readonly unsubscribeTheme: () => void;
	private readonly unsubscribeEventBus: () => void;

	constructor(
		runs: TeamRunManifest[],
		done: (selection: RunDashboardSelection | undefined) => void,
		theme: unknown = {},
		options: RunDashboardOptions = {},
	) {
		// Filter runs by workspaceId for session isolation
		// If workspaceId is provided, only show runs owned by that session or runs with no owner (legacy)
		const filteredRuns = options.workspaceId
			? runs.filter((run) => !run.ownerSessionId || run.ownerSessionId === options.workspaceId)
			: runs;
		this.runs = filteredRuns;
		this.done = done;
		this.theme = asCrewTheme(theme);
		this.options = options;
		this.unsubscribeTheme = subscribeThemeChange(theme, () => this.invalidateAndRender());
		this.unsubscribeEventBus = runEventBus.onAny(() => this.invalidateAndRender());
	}

	/**
	 * Invalidate the layout cache AND poke the host TUI to repaint. Without
	 * the explicit `requestRender` call the host only repaints on its own
	 * tick / on keypress, so async events (subagent completed, mailbox
	 * updates, theme change) would leave the overlay showing stale data
	 * until the user pressed a key — which is exactly when the "cascading
	 * dashboard" symptom surfaces because the diff renderer was comparing
	 * against a stale `previousLines` snapshot.
	 */
	private invalidateAndRender(): void {
		this.invalidate();
		try { this.options.requestRender?.(); } catch { /* host may not expose requestRender */ }
	}

	/**
	 * Stable overlay height. The host pi-tui positions overlays based on the
	 * number of lines `render()` returns; if that number fluctuates between
	 * frames (empty state → full pane → fewer agents) the anchor row shifts
	 * up/down and the differential renderer cannot reliably erase the
	 * previous footprint, producing the "ghost dashboard below" bug.
	 *
	 * Locking the output to a single height per render eliminates that.
	 */
	private targetHeight(): number {
		const rows = Number.isFinite(process.stdout?.rows) ? Number(process.stdout?.rows) : 30;
		return Math.max(12, Math.min(36, rows - 2));
	}

	private refreshRuns(): void {
		if (!this.options.runProvider) return;
		const selectedRunId = this.selectedRunId();
		const next = this.options.runProvider();
		this.runs = Array.isArray(next) ? next : this.runs;
		if (selectedRunId) {
			const nextIndex = groupedRuns(this.runs, this.options.snapshotCache).filter((row) => row.run).findIndex((row) => row.run?.runId === selectedRunId);
			if (nextIndex >= 0) this.selected = nextIndex;
			else this.selected = 0;
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
		this.unsubscribeEventBus();
	}

	private selectedRunId(): string | undefined {
		return selectedRunFromGrouped(this.runs, this.selected, this.options.snapshotCache)?.runId;
	}

	render(width: number): string[] {
		try {
			return this.renderUnsafe(width);
		} catch (error) {
			logInternalError("run-dashboard.render", error);
			return renderLines(["Dashboard error — see logs for details."], width);
		}
	}

	private renderUnsafe(width: number): string[] {
		this.refreshRuns();
		const signature = this.buildSignature();
		if (signature !== this.cachedVersion || this.cachedWidth !== width) {
			const innerWidth = Math.max(20, width - 4);
			const borderWidth = Math.min(innerWidth, Math.max(0, width - 2));
			const fg = (color: Parameters<CrewTheme["fg"]>[0], text: string) => this.theme.fg(color, text);
			const borderFill = (count: number) => new DynamicCrewBorder(this.theme).render(count)[0];
			const border = (left: string, right: string) => `${fg("border", left)}${borderFill(borderWidth)}${fg("border", right)}`;
			const row = (text: string) => `│ ${pad(truncate(text, innerWidth - 1), innerWidth - 1)}│`;
			const sep = () => border("├", "┤");
			
			const lines: string[] = [
				border("╭", "╮"),
				row(`${fg("accent", "▐")} ${this.theme.bold("pi-crew")} · ${this.runs.length} runs  ${fg("dim", "1-6 pane · ↑↓ · Enter · Esc")}`),
				sep(),
			];

			if (this.runs.length === 0) {
				lines.push(row(fg("dim", "No runs.")));
			} else {
				// Run list (max 8 lines)
				const rows = groupedRuns(this.runs, this.options.snapshotCache).slice(0, 8);
				const selectableRuns = rows.filter((r) => r.run);
				for (const r of rows) {
					if (!r.run) { lines.push(row(fg("dim", `── ${r.label} ──`))); continue; }
					const idx = selectableRuns.findIndex((c) => c.run?.runId === r.run?.runId);
					const snap = snapshotFor(r.run, this.options.snapshotCache);
					const run = snap?.manifest ?? r.run;
					const agents = snap?.agents ?? agentsFor(r.run, this.options.snapshotCache);
					const status: RunStatus = isLikelyOrphanedActiveRun(run, agents) ? "stale" : (run.status as RunStatus);
					const label = runLabel(run, idx === this.selected, this.options.snapshotCache);
					lines.push(row(applyStatusColor(this.theme, status, label)));
				}

				// Selected run detail — compact
				const selectedRun = selectedRunFromGrouped(this.runs, this.selected, this.options.snapshotCache);
				if (selectedRun) {
					const snap = snapshotFor(selectedRun, this.options.snapshotCache);
					const r = snap?.manifest ?? selectedRun;
					const agents = snap?.agents ?? agentsFor(selectedRun, this.options.snapshotCache);
					const statusStr = isLikelyOrphanedActiveRun(r, agents) ? "stale" : r.status;
					lines.push(sep());
					lines.push(row(`${fg("accent", "▸")} ${truncate(sanitizeLine(r.goal), innerWidth - 6)}`));
					lines.push(row(fg("dim", sanitizeLine(`  ${r.team}/${r.workflow ?? "default"} · ${statusStr} · ${r.runId.slice(-10)}`))));

					// Pane content (max 8 lines)
					const paneLines = snap
						? this.activePane === "agents" ? renderAgentsPane(snap, this.options)
						: this.activePane === "progress" ? renderProgressPane(snap)
						: this.activePane === "mailbox" ? renderMailboxPane(snap)
						: this.activePane === "health" ? renderHealthPane(snap, { isForeground: !r.async })
						: this.activePane === "metrics" ? renderMetricsPane(snap, { registry: this.options.registry })
						: renderTranscriptPane(snap)
						: [
							...readAgentPreview(r, 4, this.options),
							...readProgressPreview(r, 2),
						];
					const filteredPane = paneLines.filter(l => l && !l.includes("(none)") && l.trim() !== "");
					if (filteredPane.length > 0) {
						lines.push(row(fg("dim", `── ${this.activePane} ──`)));
						for (const line of filteredPane.slice(0, 8)) {
							lines.push(row(truncate(sanitizeLine(line), innerWidth - 2)));
						}
					}

					// One-line footer
					const selectedTasks = snap?.tasks ?? readRunTasks(r, this.options.snapshotCache);
					const usage = aggregateUsage(selectedTasks);
					const u = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					const tok = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
					const tokStr = tok > 0 ? (tok >= 1000 ? `${(tok/1000).toFixed(1)}k tok` : `${tok} tok`) : "";
					let ctxPct: number | undefined;
					for (const agent of agents) {
						if (agent.status === "running" && agent.runtime === "live-session") {
							const pct = getLiveAgentContextPercent(agent.taskId);
							if (pct != null) { ctxPct = pct; break; }
						}
					}
					const ctxStr = ctxPct != null ? ` · ${Math.round(ctxPct)}% ctx` : "";
					if (tokStr || ctxStr) lines.push(row(fg("dim", `${tokStr}${ctxStr}`)));
				}
			}
			lines.push(border("╰", "╯"));

			const target = this.targetHeight();
			if (lines.length < target) {
				const innerWidth = Math.max(20, width - 4);
				const fg = (color: Parameters<CrewTheme["fg"]>[0], text: string) => this.theme.fg(color, text);
				const blankRow = `│ ${pad("", innerWidth - 1)}│`;
				const bottom = lines.pop();
				while (lines.length < target - 1) lines.push(fg("border", blankRow));
				if (bottom) lines.push(bottom);
			} else if (lines.length > target) {
				const bottom = lines[lines.length - 1];
				lines.length = target - 1;
				lines.push(bottom);
			}

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
		if (action === "live-conversation") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "agent-live" } : undefined);
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
		if (action) {
			lastActivePane = this.activePane;
			this.invalidateAndRender();
		}
	}
}
