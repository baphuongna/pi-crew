/**
 * Widget rendering — builds and colorizes widget lines.
 *
 * Extracted from crew-widget.ts.
 */

import type { CrewTheme } from "../theme-adapter.ts";
import { iconForStatus } from "../status-colors.ts";
import { truncate } from "../../utils/visual.ts";
import { Box, Text } from "../layout-primitives.ts";
import { listLiveAgents } from "../../runtime/live-agent-manager.ts";
import { computePhaseProgress, formatPhaseProgressLine } from "../../runtime/phase-progress.ts";
import { spinnerFrame } from "../spinner.ts";
import { agentActivity, agentStats, notificationBadge } from "./widget-formatters.ts";
import { shortRunLabel } from "./widget-model.ts";
import type { WidgetRun } from "./widget-types.ts";
import { layoutSegments, segmentVisibleWidth, type LayoutSegment } from "../status-layout.ts";
import { renderSegmentChain, type PowerlineSegment } from "../powerline-segments.ts";

const MAX_AGENTS_DISPLAY = 3;
const FINISHED_LINGER_MAX_AGE = 1;
const ERROR_LINGER_MAX_AGE = 2;
const ERROR_STATUSES = new Set(["failed", "cancelled", "stopped", "needs_attention"]);

// ── Header ────────────────────────────────────────────────────────────

export function widgetHeader(runs: WidgetRun[], runningGlyph: string, maxLines = 20, notificationCount = 0): string {
	const agents = runs.flatMap((item) => item.agents);
	const runningAgents = agents.filter((a) => a.status === "running").length;
	const queuedAgents = agents.filter((a) => a.status === "queued").length;
	const waitingAgents = agents.filter((a) => a.status === "waiting").length;
	const completedAgents = agents.filter((a) => a.status === "completed").length;
	const parts = [`${runningAgents} running`];
	if (queuedAgents) parts.push(`${queuedAgents} queued`);
	if (waitingAgents) parts.push(`${waitingAgents} waiting`);
	if (completedAgents) parts.push(`${completedAgents}/${agents.length} done`);
	return `${runningGlyph} Crew agents${notificationBadge(notificationCount)} · ${parts.join(" · ")} · /team-dashboard`;
}

/**
 * Powerline-styled widget header (opt-in via config.ui.headerStyle="powerline").
 * Builds the same data as widgetHeader but renders it as filled-bg powerline
 * segments that degrade by tiered 3-state collapse on narrow terminals.
 * Returns "" when the theme lacks bg support (caller falls back to text).
 */
export function powerlineWidgetHeader(
	runs: WidgetRun[],
	runningGlyph: string,
	notificationCount: number,
	theme: CrewTheme,
	width: number,
): string {
	if (typeof theme.bg !== "function") return "";
	const agents = runs.flatMap((item) => item.agents);
	const running = agents.filter((a) => a.status === "running").length;
	const queued = agents.filter((a) => a.status === "queued").length;
	const waiting = agents.filter((a) => a.status === "waiting").length;
	const completed = agents.filter((a) => a.status === "completed").length;

	const segs: Array<{ text: string; bg: string; full: string; collapsed?: string; order: number }> = [];
	const lead = `${runningGlyph} Crew${notificationBadge(notificationCount)}`;
	segs.push({ text: lead, bg: "selectedBg", full: lead, order: 0 });
	if (running > 0) segs.push({ text: `${running} running`, bg: "selectedBg", full: `${running} running`, collapsed: `${running} run`, order: 2 });
	if (queued > 0 || waiting > 0) {
		const q = queued + waiting;
		segs.push({ text: `${q} queued`, bg: "toolPendingBg", full: `${q} queued`, collapsed: `${q}q`, order: 3 });
	}
	if (agents.length > 0) {
		const full = `${completed}/${agents.length} done`;
		const collapsed = `${completed}/${agents.length}`;
		const bg = completed === agents.length ? "toolSuccessBg" : "selectedBg";
		segs.push({ text: full, bg, full, collapsed, order: 1 });
	}
	segs.push({ text: "/team-dashboard", bg: "selectedBg", full: "/team-dashboard", order: 4 });

	const layoutInput: LayoutSegment[] = segs.map((s) => ({
		full: s.full,
		fullWidth: segmentVisibleWidth(s.full),
		collapsed: s.collapsed,
		collapsedWidth: s.collapsed ? segmentVisibleWidth(s.collapsed) : undefined,
		collapseOrder: s.order,
	}));
	const resolved = layoutSegments(layoutInput, width);
	const chain: PowerlineSegment[] = [];
	let si = 0;
	for (const r of resolved) {
		if (r.state === "hidden" || r.text === undefined) { si++; continue; }
		const seg = segs[si]!;
		chain.push({ bg: seg.bg, fg: "text", text: ` ${r.text} ` });
		si++;
	}
	if (chain.length === 0) return "";
	return renderSegmentChain(theme, chain);
}

