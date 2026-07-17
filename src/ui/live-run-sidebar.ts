import * as fs from "node:fs";
import type { CrewUiConfig } from "../config/config.ts";
import { applyAttentionState, resolveCrewControlConfig } from "../runtime/agent-control.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { formatTaskGraphLines, waitingReason } from "../runtime/task-display.ts";
import { loadRunManifestById } from "../state/state-store.ts";
import type { TeamTaskState } from "../state/types.ts";
import { aggregateUsage, formatUsage } from "../state/usage.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import { pad, truncate } from "../utils/visual.ts";
import { Box, Text } from "./layout-primitives.ts";
import { RenderScheduler } from "./render-scheduler.ts";
import { runEventBusAsRenderScheduler } from "./run-event-bus.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "./snapshot-types.ts";
import { spinnerBucket, spinnerFrame } from "./spinner.ts";
import { colorizeStatusGlyphs, iconForStatus } from "./status-colors.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "./theme-adapter.ts";

const TASK_READ_TTL_MS = 200;

function renderLines(lines: string[], width: number): string[] {
	const box = new Box(0, 0);
	for (const line of lines) {
		box.addChild(new Text(line));
	}
	return box.render(width);
}

type Done = (value: undefined) => void;

function line(text: string, width: number): string {
	return `│ ${pad(truncate(text, width - 4), width - 4)} │`;
}

function border(left: string, fill: string, right: string, width: number): string {
	return `${left}${fill.repeat(Math.max(0, width - 2))}${right}`;
}

function readTasks(path: string): TeamTaskState[] {
	const parse = () => {
		const parsed = JSON.parse(fs.readFileSync(path, "utf-8"));
		return Array.isArray(parsed) ? (parsed as TeamTaskState[]) : [];
	};
	try {
		return readJsonFileCoalesced(path, TASK_READ_TTL_MS, parse);
	} catch {
		return [];
	}
}

function shortUsage(tasks: TeamTaskState[]): string {
	const usage = aggregateUsage(tasks);
	return usage ? formatUsage(usage) : "usage=(none)";
}

export class LiveRunSidebar {
	private readonly cwd: string;
	private readonly runId: string;
	private readonly done: Done;
	private readonly theme: CrewTheme;
	private readonly config: CrewUiConfig;
	private readonly unsubscribeTheme: () => void;
	private readonly renderScheduler: RenderScheduler;
	private readonly snapshotCache?: RunSnapshotCache;
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private cachedSignature = "";
	private autoCloseTimeout?: NodeJS.Timeout;
	private hasAutoClosed = false;

	constructor(input: {
		cwd: string;
		runId: string;
		done: Done;
		theme?: unknown;
		config?: CrewUiConfig;
		snapshotCache?: RunSnapshotCache;
	}) {
		this.cwd = input.cwd;
		this.runId = input.runId;
		this.done = input.done;
		this.theme = asCrewTheme(input.theme);
		this.config = input.config ?? {};
		this.snapshotCache = input.snapshotCache;
		this.unsubscribeTheme = subscribeThemeChange(input.theme, () => this.invalidate());
		// 1.10 (UI-P1-1): route run:state / worker:lifecycle / ui:invalidate
		// through a RenderScheduler (debounce + fallback) instead of three
		// direct runEventBus.onChannel subscriptions. With 3 overlays
		// subscribing independently a single event triggered up to 9 callbacks
		// and ~150 invalidates/sec under load. The scheduler collapses bursts
		// into one debounced invalidate.
		this.renderScheduler = new RenderScheduler(
			runEventBusAsRenderScheduler(["run:state", "worker:lifecycle", "ui:invalidate"]),
			() => this.invalidate(),
			{
				debounceMs: 75,
				fallbackMs: 750,
				events: ["run:state", "worker:lifecycle", "ui:invalidate"],
			},
		);
	}

