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
import { asCrewTheme } from "./theme-adapter.ts";
import { Box, Text } from "./layout-primitives.ts";

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

export interface CrewWidgetState {
	frame: number;
	interval?: ReturnType<typeof setInterval>;
}

interface WidgetRun {
	run: TeamRunManifest;
	agents: CrewAgentRecord[];
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

export function activeWidgetRuns(cwd: string, manifestCache?: ManifestCache): WidgetRun[] {
	const runs = manifestCache ? manifestCache.list(20) : listRecentRuns(cwd, 20);
	return runs
		.map((run) => ({ run, agents: agentsFor(run) }))
		.filter((item) => isDisplayActiveRun(item.run, item.agents));
}

function statusSummary(runs: WidgetRun[]): string {
	const agents = runs.flatMap((item) => item.agents);
	const runningAgents = agents.filter((agent) => agent.status === "running").length;
	const queuedAgents = agents.filter((agent) => agent.status === "queued").length;
	const completedAgents = agents.filter((agent) => agent.status === "completed").length;
	const parts = [`${runningAgents} running`];
	if (queuedAgents) parts.push(`${queuedAgents} queued`);
	if (completedAgents) parts.push(`${completedAgents}/${agents.length} done`);
	return `Crew: ${parts.join(", ")}`;
}

export function widgetHeader(runs: WidgetRun[], runningGlyph: string, maxLines = 20): string {
	const agents = runs.flatMap((item) => item.agents);
	const runningAgents = agents.filter((agent) => agent.status === "running").length;
	const queuedAgents = agents.filter((agent) => agent.status === "queued").length;
	const completedAgents = agents.filter((agent) => agent.status === "completed").length;
	const parts = [`${runningAgents} running`];
	if (queuedAgents) parts.push(`${queuedAgents} queued`);
	if (completedAgents) parts.push(`${completedAgents}/${agents.length} done`);
	return `${runningGlyph} Crew agents · ${parts.join(" · ")} · /team-dashboard`;
}

function shortRunLabel(run: TeamRunManifest): string {
	return `${run.team}/${run.workflow ?? "none"}`;
}

export function buildCrewWidgetLines(cwd: string, frame = 0, maxLines = 8, providedRuns?: WidgetRun[]): string[] {
	const runs = providedRuns ?? activeWidgetRuns(cwd);
	if (!runs.length) return [];
	const runningGlyph = SPINNER[frame % SPINNER.length] ?? SPINNER[0];
	const lines: string[] = [widgetHeader(runs, runningGlyph, maxLines)];
	for (const { run, agents } of runs) {
		const activeAgents = agents.filter((item) => item.status === "running" || item.status === "queued");
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
	private cwd: string;
	private frame: number;
	private maxLines: number;
	private theme: CrewTheme;
	private cacheSignature: string;
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private cachedBaseLines: string[] = [];
	private cachedTheme: CrewTheme;
	private manifestCache?: ManifestCache;

	constructor(cwd: string, frame: number, maxLines: number, themeLike: unknown, manifestCache?: ManifestCache) {
		this.cwd = cwd;
		this.frame = frame;
		this.maxLines = maxLines;
		this.theme = asCrewTheme(themeLike);
		this.cachedTheme = this.theme;
		this.manifestCache = manifestCache;
		this.cacheSignature = "";
	}

	private buildSignature(runs: WidgetRun[]): string {
		return runs
			.map((entry) => `${entry.run.runId}:${entry.run.status}:${entry.run.updatedAt}:` + entry.agents.map((agent) => `${agent.status}:${agent.startedAt}:${agent.completedAt ?? ""}`).join(","))
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

	render(width: number): string[] {
		const runs = activeWidgetRuns(this.cwd, this.manifestCache);
		const signature = this.buildSignature(runs);
		const runningGlyph = SPINNER[this.frame % SPINNER.length] ?? SPINNER[0];
		const headerGlyph = runs.length ? SPINNER[0] : " ";

		if (this.cacheSignature !== signature || width !== this.cachedWidth || this.cachedTheme !== this.theme) {
			this.cachedBaseLines = buildCrewWidgetLines(this.cwd, 0, this.maxLines, runs).map((line, index) => {
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

function requestRender(ctx: Pick<ExtensionContext, "ui">): void {
	(ctx.ui as { requestRender?: () => void }).requestRender?.();
}

export function updateCrewWidget(
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui">,
	state: CrewWidgetState,
	config?: CrewUiConfig,
	manifestCache?: ManifestCache,
): void {
	if (!ctx.hasUI) return;
	state.frame += 1;
	const maxLines = config?.widgetMaxLines ?? MAX_LINES_DEFAULT;
	const runs = activeWidgetRuns(ctx.cwd, manifestCache);
	const lines = buildCrewWidgetLines(ctx.cwd, state.frame, maxLines, runs);
	const placement = config?.widgetPlacement ?? "aboveEditor";
	ctx.ui.setStatus(STATUS_KEY, lines.length ? statusSummary(runs) : undefined);
	ctx.ui.setWidget(LEGACY_WIDGET_KEY, undefined, { placement });
	if (!lines.length) {
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement });
		requestRender(ctx);
		return;
	}
	ctx.ui.setWidget(
		WIDGET_KEY,
		((_tui: unknown, theme: unknown) => new CrewWidgetComponent(ctx.cwd, state.frame, maxLines, theme, manifestCache)) as never,
		{ placement },
	);
	requestRender(ctx);
}

export function stopCrewWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, state: CrewWidgetState, config?: CrewUiConfig): void {
	if (state.interval) clearInterval(state.interval);
	state.interval = undefined;
	if (ctx?.hasUI) {
		const placement = config?.widgetPlacement ?? "aboveEditor";
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(LEGACY_WIDGET_KEY, undefined, { placement });
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement });
		requestRender(ctx);
	}
}
