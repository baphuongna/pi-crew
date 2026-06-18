/**
 * Tool renderer registry — visually rich rendering for team & agent tools.
 *
 * Uses box-drawing chars, progress bars, colored badges, and structured
 * layouts to create a distinctly different TUI appearance.
 * Uses visibleWidth() for ANSI-aware padding so borders align correctly.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CrewTheme } from "../theme-adapter.ts";
import { truncLine, formatTokens, formatDuration } from "../tool-render.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { isBrief, briefToolResult } from "./brief-mode.ts";
import { truncateToWidth } from "../../utils/visual.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface ToolRenderContext {
	expanded: boolean;
	lastComponent?: Container;
	width?: number;
	isPartial?: boolean;
	isError?: boolean;
}

export interface ToolRenderer {
	renderCall(args: Record<string, unknown>, theme: CrewTheme, ctx: ToolRenderContext): Component;
	renderResult(result: Record<string, unknown>, options: unknown, theme: CrewTheme, ctx: ToolRenderContext): Component;
}

export type Component = Container | Text;

// ── ANSI-aware padding ─────────────────────────────────────────────────

/** Pad a string (which may contain ANSI codes) to a target VISUAL width. */
function padVisual(str: string, targetWidth: number): string {
	const vw = visibleWidth(str);
	if (vw >= targetWidth) return str;
	return str + " ".repeat(targetWidth - vw);
}

/** Truncate a string (which may contain ANSI codes) to a target VISUAL width. */
function truncVisual(str: string, maxWidth: number): string {
	if (visibleWidth(str) <= maxWidth) return str;
	// Round 23 (BUG 3): previously used String.slice(0, maxWidth) which counts
	// UTF-16 code units — for CJK that overflows the card by up to 2x, and for
	// emoji it splits a surrogate pair (U+FFFD). Use the grapheme/ANSI-aware
	// truncateToWidth with empty ellipsis (the caller appends its own '…').
	return truncateToWidth(str, maxWidth, "");
}

// ── Visual primitives ──────────────────────────────────────────────────

/** Status icon with color */
function statusBadge(status: string, theme: CrewTheme): string {
	switch (status) {
		case "completed": return theme.fg("success", "●");
		case "failed":
		case "cancelled": return theme.fg("error", "✖");
		case "running": return theme.fg("warning", "◉");
		default: return theme.fg("dim", "○");
	}
}

/** Status icon — compact */
export function statusIcon(status: string, theme: CrewTheme): string {
	switch (status) {
		case "completed": return theme.fg("success", "✓");
		case "failed":
		case "cancelled": return theme.fg("error", "✗");
		case "running": return theme.fg("warning", "⟳");
		default: return theme.fg("dim", "○");
	}
}

/** Short run ID */
function shortId(id: string | undefined): string {
	return id ? id.slice(-8) : "????????";
}

/** Border color based on status */
function borderColorForStatus(status: string): "success" | "error" | "border" {
	switch (status) {
		case "completed": return "success";
		case "failed":
		case "cancelled": return "error";
		default: return "border";
	}
}

