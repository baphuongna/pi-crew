import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewUiConfig } from "../config/config.ts";
import { listRecentRuns } from "../extension/run-index.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import { isDisplayActiveRun } from "../runtime/process-status.ts";
import { listLiveAgents, evictStaleLiveAgentHandles, type LiveAgentHandle } from "../runtime/live-agent-manager.ts";
import { getTaskUsage } from "../runtime/usage-tracker.ts";
import type { TeamRunManifest } from "../state/types.ts";
import type { ManifestCache } from "../runtime/manifest-cache.ts";
import { reconcileAllStaleRuns } from "../runtime/crash-recovery.ts";
import { iconForStatus } from "./status-colors.ts";
import { truncate } from "../utils/visual.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "./theme-adapter.ts";
import { Box, Text } from "./layout-primitives.ts";
import { requestRender, setExtensionWidget } from "./pi-ui-compat.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "./snapshot-types.ts";
import { runEventBus } from "./run-event-bus.ts";
import { DEFAULT_UI } from "../config/defaults.ts";
import { computePhaseProgress, formatPhaseProgressLine } from "../runtime/phase-progress.ts";
import { SUBAGENT_SPINNER_FRAMES, spinnerBucket, spinnerFrame } from "./spinner.ts";

const SPINNER = SUBAGENT_SPINNER_FRAMES;
const TOOL_LABELS: Record<string, string> = {
	head: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
grep: "searching",
	find: "finding files",
	ls: "listing",
};

const TOOL_ICONS: Record<string, string> = {
	read: "📖",
	bash: ">",
	edit: "✏",
	write: "📝",
	grep: "🔍",
	find: "📁",
	ls: "📋",
	agent: "🤖",
};
const LEGACY_WIDGET_KEY = "pi-crew";
const WIDGET_KEY = "pi-crew-active";
const STATUS_KEY = "pi-crew";

const MAX_LINES_DEFAULT = DEFAULT_UI.widgetMaxLines;
const MAX_AGENTS_DISPLAY = 3;
/** R1: How many turns finished agents linger before disappearing. */
const FINISHED_LINGER_MAX_AGE = 1;
const ERROR_LINGER_MAX_AGE = 2;
const ERROR_STATUSES = new Set(["failed", "cancelled", "stopped", "needs_attention"]);
/** R3: Faster refresh when live agents are running. Aligned with spinner frame. */
const LIVE_REFRESH_MS = 160;

type WidgetComponent = { render(width: number): string[]; invalidate(): void };

interface CrewWidgetModel {
	cwd: string;
	frame: number;
	maxLines: number;
	notificationCount?: number;
	manifestCache?: ManifestCache;
	snapshotCache?: RunSnapshotCache;
	preloadManifests?: TeamRunManifest[];
}

export interface CrewWidgetState {
	frame: number;
	interval?: ReturnType<typeof setInterval>;
	lastPlacement?: string;
	lastVisibility?: "hidden" | "visible";
	lastKey?: string;
	lastMaxLines?: number;
	lastCwd?: string;
	legacyCleared?: boolean;
	model?: CrewWidgetModel;
	notificationCount?: number;
}

interface WidgetRun {
	run: TeamRunManifest;
	agents: CrewAgentRecord[];
	snapshot?: RunUiSnapshot;
}

function elapsed(iso: string | undefined, now = Date.now()): string | undefined {
	if (!iso) return undefined;
	const ms = Math.max(0, now - new Date(iso).getTime());
	if (!Number.isFinite(ms)) return undefined;
	if (ms < 1000) return "now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h`;
}

