import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CrewUiConfig } from "../config/config.ts";
import { listRecentRuns } from "../extension/run-index.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import { isDisplayActiveRun } from "../runtime/process-status.ts";
import type { TeamRunManifest } from "../state/types.ts";
import type { ManifestCache } from "../runtime/manifest-cache.ts";
import { colorForStatus, iconForStatus, type RunStatus } from "./status-colors.ts";
import { pad, truncate } from "../utils/visual.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "./theme-adapter.ts";
import { Box, Text } from "./layout-primitives.ts";
import { requestRender, setExtensionWidget } from "./pi-ui-compat.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "./snapshot-types.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_LABELS: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};
const LEGACY_WIDGET_KEY = "pi-crew";
const WIDGET_KEY = "pi-crew-active";
const STATUS_KEY = "pi-crew";

const MAX_LINES_DEFAULT = 10;
const MAX_AGENTS_DISPLAY = 3;

type WidgetComponent = { render(width: number): string[]; invalidate(): void };

interface CrewWidgetModel {
	cwd: string;
	frame: number;
	maxLines: number;
	notificationCount?: number;
	manifestCache?: ManifestCache;
	snapshotCache?: RunSnapshotCache;
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

function agentActivity(agent: CrewAgentRecord): string {
	if (agent.progress?.currentTool) return `${TOOL_LABELS[agent.progress.currentTool] ?? agent.progress.currentTool}…`;
	const recent = agent.progress?.recentOutput?.at(-1);
	if (recent) return recent.replace(/\s+/g, " ").trim();
	if (agent.progress?.activityState === "needs_attention") return "needs attention";
	if (agent.status === "queued") return "queued";
	if (agent.status === "running") return "thinking…";
	if (agent.status === "failed") return agent.error ?? "failed";
	return "done";
}

function agentStats(agent: CrewAgentRecord): string {
	const parts: string[] = [];
	if (agent.toolUses) parts.push(`${agent.toolUses} tools`);
	if (agent.progress?.tokens) parts.push(`${agent.progress.tokens} tok`);
	if (agent.progress?.turns) parts.push(`⟳${agent.progress.turns}`);
	const age = elapsed(agent.completedAt ?? agent.startedAt);
	if (age) parts.push(agent.completedAt ? age : `${age} ago`);
	return parts.join(" · ");
}

function agentsFor(run: TeamRunManifest): CrewAgentRecord[] {
	try {
		return readCrewAgents(run);
	} catch {
		return [];
	}
}

export function activeWidgetRuns(cwd: string, manifestCache?: ManifestCache, snapshotCache?: RunSnapshotCache, preloadedManifests?: TeamRunManifest[]): WidgetRun[] {
	const runs = preloadedManifests ?? (manifestCache ? manifestCache.list(20) : listRecentRuns(cwd, 20));
	return runs
		.map((run) => {
			try {
				const snapshot = snapshotCache?.get(run.runId) ?? snapshotCache?.refreshIfStale(run.runId);
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
	const queuedAgents = agents.filter((agent) => agent.status === "queued").length;
	const waitingAgents = agents.filter((agent) => agent.status === "waiting").length;
	const completedAgents = agents.filter((agent) => agent.status === "completed").length;
	const parts = [`${runningAgents} running`];
	if (queuedAgents) parts.push(`${queuedAgents} queued`);
	if (waitingAgents) parts.push(`${waitingAgents} waiting`);
	if (completedAgents) parts.push(`${completedAgents}/${agents.length} done`);
	return `Crew: ${parts.join(", ")}`;
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
	const runningGlyph = SPINNER[frame % SPINNER.length] ?? SPINNER[0];
	const lines: string[] = [widgetHeader(runs, runningGlyph, maxLines, notificationCount)];
	for (const { run, agents } of runs) {
		const activeAgents = agents.filter((item) => item.status === "running" || item.status === "queued" || item.status === "waiting");
		const completed = agents.filter((agent) => agent.status === "completed").length;
		const runGlyph = iconForStatus(run.status, { runningGlyph });
		lines.push(`├─ ${runGlyph} ${shortRunLabel(run)} · ${completed}/${agents.length} done · ${run.runId.slice(-8)}`);
		const visibleAgents = activeAgents.slice(0, MAX_AGENTS_DISPLAY);
		for (const [index, agent] of visibleAgents.entries()) {
			const last = index === visibleAgents.length - 1 && activeAgents.length <= MAX_AGENTS_DISPLAY;
			const branch = last ? "└─" : "├─";
			const agentGlyph = iconForStatus(agent.status, { runningGlyph });
			const stats = agentStats(agent);
			lines.push(`│  ${branch} ${agentGlyph} ${agent.agent} · ${agent.role}`);
			lines.push(`│     ⎿ ${agentActivity(agent)}${stats ? ` · ${stats}` : ""}`);
		}
		if (activeAgents.length > MAX_AGENTS_DISPLAY) lines.push(`│  └─ … +${activeAgents.length - MAX_AGENTS_DISPLAY} more agents`);
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

	constructor(model: CrewWidgetModel, themeLike: unknown) {
		this.model = model;
		this.theme = asCrewTheme(themeLike);
		this.cachedTheme = this.theme;
		this.cacheSignature = "";
		this.unsubscribeTheme = subscribeThemeChange(themeLike, () => this.invalidate());
	}

	private buildSignature(runs: WidgetRun[]): string {
		return runs
			.map((entry) => entry.snapshot?.signature ?? `${entry.run.runId}:${entry.run.status}:${entry.run.updatedAt}:` + entry.agents.map((agent) => {
				const recentOutput = agent.progress?.recentOutput.at(-1) ?? "";
				const progress = [agent.progress?.currentTool ?? "", agent.progress?.toolCount ?? 0, agent.progress?.tokens ?? 0, agent.progress?.turns ?? 0, agent.progress?.lastActivityAt ?? "", recentOutput].join(":");
				return `${agent.status}:${agent.startedAt}:${agent.completedAt ?? ""}:${agent.toolUses ?? 0}:${progress}`;
			}).join(","))
			.join("|");
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
	}

	render(width: number): string[] {
		const runs = activeWidgetRuns(this.model.cwd, this.model.manifestCache, this.model.snapshotCache);
		const signature = `${this.buildSignature(runs)}:${this.model.notificationCount ?? 0}`;
		const runningGlyph = SPINNER[this.model.frame % SPINNER.length] ?? SPINNER[0];
		const headerGlyph = runs.length ? SPINNER[0] : " ";

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

		if (runs.length === 0) return [];

		// Update only spinner and command icon on header line to avoid full re-color for every frame.
		const updatedHeader = `${runningGlyph}${this.cachedBaseLines[0]?.slice(1) ?? ""}`;
		this.cachedLines[0] = truncate(colorWidgetLine(updatedHeader, 0, this.theme), width);
		return this.cachedLines;
	}
}

export function updateCrewWidget(
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui">,
	state: CrewWidgetState,
	config?: CrewUiConfig,
	manifestCache?: ManifestCache,
	snapshotCache?: RunSnapshotCache,
	preloadedManifests?: TeamRunManifest[],
): void {
	if (!ctx.hasUI) return;
	state.frame += 1;
	const maxLines = config?.widgetMaxLines ?? MAX_LINES_DEFAULT;
	const runs = activeWidgetRuns(ctx.cwd, manifestCache, snapshotCache, preloadedManifests);
	const lines = buildCrewWidgetLines(ctx.cwd, state.frame, maxLines, runs, state.notificationCount ?? 0);
	const placement = config?.widgetPlacement ?? "aboveEditor";
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
	if (!state.model) state.model = { cwd: ctx.cwd, frame: state.frame, maxLines, notificationCount: state.notificationCount ?? 0, manifestCache, snapshotCache };
	else {
		state.model.cwd = ctx.cwd;
		state.model.frame = state.frame;
		state.model.maxLines = maxLines;
		state.model.notificationCount = state.notificationCount ?? 0;
		state.model.manifestCache = manifestCache;
		state.model.snapshotCache = snapshotCache;
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
		const placement = config?.widgetPlacement ?? "aboveEditor";
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