// ── Line builder ──────────────────────────────────────────────────────

export function buildWidgetLines(cwd: string, frame = 0, maxLines = 8, providedRuns?: WidgetRun[], notificationCount = 0, options?: { theme?: CrewTheme; width?: number; headerStyle?: "default" | "powerline" }): string[] {
	const runs = providedRuns ?? [];
	if (!runs.length) return [];

	const runningGlyph = spinnerFrame("widget-header");
	let header = widgetHeader(runs, runningGlyph, maxLines, notificationCount);
	if (options?.headerStyle === "powerline" && options?.theme && options.width) {
		const pl = powerlineWidgetHeader(runs, runningGlyph, notificationCount, options.theme, options.width);
		if (pl) header = pl;
	}
	const lines: string[] = [header];

	for (const { run, agents, snapshot } of runs) {
		const activeAgents = agents.filter((a) => a.status === "running" || a.status === "queued" || a.status === "waiting");
		const now = Date.now();
		const finishedAgents = agents.filter((item) => {
			if (item.status === "running" || item.status === "queued" || item.status === "waiting") return false;
			if (!item.completedAt) return false;
			const maxAgeMs = (ERROR_STATUSES.has(item.status) ? ERROR_LINGER_MAX_AGE : FINISHED_LINGER_MAX_AGE) * 60_000;
			const age = now - new Date(item.completedAt).getTime();
			return Number.isFinite(age) && age < maxAgeMs;
		});
		const completed = agents.filter((a) => a.status === "completed").length;
		const runGlyph = iconForStatus(run.status, { runningGlyph });
		const phaseLine = snapshot ? formatPhaseProgressLine(computePhaseProgress(snapshot.tasks)) : "";
		const progressPart = phaseLine || `${completed}/${agents.length} done`;
		lines.push(`├─ ${runGlyph} ${shortRunLabel(run)} · ${progressPart} · ${run.runId.slice(-8)}`);

		const liveForRun = listLiveAgents().filter((a) => a.runId === run.runId);

		for (const agent of finishedAgents.slice(0, 2)) {
			const liveHandle = liveForRun.find((h) => h.taskId === agent.taskId);
			const name = liveHandle?.agent ?? agent.agent;
			const icon = agent.status === "completed" ? "✓" : agent.status === "failed" ? "✗" : agent.status === "needs_attention" ? "⚠" : "▪";
			const stats = agentStats(agent, liveHandle);
			const desc = liveHandle?.description ?? agent.role;
			lines.push(`│  ├─ ${icon} ${name} · ${desc}${stats ? ` · ${stats}` : ""}`);
		}

		const visibleAgents = activeAgents.slice(0, MAX_AGENTS_DISPLAY);
		for (const [index, agent] of visibleAgents.entries()) {
			const last = index === visibleAgents.length - 1 && activeAgents.length <= MAX_AGENTS_DISPLAY;
			const branch = last ? "└─" : "├─";
			const agentGlyph = iconForStatus(agent.status, { runningGlyph });
			const liveHandle = liveForRun.find((h) => h.taskId === agent.taskId);
			const stats = agentStats(agent, liveHandle);
			const name = liveHandle?.agent ?? agent.agent;
			const desc = liveHandle?.description ?? agent.role;
			lines.push(`│  ${branch} ${agentGlyph} ${name}${desc ? ` · ${desc}` : ` · ${agent.role}`}`);
			lines.push(`│     ⊶ ${agentActivity(agent, liveHandle)}${stats ? ` · ${stats}` : ""}`);
		}

		if (activeAgents.length > MAX_AGENTS_DISPLAY) {
			lines.push(`│  └─ … +${activeAgents.length - MAX_AGENTS_DISPLAY} more agents`);
		}

		if (lines.length >= maxLines) break;
	}

	return lines.slice(0, maxLines);
}

// ── Colorization ──────────────────────────────────────────────────────

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

export function colorWidgetLine(line: string, index: number, theme: CrewTheme): string {
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

export function renderLines(lines: string[], width: number): string[] {
	const box = new Box(0, 0);
	for (const line of lines) {
		box.addChild(new Text(line));
	}
	return box.render(width);
}