/** Build a visual progress bar: ██████░░░░░░ 60% */
function progressBar(ratio: number, barWidth: number, theme: CrewTheme): string {
	const clamped = Math.max(0, Math.min(1, ratio));
	const filled = Math.round(clamped * barWidth);
	const empty = barWidth - filled;
	const bar = theme.fg("success", "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
	const pct = theme.fg("text", ` ${Math.round(clamped * 100)}%`.padStart(5));
	return bar + pct;
}

// ── Frame builder ──────────────────────────────────────────────────────

/** Create a rounded-corner framed card.
 *  With renderShell="self", Pi no longer wraps in Box(1,1).
 *  Frame uses full totalWidth.
 */
import { deriveCardBackground, padWithBackground } from "../card-colors.ts";

/** Create a rounded-corner framed card.
 *  With renderShell="self", Pi no longer wraps in Box(1,1).
 *  Frame uses full totalWidth.
 *  When bgSlot is provided, the interior is filled with a subtle status-tinted
 *  background derived from the theme (mixBg at 8% intensity).
 */
function buildFrame(contentLines: string[], totalWidth: number, theme: CrewTheme, borderSlot: "success" | "error" | "border" | "borderAccent" = "border", bgSlot?: "success" | "error" | "border" | "borderAccent"): string {
	const frameW = totalWidth - 2; // available after Box(1,1) padding
	const innerW = frameW - 2;    // │ chars
	const top = theme.fg(borderSlot, `╭${"─".repeat(innerW)}╮`);
	const bottom = theme.fg(borderSlot, `╰${"─".repeat(innerW)}╯`);
	const v = theme.fg(borderSlot, "│");
	const bg = bgSlot ? deriveCardBackground(theme, bgSlot) : "";

	const lines: string[] = [top];
	for (const line of contentLines) {
		const padded = bg ? padWithBackground(line, innerW, bg) : padVisual(line, innerW);
		lines.push(v + padded + v);
	}
	lines.push(bottom);
	return lines.join("\n");
}

/** Build frame TOP: top border + content lines, NO bottom border.
 *  Pairs with buildFrameBottom() so renderCall + renderResult merge into ONE frame. */
function buildFrameTop(contentLines: string[], totalWidth: number, theme: CrewTheme, borderSlot: "success" | "error" | "border" | "borderAccent" = "border", bgSlot?: "success" | "error" | "border" | "borderAccent"): string {
	const frameW = totalWidth - 2;
	const innerW = frameW - 2;
	const top = theme.fg(borderSlot, `╭${"─".repeat(innerW)}╮`);
	const v = theme.fg(borderSlot, "│");
	const bg = bgSlot ? deriveCardBackground(theme, bgSlot) : "";
	const lines: string[] = [top];
	for (const line of contentLines) {
		const padded = bg ? padWithBackground(line, innerW, bg) : padVisual(line, innerW);
		lines.push(v + padded + v);
	}
	return lines.join("\n");
}

/** Build frame BOTTOM: content lines + bottom border, NO top border.
 *  Pairs with buildFrameTop() so renderCall + renderResult merge into ONE frame. */
function buildFrameBottom(contentLines: string[], totalWidth: number, theme: CrewTheme, borderSlot: "success" | "error" | "border" | "borderAccent" = "border", bgSlot?: "success" | "error" | "border" | "borderAccent"): string {
	const frameW = totalWidth - 2;
	const innerW = frameW - 2;
	const v = theme.fg(borderSlot, "│");
	const bottom = theme.fg(borderSlot, `╰${"─".repeat(innerW)}╯`);
	const bg = bgSlot ? deriveCardBackground(theme, bgSlot) : "";
	const lines: string[] = [];
	for (const line of contentLines) {
		const padded = bg ? padWithBackground(line, innerW, bg) : padVisual(line, innerW);
		lines.push(v + padded + v);
	}
	lines.push(bottom);
	return lines.join("\n");
}

/** Derive border color from context so renderCall's top matches renderResult's bottom. */
function borderFromContext(ctx: ToolRenderContext): "success" | "error" | "borderAccent" {
	if (ctx.isPartial) return "borderAccent";
	if (ctx.isError) return "error";
	return "success";
}

// ── Team Tool Renderer ─────────────────────────────────────────────────

export const teamToolRenderer: ToolRenderer = {
	renderCall(args, theme, ctx) {
		const action = args.action as string ?? "";
		const goal = args.goal as string ?? "";
		const team = args.team as string | undefined;
		const w = (ctx.width || process.stdout.columns || 116);
		const innerW = w - 4;

		const contentLines: string[] = [];

		// Header: action badge + team name
		const actionBadge = theme.fg("accent", `◀ ${action.toUpperCase()} ▶`);
		const teamLabel = team ? `  ${theme.fg("dim", `via ${team}`)}` : "";
		const header = ` ${actionBadge}${teamLabel}`;
		contentLines.push(padVisual(header, innerW));

		// Goal preview (P5: shorten paths)
		if (goal) {
			const maxLen = innerW - 2;
			const preview = shortenPath(goal.replace(/\n/g, " "));
			const previewText = visibleWidth(preview) > maxLen ? truncVisual(preview, maxLen - 1) + "…" : preview;
			contentLines.push(padVisual(` ${theme.fg("dim", previewText)}`, innerW));
		}

		return new Text(buildFrameTop(contentLines, w, theme, borderFromContext(ctx), borderFromContext(ctx)), 0, 0);
	},

	renderResult(result, _options, theme, ctx) {
		try {
			const text = renderTeamResult(result, _options, theme, ctx);
			return new Text(text, 0, 0);
		} catch {
			return new Text(statusIcon("completed", theme) + " done", 0, 0);
		}
	},
};

function renderTeamResult(result: Record<string, unknown>, options: unknown, theme: CrewTheme, ctx: ToolRenderContext): string {
	const d = (result.details ?? result) as Record<string, unknown>;
	const records = (d.agentRecords ?? d.results) as CrewAgentRecord[] | undefined;
	const action = typeof d.action === "string" ? d.action : "";
	const status = typeof d.status === "string" ? d.status : "";
	const runId = typeof d.runId === "string" ? d.runId : "";
	const w = (ctx.width || process.stdout.columns || 116);
	const innerW = w - 4;
	const bColor = borderColorForStatus(status);
	const contentLines: string[] = [];

	// isPartial = tool still streaming — show LIVE progress
	const isPartial = (options as Record<string, unknown>)?.isPartial === true;
	if (isPartial && !ctx.expanded) {
		const content = extractContentText(result?.content);
		const parsed = parseStreamingProgress(content);

		if (parsed) {
			const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
			const frameIdx = Math.floor(Date.now() / 80) % spinnerFrames.length;
			const spinner = theme.fg("accent", spinnerFrames[frameIdx]!);
			const elapsed = formatDuration(parsed.elapsedMs);

			if (parsed.completed != null && parsed.total != null && parsed.total > 0) {
				// ── Real task progress ──
				const ratio = parsed.completed / parsed.total;
				const barW = Math.min(innerW - 22, 30);
				const bar = progressBar(ratio, barW, theme);
				const count = theme.fg("muted", ` ${parsed.completed}/${parsed.total}`);
				contentLines.push(padVisual(` ${spinner} ${theme.fg("toolTitle", theme.bold("crew run"))}  ${theme.fg("dim", elapsed)}`, innerW));
				contentLines.push(padVisual(`   ${bar}${count}`, innerW));
				if (parsed.activeAgent) contentLines.push(padVisual(`   ${theme.fg("dim", parsed.activeAgent)}`, innerW));
			} else {
				// ── Starting phase — animated indeterminate bar ──
				const barW = Math.min(innerW - 20, 30);
				const scanBar = renderScanBar(barW, parsed.elapsedMs, theme);
				contentLines.push(padVisual(` ${spinner} ${theme.fg("muted", "crew starting")}  ${theme.fg("dim", elapsed)}`, innerW));
				contentLines.push(padVisual(`   ${scanBar}`, innerW));
			}
		} else if (content) {
			const preview = truncLine(content.split("\n").filter(Boolean).pop() ?? "", innerW - 4);
			contentLines.push(padVisual(` ${theme.fg("warning", "◉")} ${theme.fg("dim", preview)}`, innerW));
		}

		if (contentLines.length > 0) {
			return buildFrameBottom(contentLines, w, theme, "borderAccent", "borderAccent");
		}
	}

	// Brief mode: compact summary (still framed)
	// But NOT for action=run — those always get progress bar + metrics
	if (isBrief() && !ctx.expanded && action !== "run") {
		const briefText = briefToolResult("team", result as { content?: unknown[] }, theme);
		contentLines.push(padVisual(` ${briefText}`, innerW));
		return buildFrameBottom(contentLines, w, theme, bColor, bColor);
	}

	if (!ctx.expanded) {
		// ── Collapsed: compact framed card ──
		if (action === "run" && records?.length) {
			appendRunCard(contentLines, records, status, runId, theme, innerW);
		} else if (action === "run") {
			const m = d.metrics as Metrics | undefined;
			if (m) {
				appendMetricsCard(contentLines, m, status, runId, theme, innerW);
			} else {
				appendSimpleCard(contentLines, status, runId, theme, innerW);
			}
		} else {
			appendSimpleCard(contentLines, status, runId, theme, innerW);
		}
	} else {
		// ── Expanded: detailed card ──
		if (action === "run" && records?.length) {
			appendExpandedRun(contentLines, records, status, runId, theme, w, innerW);
		} else if (action === "run") {
			const m = d.metrics as Metrics | undefined;
			appendExpandedMetrics(contentLines, m, status, runId, theme, w, innerW);
		} else {
			const text = extractContentText(result?.content);
			contentLines.push(padVisual(` ${text.slice(0, innerW - 2)}`, innerW));
		}
	}

	return buildFrameBottom(contentLines, w, theme, bColor, bColor);
}

// ── Agent Tool Renderer ────────────────────────────────────────────────

export const agentToolRenderer: ToolRenderer = {
	renderCall(args, theme, ctx) {
		const agentName = args.agent as string ?? args.subagent_type as string ?? "";
		const prompt = (args.prompt ?? args.task ?? "") as string;
		const w = (ctx.width || process.stdout.columns || 116);
		const innerW = w - 4;

		const contentLines: string[] = [];
		const badge = theme.fg("accent", `◀ AGENT ▶`);
		const nameTag = theme.fg("toolTitle", theme.bold(agentName));
		contentLines.push(padVisual(` ${badge}  ${nameTag}`, innerW));

		if (prompt) {
			const maxLen = innerW - 2;
			const preview = prompt.replace(/\n/g, " ");
			const previewText = visibleWidth(preview) > maxLen ? truncVisual(preview, maxLen - 1) + "…" : preview;
			contentLines.push(padVisual(` ${theme.fg("dim", previewText)}`, innerW));
		}

		return new Text(buildFrameTop(contentLines, w, theme, borderFromContext(ctx), borderFromContext(ctx)), 0, 0);
	},

	renderResult(result, _options, theme, ctx) {
		try {
			const text = renderAgentResult(result, _options, theme, ctx);
			return new Text(text, 0, 0);
		} catch {
			return new Text(statusIcon("completed", theme) + " agent done", 0, 0);
		}
	},
};

function renderAgentResult(result: Record<string, unknown>, options: unknown, theme: CrewTheme, ctx: ToolRenderContext): string {
	const d = (result.details ?? result) as Record<string, unknown>;
	const results = d.results as Array<Record<string, unknown>> | undefined;
	const w = (ctx.width || process.stdout.columns || 116);
	const innerW = w - 4;
	const status = ((d.status ?? (results?.[0] as Record<string, unknown>)?.status ?? "") as string) || "completed";
	const bColor: "success" | "error" | "border" = status === "completed" ? "success" : status === "failed" ? "error" : "border";

	const contentLines: string[] = [];

	// isPartial = agent still running
	const isPartial = (options as Record<string, unknown>)?.isPartial === true;
	if (isPartial && !ctx.expanded) {
		const spinner = theme.fg("warning", "◉");
		const label = theme.fg("muted", "agent working...");
		contentLines.push(padVisual(` ${spinner} ${label}`, innerW));
		return buildFrameBottom(contentLines, w, theme, "borderAccent", "borderAccent");
	}

	// Brief mode: non-agent results get brief treatment
	if (!results?.length && !d.agentId) {
		const briefText = briefToolResult("agent", result as { content?: unknown[] }, theme);
		contentLines.push(padVisual(` ${briefText}`, innerW));
		return buildFrameBottom(contentLines, w, theme, bColor, bColor);
	}

	if (!ctx.expanded) {
		// Collapsed: compact card
		const badge = statusBadge(status, theme);
		const agentId = (d.agentId as string) ?? (results?.[0] as Record<string, unknown>)?.agentId as string ?? "agent";
		const nameTag = theme.fg("toolTitle", theme.bold(agentId));
		contentLines.push(padVisual(` ${badge} ${nameTag}`, innerW));

		// Error or output preview
		if (d.error) {
			contentLines.push(padVisual(` ${theme.fg("error", truncLine(String(d.error), innerW - 4))}`, innerW));
		} else if (results?.length) {
			const output = (results[0] as Record<string, unknown>).output as string | undefined;
			if (output) {
				const preview = truncLine(output.split("\n")[0] ?? "", innerW - 4);
				contentLines.push(padVisual(` ${theme.fg("muted", preview)}`, innerW));
			}
		}
	} else {
		// Expanded: detailed rows
		if (results?.length) {
			for (let i = 0; i < results.length; i++) {
				const item = results[i]!;
				const icon = statusIcon(item.status as string ?? "", theme);
				const label = theme.fg("toolTitle", theme.bold((item.agentId as string) ?? "agent"));
				contentLines.push(padVisual(` ${icon} ${label}`, innerW));

				if (item.error) {
					contentLines.push(padVisual(`   ${theme.fg("error", truncLine(String(item.error), innerW - 6))}`, innerW));
				} else if (item.output) {
					const outputLines = String(item.output).split("\n").slice(0, 5);
					for (const line of outputLines) {
						contentLines.push(padVisual(`   ${theme.fg("dim", truncLine(line, innerW - 6))}`, innerW));
					}
				}
				// Separator between agents
				if (i < results.length - 1) {
					contentLines.push(padVisual(theme.fg("borderMuted", "─".repeat(innerW - 2)), innerW));
				}
			}
		} else if (d.agentId) {
			const icon = statusIcon(d.status as string ?? "", theme);
			contentLines.push(padVisual(` ${icon} ${theme.fg("toolTitle", theme.bold(d.agentId as string))}`, innerW));
			if (d.error) {
				contentLines.push(padVisual(`   ${theme.fg("error", truncLine(String(d.error), innerW - 6))}`, innerW));
			}
		} else {
			const text = extractContentText(result?.content);
			if (text) contentLines.push(padVisual(` ${theme.fg("dim", truncLine(text, innerW - 4))}`, innerW));
		}
	}

	return buildFrameBottom(contentLines, w, theme, bColor, bColor);
}

// ── Card builders ──────────────────────────────────────────────────────

interface Metrics {
	taskCount?: number;
	completedCount?: number;
	totalTokens?: number;
	totalCost?: number;
	durationMs?: number;
}

function appendRunCard(lines: string[], records: CrewAgentRecord[], status: string, runId: string, theme: CrewTheme, innerW: number): void {
	const completed = records.filter((r) => r.status === "completed").length;
	const total = records.length;
	const duration = computeTotalDuration(records);
	const tokens = computeTotalTokens(records);
	const cost = computeTotalCost(records);

	// Line 1: badge + summary + expand hint (P2)
	const badge = statusBadge(status, theme);
	const title = theme.fg("toolTitle", theme.bold("crew run"));
	const idTag = theme.fg("dim", shortId(runId));
	const hint = theme.fg("dim", "⌘E");
	const left = ` ${badge} ${title}  ${idTag}`;
	const right = `${hint}`;
	const gap = innerW - visibleWidth(left) - visibleWidth(right);
	lines.push(padVisual(left + (gap > 1 ? " ".repeat(gap) : " ") + right, innerW));

	// Line 2: compact metrics + cost (P1)
	const parts: string[] = [];
	parts.push(`${completed}/${total} done`);
	if (duration > 0) parts.push(formatDuration(duration));
	if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
	if (cost > 0) parts.push(`$${cost.toFixed(3)}`);
	lines.push(padVisual(`   ${theme.fg("dim", parts.join(" · "))}`, innerW));
}

function appendMetricsCard(lines: string[], m: Metrics, status: string, runId: string, theme: CrewTheme, innerW: number): void {
	// Line 1: badge + title + expand hint (P2)
	const badge = statusBadge(status, theme);
	const title = theme.fg("toolTitle", theme.bold("crew run"));
	const idTag = theme.fg("dim", shortId(runId));
	const hint = theme.fg("dim", "⌘E");
	const left = ` ${badge} ${title}  ${idTag}`;
	const right = `${hint}`;
	const gap = innerW - visibleWidth(left) - visibleWidth(right);
	lines.push(padVisual(left + (gap > 1 ? " ".repeat(gap) : " ") + right, innerW));

	// Line 2: compact metrics + cost (P1)
	const parts: string[] = [];
	if (m.completedCount != null && m.taskCount) parts.push(`${m.completedCount}/${m.taskCount} done`);
	if (m.durationMs) parts.push(formatDuration(m.durationMs));
	if (m.totalTokens) parts.push(`${formatTokens(m.totalTokens)} tok`);
	if (m.totalCost) parts.push(`$${m.totalCost.toFixed(3)}`);
	if (parts.length) lines.push(padVisual(`   ${theme.fg("dim", parts.join(" · "))}`, innerW));
}

function appendSimpleCard(lines: string[], status: string, runId: string, theme: CrewTheme, innerW: number): void {
	const badge = statusBadge(status, theme);
	const parts: string[] = [status];
	if (runId) parts.push(shortId(runId));
	lines.push(padVisual(` ${badge} ${theme.fg("text", parts.join(" · ") || "done")}`, innerW));
}

function appendExpandedRun(lines: string[], records: CrewAgentRecord[], status: string, runId: string, theme: CrewTheme, w: number, innerW: number): void {
	const completed = records.filter((r) => r.status === "completed").length;
	const total = records.length;
	const ratio = total > 0 ? completed / total : 0;
	const duration = computeTotalDuration(records);
	const tokens = computeTotalTokens(records);

	// Header
	lines.push(padVisual(` ${theme.fg("toolTitle", theme.bold("CREW RUN RESULT"))}  ${theme.fg("dim", shortId(runId))}`, innerW));
	lines.push(padVisual(theme.fg("borderMuted", "─".repeat(innerW - 2)), innerW));

	// Progress bar
	const barW = Math.min(innerW - 22, 40);
	const bar = progressBar(ratio, barW, theme);
	const count = theme.fg("muted", ` ${completed}/${total}`);
	lines.push(padVisual(` ${theme.fg("muted", "Progress")} ${bar}${count}`, innerW));

	// Metrics
	const metricLine = [
		theme.fg("muted", formatDuration(duration)),
		theme.fg("muted", `${formatTokens(tokens)} tok`),
	].join(theme.fg("dim", " · "));
	lines.push(padVisual(` ${metricLine}`, innerW));
	lines.push(padVisual(theme.fg("borderMuted", "─".repeat(innerW - 2)), innerW));

	// Agent rows
	for (const r of records) {
		const icon = statusIcon(r.status, theme);
		const role = theme.fg("toolTitle", theme.bold(r.role || r.agent || "agent"));
		const model = r.model ? theme.fg("dim", ` (${r.model.split("/").at(-1)})`) : "";
		const dur = r.startedAt ? formatDuration(computeRecordDuration(r)) : "";
		const toolCount = `${r.toolUses ?? r.progress?.toolCount ?? 0} tools`;
		lines.push(padVisual(` ${icon} ${role}${model}  ${theme.fg("dim", `${toolCount} · ${dur}`)}`, innerW));

		// Usage
		const usage = r.usage;
		const usageParts: string[] = [];
		if (usage?.input) usageParts.push(theme.fg("dim", `↑${formatTokens(usage.input)}`));
		if (usage?.output) usageParts.push(theme.fg("dim", `↓${formatTokens(usage.output)}`));
		if (usage?.cost) usageParts.push(theme.fg("dim", `$${usage.cost.toFixed(3)}`));
		if (usageParts.length) lines.push(padVisual(`   ${usageParts.join(" ")}`, innerW));
	}
}

function appendExpandedMetrics(lines: string[], m: Metrics | undefined, status: string, runId: string, theme: CrewTheme, w: number, innerW: number): void {
	lines.push(padVisual(` ${theme.fg("toolTitle", theme.bold("CREW RUN RESULT"))}  ${theme.fg("dim", shortId(runId))}`, innerW));
	lines.push(padVisual(theme.fg("borderMuted", "─".repeat(innerW - 2)), innerW));
	if (m) {
		const ratio = m.taskCount ? (m.completedCount ?? 0) / m.taskCount : 0;
		const barW = Math.min(innerW - 22, 40);
		const bar = progressBar(ratio, barW, theme);
		const count = theme.fg("muted", ` ${m.completedCount ?? 0}/${m.taskCount ?? 0}`);
		lines.push(padVisual(` ${bar}${count}`, innerW));
		const parts: string[] = [];
		if (m.durationMs) parts.push(formatDuration(m.durationMs));
		if (m.totalTokens) parts.push(`${formatTokens(m.totalTokens)} tok`);
		if (parts.length) lines.push(padVisual(` ${theme.fg("dim", parts.join(" · "))}`, innerW));
	}
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractContentText(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	// onUpdate appends text blocks — only use the LAST one to avoid stacking
	const texts = content
		.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text");
	if (texts.length === 0) return "";
	return String((texts[texts.length - 1]! as Record<string, unknown>).text ?? "");
}

/** Parse streaming progress text from team-tool progress binder. */
interface StreamingProgress {
	elapsedMs: number;
	completed: number | null;
	total: number | null;
	status: string | null;
	activeAgent: string | null;
}

function parseStreamingProgress(text: string): StreamingProgress | null {
	if (!text) return null;

	// Format: "team status=starting elapsed=11s"
	const elapsedMatch = text.match(/elapsed=(\d+)s/);
	const elapsedMs = elapsedMatch ? parseInt(elapsedMatch[1]!, 10) * 1000 : 0;

	// Format from formatCompactToolProgress: "tasks completed=2 running=1"
	const taskMatch = text.match(/tasks[^\n]*(?:completed|done)=(\d+)[^\n]*(?:running|waiting|queued)=(\d+)/);
	const doneMatch = text.match(/(\d+)\/(\d+)\s+done/);

	// Active agent: "  explorer->explorer turn=5 tokens=1234"
	const agentMatch = text.match(/\s+(\w+)->(\w+)\s+turn=/);
	const activeAgent = agentMatch ? `${agentMatch[1]}/${agentMatch[2]}` : null;

	// Current tool: "  tool: bash (#3)"
	const toolMatch = text.match(/tool:\s+(\S+)/);
	const toolInfo = toolMatch ? ` · ${toolMatch[1]}` : "";

	if (doneMatch) {
		return { elapsedMs, completed: parseInt(doneMatch[1]!, 10), total: parseInt(doneMatch[2]!, 10), status: null, activeAgent: (activeAgent ?? "") + toolInfo };
	}
	if (taskMatch) {
		const done = parseInt(taskMatch[1]!, 10);
		const running = parseInt(taskMatch[2]!, 10);
		const total = done + running;
		return { elapsedMs, completed: done, total, status: null, activeAgent: (activeAgent ?? "") + toolInfo };
	}
	if (elapsedMs > 0) {
		const statusMatch = text.match(/status=(\w+)/);
		return { elapsedMs, completed: null, total: null, status: statusMatch?.[1] ?? null, activeAgent };
	}

	return null;
}

/** Animated scanning bar for indeterminate progress. */
function renderScanBar(barWidth: number, elapsedMs: number, theme: CrewTheme): string {
	const pos = Math.floor((elapsedMs / 400) % (barWidth + 6)) - 3; // bounce range
	const segW = Math.max(3, Math.floor(barWidth * 0.3));
	let bar = "";
	for (let i = 0; i < barWidth; i++) {
		const inSeg = i >= pos && i < pos + segW;
		bar += inSeg ? theme.fg("accent", "█") : theme.fg("dim", "░");
	}
	return bar;
}

function computeTotalDuration(records: CrewAgentRecord[]): number {
	let total = 0;
	for (const r of records) total += computeRecordDuration(r);
	return total;
}

function computeRecordDuration(r: CrewAgentRecord): number {
	if (!r.startedAt) return 0;
	const start = new Date(r.startedAt).getTime();
	const end = r.completedAt ? new Date(r.completedAt).getTime() : Date.now();
	if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
	return Math.max(0, end - start);
}

function computeTotalCost(records: CrewAgentRecord[]): number {
	let total = 0;
	for (const r of records) { if (r.usage?.cost) total += r.usage.cost; }
	return total;
}

function computeTotalTokens(records: CrewAgentRecord[]): number {
	let total = 0;
	for (const r of records) {
		if (r.usage) total += (r.usage.input ?? 0) + (r.usage.output ?? 0) + (r.usage.cacheWrite ?? 0);
	}
	return total;
}

/** P5: Shorten file path by replacing $HOME with ~ */
function shortenPath(p: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (home && p.startsWith(home)) return "~" + p.slice(home.length);
	return p;
}

/** P8: Create clickable file hyperlink via OSC 8 */
function linkPath(p: string, label?: string): string {
	const display = label ?? shortenPath(p);
	return `\x1b]8;;file://${p}\x1b\\${display}\x1b]8;;\x1b\\`;
}
