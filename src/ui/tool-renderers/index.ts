/**
 * Tool renderer registry and types.
 *
 * Each tool gets a focused renderer that handles both collapsed and expanded
 * display. Inspired by oh-my-pi's rendering-only override pattern.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import type { CrewTheme } from "../theme-adapter.ts";
import { truncLine, formatTokens, formatDuration } from "../tool-render.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface ToolRenderContext {
	expanded: boolean;
	lastComponent?: Container;
	width?: number;
}

export interface ToolRenderer {
	renderCall(args: Record<string, unknown>, theme: CrewTheme, ctx: ToolRenderContext): Component;
	renderResult(result: Record<string, unknown>, options: unknown, theme: CrewTheme, ctx: ToolRenderContext): Component;
}

export type Component = Container | Text;

// ── Team Tool Renderer ─────────────────────────────────────────────────

export const teamToolRenderer: ToolRenderer = {
	renderCall(args, theme, ctx) {
		const action = args.action as string ?? "";
		const goal = args.goal as string ?? "";
		const team = args.team as string | undefined;
		const teamLabel = team ? ` ${theme.fg("dim", `(${team})`)}` : "";

		if (!ctx.expanded) {
			const preview = goal.length > 60 ? goal.slice(0, 60) + "…" : goal;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("team"))}  action=${theme.fg("accent", `'${action}'`)}${teamLabel}${theme.fg("dim", preview ? `  "${preview.replace(/\n/g, " ")}"` : "")}`,
				0, 0,
			);
		}

		const c = ctx.lastComponent instanceof Container ? (ctx.lastComponent.clear(), ctx.lastComponent) : new Container();
		c.addChild(new Text(`${theme.fg("toolTitle", theme.bold("team"))}  action=${theme.fg("accent", `'${action}'`)}${teamLabel}`, 0, 0));
		if (goal) {
			c.addChild(new Text("", 0, 0)); // spacer
			c.addChild(new Text(theme.fg("text", goal), 0, 0));
		}
		return c;
	},

	renderResult(result, _options, theme, ctx) {
		const d = (result.details ?? result) as Record<string, unknown>;
		const records = (d.agentRecords ?? d.results) as CrewAgentRecord[] | undefined;
		const action = typeof d.action === "string" ? d.action : "";
		const status = typeof d.status === "string" ? d.status : "";
		const runId = typeof d.runId === "string" ? d.runId : "";

		// Compact: one-line summary
		if (!ctx.expanded) {
			if (action === "run" && records?.length) {
				return renderCompactRunSummary(records, theme);
			}
			if (action === "run") {
				const goal = typeof d.goal === "string" ? d.goal : "";
				const icon = statusIcon(status, theme);
				return new Text(`${icon} ${theme.fg("text", truncLine(goal, 100))}`, 0, 0);
			}
			const parts: string[] = [];
			if (status) parts.push(`status=${status}`);
			if (runId) parts.push(`runId=${runId.slice(-8)}`);
			if (d.error) parts.push(theme.fg("error", "error"));
			if (d.goal && !parts.length) parts.push(theme.fg("dim", truncLine(d.goal as string, 100)));
			return new Text(parts.join("  ·  ") || theme.fg("muted", "(no output)"), 0, 0);
		}

		// Expanded: agent progress rows
		if (action === "run" && records?.length) {
			const c = new Container();
			for (const r of records) {
				c.addChild(renderAgentRow(r, theme, ctx.width ?? 116));
			}
			return c;
		}

		// Fallback: content text
		const text = extractContentText(result?.content);
		return new Text(text.slice(0, 200), 0, 0);
	},
};

// ── Agent Tool Renderer ────────────────────────────────────────────────

export const agentToolRenderer: ToolRenderer = {
	renderCall(args, theme, _ctx) {
		const agentName = args.agent as string ?? "";
		const prompt = (args.prompt ?? args.task ?? "") as string;
		const preview = prompt.length > 60 ? prompt.slice(0, 60) + "…" : prompt;
		return new Text(
			`${theme.fg("toolTitle", theme.bold("agent"))}  ${theme.fg("accent", agentName)}${theme.fg("dim", preview ? `  "${preview.replace(/\n/g, " ")}"` : "")}`,
			0, 0,
		);
	},

	renderResult(result, _options, theme, ctx) {
		const d = (result.details ?? result) as Record<string, unknown>;
		const results = d.results as Array<Record<string, unknown>> | undefined;
		const w = ctx.width ?? 116;

		if (results?.length) {
			const c = new Container();
			for (const item of results) {
				const icon = statusIcon(item.status as string ?? "", theme);
				const label = (item.agentId as string) ?? "agent";
				c.addChild(new Text(`${icon}  ${theme.fg("toolTitle", theme.bold(label))}`, 0, 0));
				if (item.error) {
					c.addChild(new Text(theme.fg("error", `  Error: ${truncLine(String(item.error), w - 2)}`), 0, 0));
				} else if (item.output) {
					for (const line of String(item.output).split("\n").slice(0, 5)) {
						c.addChild(new Text(theme.fg("dim", `  ${truncLine(line, w - 2)}`), 0, 0));
					}
				}
			}
			return c;
		}

		if (d.agentId) {
			const icon = statusIcon(d.status as string ?? "", theme);
			const c = new Container();
			c.addChild(new Text(`${icon}  ${theme.fg("toolTitle", theme.bold(d.agentId as string))}`, 0, 0));
			if (d.error) {
				c.addChild(new Text(theme.fg("error", `  Error: ${truncLine(String(d.error), w - 2)}`), 0, 0));
			} else if (d.output) {
				for (const line of String(d.output).split("\n").slice(0, 5)) {
					c.addChild(new Text(theme.fg("dim", `  ${truncLine(line, w - 2)}`), 0, 0));
				}
			}
			return c;
		}

		const text = extractContentText(result?.content);
		return new Text(text.slice(0, 200), 0, 0);
	},
};

// ── Helpers ────────────────────────────────────────────────────────────

function statusIcon(status: string, theme: CrewTheme): string {
	switch (status) {
		case "completed": return theme.fg("success", "✓");
		case "failed": case "cancelled": return theme.fg("error", "✗");
		case "running": return theme.fg("warning", "⟳");
		case "queued": case "waiting": return theme.fg("dim", "○");
		default: return theme.fg("dim", "○");
	}
}

function renderCompactRunSummary(records: CrewAgentRecord[], theme: CrewTheme): Text {
	const completed = records.filter((r) => r.status === "completed").length;
	const total = records.length;
	const duration = computeTotalDuration(records);
	const tokens = computeTotalTokens(records);
	const cost = computeTotalCost(records);
	const icon = completed === total ? theme.fg("success", "✓") : theme.fg("warning", "⟳");
	const parts: string[] = [`${completed}/${total} tasks`];
	if (duration > 0) parts.push(formatDuration(duration));
	if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
	if (cost > 0) parts.push(`$${cost.toFixed(3)}`);
	return new Text(`${icon} ${parts.join(" · ")}`, 0, 0);
}

function renderAgentRow(record: CrewAgentRecord, theme: CrewTheme, w: number): Container {
	const c = new Container();
	const icon = statusIcon(record.status, theme);
	const role = record.role || record.agent || "agent";
	const model = record.model ? ` (${record.model.split("/").at(-1)})` : "";
	const durationMs = record.startedAt
		? Math.max(0, (record.completedAt ? new Date(record.completedAt).getTime() : Date.now()) - new Date(record.startedAt).getTime())
		: 0;
	const stats = `${record.toolUses ?? record.progress?.toolCount ?? 0} tools · ${formatDuration(durationMs)}`;
	c.addChild(new Text(`${icon}  ${theme.fg("toolTitle", theme.bold(role))}${theme.fg("dim", model)}  —  ${theme.fg("dim", stats)}`, 0, 0));
	// Usage line
	const usage = record.usage;
	const parts: string[] = [];
	if (usage?.input) parts.push(theme.fg("dim", `↑${formatTokens(usage.input)}`));
	if (usage?.output) parts.push(theme.fg("dim", `↓${formatTokens(usage.output)}`));
	if (usage?.cost) parts.push(theme.fg("dim", `$${usage.cost.toFixed(3)}`));
	if (parts.length) {
		c.addChild(new Text(`  ${parts.join(" ")}`, 0, 0));
	}
	return c;
}

function extractContentText(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content
		.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
		.map((c) => String((c as Record<string, unknown>).text ?? ""))
		.join("\n");
}

function computeTotalDuration(records: CrewAgentRecord[]): number {
	let total = 0;
	for (const r of records) {
		if (r.startedAt) {
			const start = new Date(r.startedAt).getTime();
			const end = r.completedAt ? new Date(r.completedAt).getTime() : Date.now();
			if (Number.isFinite(start) && Number.isFinite(end)) total += Math.max(0, end - start);
		}
	}
	return total;
}

function computeTotalTokens(records: CrewAgentRecord[]): number {
	let total = 0;
	for (const r of records) {
		if (r.usage) total += (r.usage.input ?? 0) + (r.usage.output ?? 0) + (r.usage.cacheWrite ?? 0);
	}
	return total;
}

function computeTotalCost(records: CrewAgentRecord[]): number {
	let total = 0;
	for (const r of records) {
		if (r.usage?.cost) total += r.usage.cost;
	}
	return total;
}