	private buildSignature(
		manifestStatus: string,
		tasks: TeamTaskState[],
		agents: ReturnType<typeof readCrewAgents>,
		waitingCount: number,
		snapshot?: RunUiSnapshot,
	): string {
		const animation = agents.some((agent) => agent.status === "running") ? `:spin=${spinnerBucket()}` : "";
		if (snapshot) return `${snapshot.signature}:${waitingCount}${animation}`;
		const taskSig = tasks
			.map(
				(task) =>
					`${task.id}:${task.status}:${task.startedAt ?? ""}:${task.finishedAt ?? ""}:${task.agentProgress?.currentTool ?? ""}:${task.agentProgress?.toolCount ?? 0}:${task.agentProgress?.tokens ?? 0}:${task.usage ? JSON.stringify(task.usage) : ""}`,
			)
			.join("|");
		const agentSig = agents
			.map((agent) =>
				[
					agent.id,
					agent.status,
					agent.startedAt,
					agent.completedAt ?? "",
					agent.progress?.currentTool ?? "",
					agent.progress?.toolCount ?? 0,
					agent.progress?.tokens ?? 0,
					agent.progress?.turns ?? 0,
					agent.progress?.lastActivityAt ?? "",
					agent.progress?.recentOutput?.at(-1) ?? "",
					agent.toolUses ?? 0,
				].join(":"),
			)
			.join("|");
		return `${manifestStatus}|${agents.length}|${waitingCount}|${taskSig}|${agentSig}${animation}`;
	}

	private colorLine(line: string): string {
		// F-1 / V-3: delegate to the shared glyph colorizer so ⏳ (waiting),
		// ⚠ (needs_attention) and the braille spinner frames are colored
		// consistently with the rest of the UI. The previous local map/regex
		// omitted all three, leaving the most attention-demanding states uncolored.
		return colorizeStatusGlyphs(line, this.theme);
	}

	invalidate(): void {
		this.cachedLines = [];
		this.cachedSignature = "";
	}

	dispose(): void {
		// M-10 fix (code-review 2026-06-23): clear the auto-close timer so a
		// disposed sidebar (not closed via the normal path) doesn't fire this.done()
		// on a disposed component.
		if (this.autoCloseTimeout) {
			clearTimeout(this.autoCloseTimeout);
			this.autoCloseTimeout = undefined;
		}
		this.unsubscribeTheme();
		this.renderScheduler.dispose();
	}

