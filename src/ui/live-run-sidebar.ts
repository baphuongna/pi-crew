import * as fs from "node:fs";
import type { CrewUiConfig } from "../config/config.ts";
import { applyAttentionState, resolveCrewControlConfig } from "../runtime/agent-control.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { formatTaskGraphLines, waitingReason } from "../runtime/task-display.ts";
import { loadRunManifestById } from "../state/stores/state-store.ts";
import type { TeamTaskState } from "../state/types.ts";
import { aggregateUsage, formatTokens } from "../state/usage.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import { truncate } from "../utils/visual.ts";
import { formatCount, teamWorkflowLabel } from "./format-helpers.ts";
import { DASHBOARD_KEYS } from "./keybinding-map.ts";
import { ACTIVE, canopyLine, formatHint, RAIL, type RailSlot, railLine, sectionLine, shortId, statusSlot } from "./rail.ts";
import type { OverlaySchedulerHandle } from "./shared-overlay-scheduler.ts";
import { registerOverlayScheduler } from "./shared-overlay-scheduler.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "./snapshot-types.ts";
import { spinnerBucket, spinnerFrame } from "./spinner.ts";
import { colorizeStatusGlyphs, iconForStatus } from "./status-colors.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "./theme-adapter.ts";
import { renderLines } from "./widget/widget-renderer.ts";

const TASK_READ_TTL_MS = 200;

type Done = (value: undefined) => void;

/** The ONE footer hint of the sidebar: keys label pairs, close LAST (RAIL §1). */
const SIDEBAR_HINT: ReadonlyArray<readonly [string, string]> = [
	["/team-dashboard", "details"],
	[DASHBOARD_KEYS.close[0] ?? "q", "close"],
];

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
	return usage ? compactUsage(usage) : "usage=(none)";
}

/**
 * TUI form of a usage record: `↑2.8k ↓3.7k $0.000`.
 *
 * `formatUsage` (state/usage.ts) is the `key=value` form used by CLI/status
 * output (`input=2780, output=3715, cacheRead=57216, cost=0.000000, turns=0`) —
 * correct for a log line, but on a 118-column rail row it buries the numbers
 * the eye actually wants. The card's usage row has always used this compact
 * form; the sidebar now matches it.
 */
function compactUsage(usage: ReturnType<typeof aggregateUsage>): string {
	if (!usage) return "usage=(none)";
	const parts: string[] = [];
	if (usage.input !== undefined) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output !== undefined) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost !== undefined && Number.isFinite(usage.cost) && usage.cost > 0) parts.push(`$${usage.cost.toFixed(3)}`);
	return parts.length > 0 ? parts.join(" ") : "usage=(none)";
}