function describeLiveActivity(handle: LiveAgentHandle): string {
	const act = handle.activity;
	if (act.activeTools.size > 0) {
		const groups = new Map<string, number>();
		for (const toolName of act.activeTools.values()) {
			groups.set(toolName, (groups.get(toolName) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [toolName, count] of groups) {
			const icon = TOOL_ICONS[toolName] ?? "?";
			const label = TOOL_LABELS[toolName] ?? toolName;
			if (count > 1) {
				parts.push(`${icon}${count} ${label}s`);
			} else {
				parts.push(`${icon} ${label}`);
			}
		}
		return parts.join(", ") + "…";
	}
	if (act.responseText?.trim()) {
		const line = act.responseText.split("\n").find((l) => l.trim())?.trim() ?? "";
		return line.length > 60 ? line.slice(0, 60) + "…" : line;
	}
	return "thinking…";
}

function agentActivity(agent: CrewAgentRecord, liveHandle?: LiveAgentHandle): string {
	if (liveHandle && liveHandle.status === "running") {
		const live = describeLiveActivity(liveHandle);
		// If live activity is just the fallback, prefer richer agent.progress data
		// (persistLiveProgress writes tool events to agentProgress before live tracking picks them up)
		if (live === "thinking…" && agent.progress?.currentTool) return `${TOOL_LABELS[agent.progress.currentTool] ?? agent.progress.currentTool}…`;
		return live;
	}
	if (agent.progress?.currentTool) return `${TOOL_LABELS[agent.progress.currentTool] ?? agent.progress.currentTool}…`;
	const recent = agent.progress?.recentOutput?.at(-1);
	if (recent) {
		const cleaned = recent.replace(/\s+/g, " ").trim();
		return cleaned.length > 60 ? cleaned.slice(0, 60) + "…" : cleaned;
	}
	if (agent.progress?.activityState === "needs_attention") return "needs attention";
	if (agent.status === "queued") return "queued";
	if (agent.status === "running") {
		const age = agent.startedAt ? Date.now() - new Date(agent.startedAt).getTime() : Infinity;
		if (age < 5000 && !agent.progress?.currentTool) return "spawning…";
		return "thinking…";
	}
	if (agent.status === "failed") return agent.error ?? "failed";
	return "done";
}

function formatTokensCompact(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tok`;
	return `${count} tok`;
}

function agentStats(agent: CrewAgentRecord, liveHandle?: LiveAgentHandle): string {
	const parts: string[] = [];
	if (liveHandle) {
		const act = liveHandle.activity;
		if (act.toolUses > 0) parts.push(`${act.toolUses} tools`);
		const usage = getTaskUsage(liveHandle.taskId);
		const total = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
		if (total > 0) parts.push(formatTokensCompact(total));
		try {
			const stats = liveHandle.session.getSessionStats?.();
			const ctxPct = stats?.contextUsage?.percent;
			if (ctxPct != null) parts.push(`${Math.round(ctxPct)}% ctx`);
		} catch { /* ignore */ }
		const rawStarted = act.startedAtMs || 0;
		const rawCompleted = act.completedAtMs || 0;
		const nowMs = Date.now();
		const nowSec = Math.floor(nowMs / 1000);
		// Detect if value is in seconds vs milliseconds by comparing distance to current time
		// If value is closer to nowSec (within ±2 years) AND not close to nowMs, treat as seconds
		const isSeconds = (v: number) => {
			if (v <= 0) return false;
			const distToSec = Math.abs(v - nowSec);
			const distToMs = Math.abs(v - nowMs);
			// If distance to seconds is much smaller AND value is in valid seconds range
			return distToSec < distToMs && distToSec < 31536000 * 2 && v > 1000000000;
		};
		// Simple fix: detect if value is Unix seconds and convert properly
		// Unix seconds are ~10 digits (e.g., 1779082445), Unix ms are ~13 digits (e.g., 1779082445000)
		const toMs = (v: number): number => {
			if (v <= 0) return 0;
			// If 10 digits (or 9 with recent), treat as seconds
			if (v > 1000000000 && v < 10000000000) return v * 1000;
			// If 13 digits, treat as ms
			if (v > 100000000000 && v < 10000000000000) return v;
			// Fallback: use as-is
			return v;
		};
		const startedMs = toMs(rawStarted);
		const completedMs = rawCompleted > 0 ? toMs(rawCompleted) : 0;
		// Validate bounds
		const isValidStarted = startedMs > 0 && startedMs < nowMs + 60000 && startedMs > nowMs - 3155692600000;
		const isValidCompleted = completedMs === 0 || (completedMs > 0 && completedMs < nowMs + 60000);
		const ms = (isValidCompleted ? completedMs : nowMs) - (isValidStarted ? startedMs : nowMs);
		parts.push(`${(ms / 1000).toFixed(1)}s`);
	} else {
		if (agent.toolUses) parts.push(`${agent.toolUses} tools`);
		if (agent.progress?.tokens) parts.push(formatTokensCompact(agent.progress.tokens));
		const age = elapsed(agent.completedAt ?? agent.startedAt);
		if (age) parts.push(age);
	}
	return parts.join(" · ");
}

function agentsFor(run: TeamRunManifest): CrewAgentRecord[] {
	try {
		return readCrewAgents(run);
	} catch {
		return [];
	}
}

/** Timestamp of the last periodic stale-reconciliation. Throttled to 60s to avoid excessive disk I/O. */
let lastStaleReconcileAt = 0;
const STALE_RECONCILE_INTERVAL_MS = 60_000;

export function activeWidgetRuns(cwd: string, manifestCache?: ManifestCache, snapshotCache?: RunSnapshotCache, preloadedManifests?: TeamRunManifest[], workspaceId?: string): WidgetRun[] {
	// Evict stale live-agent handles (terminal status >10min, or running >30min with no update)
	evictStaleLiveAgentHandles();
	// Periodic stale reconciliation: detect ghost runs on disk with dead PIDs
	// and repair them to terminal status. Throttled to once per 60 seconds.
	const now = Date.now();
	if (now - lastStaleReconcileAt > STALE_RECONCILE_INTERVAL_MS && manifestCache) {
		lastStaleReconcileAt = now;
		try { reconcileAllStaleRuns(cwd, manifestCache); } catch { /* non-critical background maintenance */ }
	}
	let runs = preloadedManifests ?? (manifestCache ? manifestCache.list(20) : listRecentRuns(cwd, 20));
	// Filter by workspaceId for session isolation
	if (workspaceId) {
		runs = runs.filter((run) => !run.ownerSessionId || run.ownerSessionId === workspaceId);
	}
	return runs
		.map((run) => {
			try {
				// 1.2: render path is read-only. Use cache.get() only; if miss
				// the background preload loop will populate on the next tick.
				// Fall back to manifest-only data so the widget still renders
				// without blocking on disk.
				const snapshot = snapshotCache?.get(run.runId);
				return snapshot ? { run: snapshot.manifest, agents: snapshot.agents, snapshot } : { run, agents: agentsFor(run) };
			} catch {
				return { run, agents: agentsFor(run) };
			}
		})
		.filter((item) => isDisplayActiveRun(item.run, item.agents));
}

function statusSummary(runs: WidgetRun[]): string {
	const agents = runs.flatMap((item) => item.agents);
	const runningAgents = agents.filter((agent) => agent.status === "running").length;
	const queuedAgents = agents.filter((agent) => agent.status === "queued" || agent.status === "waiting").length;
	const completedAgents = agents.filter((agent) => agent.status === "completed").length;
	const totalAgents = agents.length;
	const totalRuns = runs.length;
	const model = agents.find((a) => a.model)?.model?.split("/").at(-1);
	const parts = [`⚙ ${runningAgents}r`];
	if (queuedAgents > 0) parts.push(`${queuedAgents}q`);
	if (completedAgents > 0) parts.push(`${completedAgents}/${totalAgents}done`);
	if (totalRuns > 1) parts.push(`${totalRuns}runs`);
	if (model) parts.push(model);
	return parts.join(" · ");
}

export function notificationBadge(count: number | undefined, env: NodeJS.ProcessEnv = process.env): string {
	if (!count || count <= 0) return "";
	const term = `${env.TERM ?? ""} ${env.WT_SESSION ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
	const supportsEmoji = !term.includes("dumb") && env.NO_COLOR !== "1";
	return supportsEmoji ? ` 🔔${count}` : ` [!${count}]`;
}

export function widgetHeader(runs: WidgetRun[], runningGlyph: string, maxLines = 20, notificationCount = 0): string {
	const agents = runs.flatMap((item) => item.agents);
	const runningAgents = agents.filter((agent) => agent.status === "running").length;
	const queuedAgents = agents.filter((agent) => agent.status === "queued").length;
	const waitingAgents = agents.filter((agent) => agent.status === "waiting").length;
	const completedAgents = agents.filter((agent) => agent.status === "completed").length;
	const parts = [`${runningAgents} running`];
	if (queuedAgents) parts.push(`${queuedAgents} queued`);
	if (waitingAgents) parts.push(`${waitingAgents} waiting`);
	if (completedAgents) parts.push(`${completedAgents}/${agents.length} done`);
	return `${runningGlyph} Crew agents${notificationBadge(notificationCount)} · ${parts.join(" · ")} · /team-dashboard`;
}

function shortRunLabel(run: TeamRunManifest): string {
	return `${run.team}/${run.workflow ?? "none"}`;
}

export function buildCrewWidgetLines(cwd: string, frame = 0, maxLines = 8, providedRuns?: WidgetRun[], notificationCount = 0): string[] {
	const runs = providedRuns ?? activeWidgetRuns(cwd);
	if (!runs.length) return [];
	// Time-based spinner glyph so animation stays smooth at the renderer's
	// natural cadence — independent of how often `frame` counter advances.
	const runningGlyph = spinnerFrame("widget-header");
	const lines: string[] = [widgetHeader(runs, runningGlyph, maxLines, notificationCount)];
	for (const { run, agents, snapshot } of runs) {
		const activeAgents = agents.filter((item) => item.status === "running" || item.status === "queued" || item.status === "waiting");
		// R1: Include recently finished agents (linger 1-2 min)
		const now = Date.now();
		const finishedAgents = agents.filter((item) => {
			if (item.status === "running" || item.status === "queued" || item.status === "waiting") return false;
			if (!item.completedAt) return false;
			const maxAgeMs = (ERROR_STATUSES.has(item.status) ? ERROR_LINGER_MAX_AGE : FINISHED_LINGER_MAX_AGE) * 60_000;
			const age = now - new Date(item.completedAt).getTime();
			return Number.isFinite(age) && age < maxAgeMs;
		});
		const completed = agents.filter((agent) => agent.status === "completed").length;
		const runGlyph = iconForStatus(run.status, { runningGlyph });
		const phaseLine = snapshot ? formatPhaseProgressLine(computePhaseProgress(snapshot.tasks)) : "";
		const progressPart = phaseLine ? `${phaseLine}` : `${completed}/${agents.length} done`;
		lines.push(`\u251C\u2500 ${runGlyph} ${shortRunLabel(run)} \u00B7 ${progressPart} \u00B7 ${run.runId.slice(-8)}`);
		const liveForRun = listLiveAgents().filter((a) => a.runId === run.runId);
		// Render finished agents first (compact 1-line format)
		for (const agent of finishedAgents.slice(0, 2)) {
			const liveHandle = liveForRun.find((h) => h.taskId === agent.taskId);
			const name = liveHandle?.agent ?? agent.agent;
			const icon = agent.status === "completed" ? "\u2713" : agent.status === "failed" ? "\u2717" : agent.status === "needs_attention" ? "\u26A0" : "\u25AA";
			const stats = agentStats(agent, liveHandle);
			const desc = liveHandle?.description ?? agent.role;
			lines.push(`\u2502  \u251C\u2500 ${icon} ${name} \u00B7 ${desc}${stats ? ` \u00B7 ${stats}` : ""}`);
		}
		// Render active agents
		const visibleAgents = activeAgents.slice(0, MAX_AGENTS_DISPLAY);
		for (const [index, agent] of visibleAgents.entries()) {
			const last = index === visibleAgents.length - 1 && activeAgents.length <= MAX_AGENTS_DISPLAY;
			const branch = last ? "\u2514\u2500" : "\u251C\u2500";
			const agentGlyph = iconForStatus(agent.status, { runningGlyph });
			const liveHandle = liveForRun.find((h) => h.taskId === agent.taskId);
			const stats = agentStats(agent, liveHandle);
			const name = liveHandle?.agent ?? agent.agent;
			const desc = liveHandle?.description ?? agent.role;
			lines.push(`\u2502  ${branch} ${agentGlyph} ${name}${desc ? ` \u00B7 ${desc}` : ` \u00B7 ${agent.role}`}`);
			lines.push(`\u2502     \u23B7 ${agentActivity(agent, liveHandle)}${stats ? ` \u00B7 ${stats}` : ""}`);
		}
		if (activeAgents.length > MAX_AGENTS_DISPLAY) lines.push(`\u2502  \u2514\u2500 \u2026 +${activeAgents.length - MAX_AGENTS_DISPLAY} more agents`);
		if (lines.length >= maxLines) break;
	}
	return lines.slice(0, maxLines);
}

function statusGlyphColor(icon: string): Parameters<CrewTheme["fg"]>[0] {
	const mapping: Record<string, Parameters<CrewTheme["fg"]>[0]> = {
		"✓": "success",
		"✗": "error",
		"■": "warning",
		"⏸": "warning",
		"◦": "dim",
		"·": "dim",
		"▶": "accent",
	};
	return mapping[icon] ?? "accent";
}

function colorWidgetLine(line: string, index: number, theme: CrewTheme): string {
	let result = line;
	if (index === 0) {
		result = result.replace("Crew agents", theme.bold(theme.fg("accent", "Crew agents")));
	}
	result = result.replace(/[✓✗■⏸◦·▶]/g, (icon) => theme.fg(statusGlyphColor(icon), icon));
	if (index === 0) {
		result = theme.fg("accent", result);
	}
	return result;
}

function renderLines(lines: string[], width: number): string[] {
	const box = new Box(0, 0);
	for (const line of lines) {
		box.addChild(new Text(line));
	}
	return box.render(width);
}

class CrewWidgetComponent implements WidgetComponent {
	private readonly model: CrewWidgetModel;
	private theme: CrewTheme;
	private cacheSignature: string;
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private cachedBaseLines: string[] = [];
	private cachedTheme: CrewTheme;
	private readonly unsubscribeTheme: () => void;
	private readonly unsubscribeEventBus: () => void;

	constructor(model: CrewWidgetModel, themeLike: unknown) {
		this.model = model;
		this.theme = asCrewTheme(themeLike);
		this.cachedTheme = this.theme;
		this.cacheSignature = "";
		this.unsubscribeTheme = subscribeThemeChange(themeLike, () => this.invalidate());
		this.unsubscribeEventBus = runEventBus.onAny(() => this.invalidate());
	}

	private buildSignature(runs: WidgetRun[]): string {
		const liveSig = listLiveAgents().map((h) => `${h.agentId}:${h.status}:${h.activity.turnCount}:${h.activity.toolUses}:${[...h.activity.activeTools.values()].join(",")}:${h.activity.responseText.slice(-30)}`).join("|");
		// When any agent is running we want per-agent runningGlyph (baked into
		// cachedBaseLines) to re-rotate in step with the spinner bucket. Without
		// this, finished+running rows would freeze between data updates.
		const hasRunning = runs.some((entry) => entry.agents.some((agent) => agent.status === "running"))
			|| listLiveAgents().some((h) => h.status === "running");
		const animation = hasRunning ? `:spin=${spinnerBucket()}` : "";
		return runs
			.map((entry) => entry.snapshot?.signature ?? `${entry.run.runId}:${entry.run.status}:${entry.run.updatedAt}:` + entry.agents.map((agent) => {
				const recentOutput = agent.progress?.recentOutput.at(-1) ?? "";
				const progress = [agent.progress?.currentTool ?? "", agent.progress?.toolCount ?? 0, agent.progress?.tokens ?? 0, agent.progress?.turns ?? 0, agent.progress?.lastActivityAt ?? "", recentOutput].join(":");
				return `${agent.status}:${agent.startedAt}:${agent.completedAt ?? ""}:${agent.toolUses ?? 0}:${progress}`;
			}).join(","))
			.join("|") + `|live:${liveSig}${animation}`;
	}

	private colorize(lines: string[], width: number): string[] {
		return renderLines(lines.map((line, index) => colorWidgetLine(line, index, this.theme)), width);
	}

	invalidate(): void {
		this.cacheSignature = "";
		this.cachedBaseLines = [];
		this.cachedLines = [];
	}

	dispose(): void {
		this.unsubscribeTheme();
		this.unsubscribeEventBus();
	}

	render(width: number): string[] {
		const runs = activeWidgetRuns(this.model.cwd, this.model.manifestCache, this.model.snapshotCache, this.model.preloadManifests);
		const signature = `${this.buildSignature(runs)}:${this.model.notificationCount ?? 0}`;
		// Time-based glyphs so the spinner animates every render call rather than
		// only when state.frame is bumped (which happens at the slower data refresh).
		const runningGlyph = spinnerFrame("widget-header");
		const headerGlyph = runs.length ? spinnerFrame("widget-header") : " ";

		if (this.cacheSignature !== signature || width !== this.cachedWidth || this.cachedTheme !== this.theme) {
			this.cachedBaseLines = buildCrewWidgetLines(this.model.cwd, 0, this.model.maxLines, runs, this.model.notificationCount ?? 0).map((line, index) => {
				if (index === 0 && line.length > 0) return `${headerGlyph}${line.slice(1)}`;
				return line;
			});
			this.cachedLines = this.colorize(this.cachedBaseLines, width);
			this.cachedWidth = width;
			this.cachedTheme = this.theme;
			this.cacheSignature = signature;
		}

		if (runs.length === 0) {
			this.invalidate();
			return [];
		}

		// Update only spinner and command icon on header line to avoid full re-color for every frame.
		const updatedHeader = `${runningGlyph}${this.cachedBaseLines[0]?.slice(1) ?? ""}`;
		this.cachedLines[0] = truncate(colorWidgetLine(updatedHeader, 0, this.theme), width);
		// Safety: ensure all lines fit within terminal width (handles emoji/CJK width mismatch)
		return this.cachedLines.map((line) => truncate(line, width));
	}
}

export function updateCrewWidget(
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui" | "sessionManager">,
	state: CrewWidgetState,
	config?: CrewUiConfig,
	manifestCache?: ManifestCache,
	snapshotCache?: RunSnapshotCache,
	preloadedManifests?: TeamRunManifest[],
): void {
	if (!ctx.hasUI) return;
	state.frame += 1;
	const maxLines = config?.widgetMaxLines ?? MAX_LINES_DEFAULT;
	// Get workspaceId from sessionManager, fallback to ownerSessionId from active runs
	let workspaceId = ctx.sessionManager?.getSessionId?.();
	if (!workspaceId && manifestCache) {
		const runs = manifestCache.list(20);
		const active = runs.find((r) => r.status === "running" || r.status === "queued");
		if (active?.ownerSessionId) workspaceId = active.ownerSessionId;
	}
	const runs = activeWidgetRuns(ctx.cwd, manifestCache, snapshotCache, preloadedManifests, workspaceId);
	const lines = buildCrewWidgetLines(ctx.cwd, state.frame, maxLines, runs, state.notificationCount ?? 0);
	const placement = config?.widgetPlacement ?? DEFAULT_UI.widgetPlacement;
	ctx.ui.setStatus(STATUS_KEY, lines.length ? statusSummary(runs) : undefined);
	const shouldClearLegacy = state.legacyCleared !== true || state.lastPlacement !== placement;
	if (shouldClearLegacy) {
		setExtensionWidget(ctx, LEGACY_WIDGET_KEY, undefined, { placement });
		state.legacyCleared = true;
	}
	if (!lines.length) {
		if (state.lastVisibility !== "hidden" || state.lastPlacement !== placement) {
			setExtensionWidget(ctx, WIDGET_KEY, undefined, { placement });
			state.lastVisibility = "hidden";
			state.lastPlacement = placement;
			state.lastKey = WIDGET_KEY;
			state.lastMaxLines = maxLines;
			state.lastCwd = ctx.cwd;
			state.model = undefined;
		}
		requestRender(ctx);
		return;
	}
	const needsWidgetInstall = state.lastVisibility !== "visible" || state.lastPlacement !== placement || state.lastKey !== WIDGET_KEY || state.lastMaxLines !== maxLines || state.lastCwd !== ctx.cwd || !state.model;
	if (!state.model) state.model = { cwd: ctx.cwd, frame: state.frame, maxLines, notificationCount: state.notificationCount ?? 0, manifestCache, snapshotCache, preloadManifests: preloadedManifests };
	else {
		state.model.cwd = ctx.cwd;
		state.model.frame = state.frame;
		state.model.maxLines = maxLines;
		state.model.notificationCount = state.notificationCount ?? 0;
		state.model.manifestCache = manifestCache;
		state.model.snapshotCache = snapshotCache;
		state.model.preloadManifests = preloadedManifests;
	}
	if (needsWidgetInstall) {
		const model = state.model;
		setExtensionWidget(
			ctx,
			WIDGET_KEY,
			((_tui: unknown, theme: unknown) => new CrewWidgetComponent(model, theme)) as never,
			{ placement, persist: true },
		);
		state.lastVisibility = "visible";
		state.lastPlacement = placement;
		state.lastKey = WIDGET_KEY;
		state.lastMaxLines = maxLines;
		state.lastCwd = ctx.cwd;
	}
	requestRender(ctx);
}

export function stopCrewWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, state: CrewWidgetState, config?: CrewUiConfig): void {
	if (state.interval) clearInterval(state.interval);
	state.interval = undefined;
	if (ctx?.hasUI) {
		const placement = config?.widgetPlacement ?? DEFAULT_UI.widgetPlacement;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		setExtensionWidget(ctx, LEGACY_WIDGET_KEY, undefined, { placement });
		setExtensionWidget(ctx, WIDGET_KEY, undefined, { placement });
		state.lastVisibility = "hidden";
		state.lastPlacement = placement;
		state.lastKey = WIDGET_KEY;
		state.model = undefined;
		state.legacyCleared = true;
		requestRender(ctx);
	}
}