	render(width: number): string[] {
		const w = Math.max(36, width);

		// P0-6: render from snapshots only — never read disk on every render tick.
		// Production wires a snapshotCache (extension/registration/ui.ts). When
		// the cache hasn't populated yet we paint a single "(loading…)" line so
		// the pre-load frame is well-formed instead of an empty panel. When the
		// cache is undefined (tests/dev) we fall back to direct disk reads so
		// existing unit tests keep working.
		let run: import("../state/types.ts").TeamRunManifest;
		let tasks: TeamTaskState[];
		let rawAgents: ReturnType<typeof readCrewAgents>;
		let snapshot: RunUiSnapshot | undefined;
		if (this.snapshotCache) {
			try {
				snapshot = this.snapshotCache.refreshIfStale(this.runId);
			} catch {
				snapshot = undefined;
			}
			if (!snapshot) {
				return ["(loading…)"];
			}
			run = snapshot.manifest;
			tasks = snapshot.tasks;
			rawAgents = snapshot.agents;
		} else {
			const loaded = loadRunManifestById(this.cwd, this.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
			if (!loaded) {
				return renderLines(
					[
						border("╭", "─", "╮", w),
						line(`${this.theme.fg("accent", "▐")} ${this.theme.bold("pi-crew live sidebar")}`, w),
						line("run not found", w),
						border("╰", "─", "╯", w),
					],
					w,
				);
			}
			run = loaded.manifest;
			tasks = readTasks(run.tasksPath);
			rawAgents = readCrewAgents(run);
		}
		const controlConfig = resolveCrewControlConfig({ ui: this.config });
		const agents = rawAgents.map((agent) => applyAttentionState(run, agent, controlConfig));
		const active = agents.filter((agent) => agent.status === "running");
		const completed = agents.filter((agent) => agent.status !== "running").slice(-5);
		const waiting = tasks.filter((task) => task.status === "queued");
		const signature = this.buildSignature(run.updatedAt, tasks, agents, waiting.length, snapshot);
		if (signature !== this.cachedSignature || w !== this.cachedWidth) {
			// L-2: surface the cancellation/failure reason for terminal runs so the
			// user sees *why* a run ended without having to switch panes. The reason
			// is already computed on the consumed snapshot (cancellationReason).
			const TERMINAL_WITH_REASON = ["failed", "cancelled", "stopped"];
			const reasonSuffix =
				TERMINAL_WITH_REASON.includes(run.status) && snapshot?.cancellationReason
					? ` · ${truncate(snapshot.cancellationReason, 40)}`
					: "";
			const lines: string[] = [
				border("╭", "─", "╮", w),
				line(`${this.theme.fg("accent", "▐")} ${this.theme.bold("pi-crew live sidebar")}`, w),
				line(`${run.runId.slice(-12)} · ${run.status}${reasonSuffix} · right default`, w),
				line(`${run.team}/${run.workflow ?? "none"} · ${shortUsage(tasks)}`, w),
				border("├", "─", "┤", w),
				line(`Active agents (${active.length})`, w),
			];
			for (const agent of active.slice(0, 8)) {
				const status = iconForStatus(agent.status, {
					runningGlyph: spinnerFrame(agent.taskId),
				});
				const usage = agent.usage
					? formatUsage(agent.usage)
					: agent.progress?.tokens
						? `tokens=${agent.progress.tokens}`
						: "usage=pending";
				lines.push(line(`${status} ${agent.taskId} ${agent.role}->${agent.agent}`, w));
				lines.push(
					line(
						`  ${agent.routing ? `model ${agent.routing.requested ? `${agent.routing.requested} → ` : ""}${agent.routing.resolved}` : agent.model ? `model ${agent.model}` : "model pending"}`,
						w,
					),
				);
				lines.push(
					line(
						`  ${agent.progress?.currentTool ? `tool ${agent.progress.currentTool} · ` : ""}${agent.toolUses ?? 0} tools · ${usage}`,
						w,
					),
				);
			}
			if (!active.length) lines.push(line("- none", w));
			lines.push(border("├", "─", "┤", w), line(`Waiting tasks (${waiting.length})`, w));
			for (const task of waiting.slice(0, 8)) {
				const status = iconForStatus("queued");
				lines.push(line(`${status} ${task.id} ${waitingReason(task, tasks) ?? "waiting"}`, w));
			}
			if (waiting.length === 0) lines.push(line("- none", w));
			lines.push(border("├", "─", "┤", w), line(`Completed agents (${completed.length})`, w));
			for (const agent of completed) {
				const status = iconForStatus(agent.status === "running" ? "stopped" : agent.status);
				lines.push(
					line(
						`${status} ${agent.taskId} ${agent.model ? `· ${agent.model}` : ""}${agent.usage ? ` · ${formatUsage(agent.usage)}` : ""}`,
						w,
					),
				);
			}
			if (completed.length === 0) lines.push(line("- none", w));
			lines.push(border("├", "─", "┤", w));
			for (const entry of formatTaskGraphLines(tasks).slice(0, 6)) lines.push(line(entry, w));
			lines.push(line("q close · /team-dashboard details", w));
			// F-6: compute the auto-close countdown BEFORE pushing the bottom border
			// so the countdown renders inside the bordered box rather than below it.
			// Auto-close logic: if run is terminal and no active agents, close after delay
			const isTerminal = ["completed", "failed", "cancelled", "blocked"].includes(run.status);
			const hasActiveAgents = agents.some((a) => a.status === "running");
			if (isTerminal && !hasActiveAgents && !this.hasAutoClosed) {
				const autoCloseMs = this.config?.autoCloseDashboardMs ?? 3000;
				if (autoCloseMs > 0) {
					this.autoCloseTimeout = setTimeout(() => {
						this.hasAutoClosed = true;
						this.done(undefined);
					}, autoCloseMs);
					lines.push(line(`auto-close in ${Math.round(autoCloseMs / 1000)}s…`, w));
				}
			}
			// Clear timeout if conditions change
			else if (this.autoCloseTimeout) {
				clearTimeout(this.autoCloseTimeout);
				this.autoCloseTimeout = undefined;
			}
			lines.push(border("╰", "─", "╯", w));
			this.cachedLines = renderLines(
				lines.map((entry) => this.colorLine(entry)),
				w,
			);
			this.cachedSignature = signature;
			this.cachedWidth = w;
		}
		return this.cachedLines;
	}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b") this.done(undefined);
	}
}