export class LiveRunSidebar {
	private readonly cwd: string;
	private readonly runId: string;
	private readonly done: Done;
	private readonly theme: CrewTheme;
	private readonly config: CrewUiConfig;
	private readonly unsubscribeTheme: () => void;
	private readonly schedulerHandle: OverlaySchedulerHandle;
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
		this.schedulerHandle = registerOverlayScheduler(() => this.invalidate());
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
		this.schedulerHandle.dispose();
	}

	render(width: number): string[] {
		const w = Math.max(36, width);
		const budget = w - 2;

		// P0-6: render from snapshots only — never read disk on every render tick.
		// Production wires a snapshotCache (extension/registration/ui.ts). When
		// the cache hasn't populated yet we paint a well-formed two-row frame so
		// the pre-load surface still wears the rail; when the cache is undefined
		// (tests/dev) we fall back to direct disk reads so existing unit tests
		// keep working.
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
				// A well-formed pre-load frame: same canopy/cap grammar as the loaded
				// one, with a single dim status row.
				return this.renderFrame(
					[
						canopyLine({ word: "LIVE", subject: shortId(this.runId), theme: this.theme, budget }),
						railLine(RAIL.body, "border", this.theme.fg("dim", "loading…"), this.theme, budget),
					],
					budget,
					"border",
				);
			}
			run = snapshot.manifest;
			tasks = snapshot.tasks;
			rawAgents = snapshot.agents;
		} else {
			const loaded = loadRunManifestById(this.cwd, this.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
			if (!loaded) {
				return this.renderFrame(
					[
						canopyLine({ word: "LIVE", subject: shortId(this.runId), theme: this.theme, budget }),
						railLine(RAIL.body, "border", this.theme.fg("muted", "run not found"), this.theme, budget),
					],
					budget,
					"border",
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
			// RAIL (§2.E): the rounded `╭─╮│╰─╯` box is retired — the surface is a
			// `┏ LIVE ▸ <run8>` canopy, `┃` body rows, `┣ SECTION` headers and a
			// `┗ <hint>` cap. The rail colour carries the run's state.
			const slot: RailSlot = statusSlot(run.status);
			// L-2: surface the cancellation/failure reason for terminal runs so the
			// user sees *why* a run ended without having to switch panes. The reason
			// is already computed on the consumed snapshot (cancellationReason).
			const TERMINAL_WITH_REASON = ["failed", "cancelled", "stopped"];
			const reasonSuffix =
				TERMINAL_WITH_REASON.includes(run.status) && snapshot?.cancellationReason
					? ` · ${truncate(snapshot.cancellationReason, 40)}`
					: "";
			const lines: string[] = [
				canopyLine({ word: "LIVE", subject: shortId(run.runId), theme: this.theme, budget, slot }),
				railLine(
					RAIL.body,
					"border",
					this.theme.fg(
						"muted",
						`${shortId(run.runId)} · ${run.status ?? "?"}${reasonSuffix} · ${run.workspaceMode ?? "single"}`,
					),
					this.theme,
					budget,
				),
				railLine(
					RAIL.body,
					"border",
					this.theme.fg("muted", `${teamWorkflowLabel(run.team, run.workflow)} · ${shortUsage(tasks)}`),
					this.theme,
					budget,
				),
				sectionLine({ name: "active", subject: formatCount(active.length, "agent"), theme: this.theme, budget, slot }),
			];
			for (const agent of active.slice(0, 8)) {
				const status = iconForStatus(agent.status, {
					runningGlyph: spinnerFrame(agent.taskId),
				});
				const usage = agent.usage
					? compactUsage(agent.usage)
					: agent.progress?.tokens
						? `tokens=${agent.progress.tokens}`
						: "usage=pending";
				// The record comes from unvalidated `agents.json` — every field is
				// guarded (`?? "?"`) and the legacy `role->agent` separator is `▸`.
				lines.push(
					railLine(
						RAIL.body,
						"border",
						`${status} ${agent.taskId ?? "?"} ${agent.role ?? "?"} ${ACTIVE} ${agent.agent ?? "?"}`,
						this.theme,
						budget,
					),
				);
				lines.push(
					railLine(
						RAIL.body,
						"border",
						this.theme.fg(
							"muted",
							`  ${agent.routing ? `model ${agent.routing.requested ? `${agent.routing.requested} → ` : ""}${agent.routing.resolved ?? "pending"}` : agent.model ? `model ${agent.model}` : "model pending"}`,
						),
						this.theme,
						budget,
					),
				);
				lines.push(
					railLine(
						RAIL.body,
						"border",
						this.theme.fg(
							"muted",
							`  ${agent.progress?.currentTool ? `tool ${agent.progress.currentTool} · ` : ""}${formatCount(agent.toolUses ?? 0, "tool")} · ${usage}`,
						),
						this.theme,
						budget,
					),
				);
			}
			if (!active.length) lines.push(this.bodyRow(this.theme.fg("dim", "none"), budget));
			lines.push(sectionLine({ name: "waiting", subject: formatCount(waiting.length, "task"), theme: this.theme, budget, slot }));
			for (const task of waiting.slice(0, 8)) {
				const status = iconForStatus("queued");
				lines.push(this.bodyRow(`${status} ${task.id ?? "?"} ${waitingReason(task, tasks) ?? "waiting"}`, budget));
			}
			if (waiting.length === 0) lines.push(this.bodyRow(this.theme.fg("dim", "none"), budget));
			lines.push(sectionLine({ name: "done", subject: formatCount(completed.length, "agent"), theme: this.theme, budget, slot }));
			for (const agent of completed) {
				const status = iconForStatus(agent.status === "running" ? "stopped" : agent.status);
				lines.push(
					this.bodyRow(
						`${status} ${agent.taskId ?? "?"} ${agent.model ? `· ${agent.model}` : ""}${agent.usage ? ` · ${compactUsage(agent.usage)}` : ""}`,
						budget,
					),
				);
			}
			if (completed.length === 0) lines.push(this.bodyRow(this.theme.fg("dim", "none"), budget));
			lines.push(sectionLine({ name: "tasks", subject: formatCount(tasks.length, "task"), theme: this.theme, budget, slot }));
			for (const entry of formatTaskGraphLines(tasks).slice(0, 6)) {
				// `formatTaskGraphLines` (src/runtime/task-display.ts) still emits the
				// legacy `role->agent` separator; normalize it at the render boundary
				// so no `->` can reach the TUI (§4 consistency fix).
				lines.push(this.bodyRow(this.theme.fg("muted", entry.replace(/->/g, ACTIVE)), budget));
			}
			// F-6: compute the auto-close countdown BEFORE the cap so the countdown
			// renders inside the frame rather than below it.
			// Auto-close logic: if run is terminal and no active agents, close after delay
			const isTerminal = ["completed", "failed", "cancelled", "blocked"].includes(run.status);
			const hasActiveAgents = agents.some((a) => a.status === "running");
			if (isTerminal && !hasActiveAgents && !this.hasAutoClosed) {
				const autoCloseMs = this.config?.autoCloseDashboardMs ?? 3000;
				if (autoCloseMs > 0) {
					if (this.autoCloseTimeout) clearTimeout(this.autoCloseTimeout);
					this.autoCloseTimeout = setTimeout(() => {
						this.hasAutoClosed = true;
						this.done(undefined);
					}, autoCloseMs);
					this.autoCloseTimeout?.unref();
					lines.push(this.bodyRow(this.theme.fg("dim", `auto-close in ${Math.round(autoCloseMs / 1000)}s…`), budget));
				}
			}
			// Clear timeout if conditions change
			else if (this.autoCloseTimeout) {
				clearTimeout(this.autoCloseTimeout);
				this.autoCloseTimeout = undefined;
			}
			this.cachedLines = renderLines(this.renderFrame(lines, budget, slot), w);
			this.cachedSignature = signature;
			this.cachedWidth = w;
		}
		return this.cachedLines;
	}

	/** One `┃` body row (glyph + colour owned by the rail helper). */
	private bodyRow(content: string, budget: number): string {
		return railLine(RAIL.body, "border", content, this.theme, budget);
	}

	/** Append the `┗ <hint>` cap and colorize the glyphs (F-1 / V-3). */
	private renderFrame(lines: string[], budget: number, slot: RailSlot): string[] {
		const hint = this.theme.fg("dim", formatHint(SIDEBAR_HINT));
		const framed = [...lines, railLine(RAIL.close, slot, hint, this.theme, budget)];
		return framed.map((entry) => this.colorLine(entry));
	}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b") this.done(undefined);
	}
}
