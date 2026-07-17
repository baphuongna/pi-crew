/**
 * @deprecated Use tool-renderers/index.ts (teamToolRenderer/agentToolRenderer) instead.
 * This file only exports shared utility functions (truncLine, formatTokens, formatDuration).
 * The render functions below are kept for backward-compatible tests only.
 *
 * Shared rendering for pi-crew's tool TUI display.
 * Ports logic from pi-subagent4 adapted for pi-crew's data model.
 * Uses @earendil-works/pi-tui Components (Container, Text, Spacer) directly.
 */
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import { truncateToWidth } from "../utils/visual.ts";
import { replaceTabs } from "./render-diff.ts";

// ── Types ──────────────────────────────────────────────────────────────
export interface Theme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}
export type ThemeColor = "success" | "error" | "warning" | "dim" | "toolTitle" | "accent" | "muted" | "text";
export interface ToolRenderContext {
	expanded: boolean;
	lastComponent?: Container;
}
export type Component = Container | Text;

export interface TeamToolResultDetails {
	action?: string;
	status?: string;
	runId?: string;
	goal?: string;
	team?: string;
	workflow?: string;
	error?: string;
	agentRecords?: CrewAgentRecord[];
	// FIX (Round 14): `results` is the legacy key used by some subagent
	// responses. Add it here so renderers can read either field without
	// bypassing type checks.
	results?: CrewAgentRecord[];
}
export interface AgentToolResultDetails {
	results?: Array<{
		agentId?: string;
		status?: string;
		output?: string;
		error?: string;
	}>;
}

/** Combined type for renderAgentToolResult — handles both nested details and flat result shapes */
interface AgentResultData extends AgentToolResultDetails {
	agentId?: string;
	status?: string;
	error?: string;
	output?: string;
	runId?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000),
		s = Math.floor((ms % 60_000) / 1000);
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/** @internal */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
	if (!contextWindow) return `${formatTokens(tokens)} ctx`;
	const pct = (tokens / contextWindow) * 100;
	const maxStr = contextWindow >= 1_000_000 ? `${(contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(contextWindow / 1000)}k`;
	return `${pct.toFixed(1)}%/${maxStr}`;
}

export function truncLine(text: string, maxWidth: number): string {
	if (text.includes("\n") || text.includes("\r")) text = text.replace(/\r?\n/g, "↵ ");
	// Round 23 (BUG 4): previously this loop counted 1 visual column per UTF-16
	// code unit and indexed text[i], so for CJK it emitted up to 2x the visual
	// width (frame overflow) and for emoji it split surrogate pairs (U+FFFD).
	// Delegate to the grapheme/ANSI-aware truncateToWidth (keeps ANSI codes,
	// respects double-wide CJK + surrogate pairs, adds the '…' ellipsis).
	return truncateToWidth(text, maxWidth);
}

export function formatToolPreview(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
		case "safe_bash":
			return `$ ${((args.command as string) || "").slice(0, 80)}`;
		case "read":
			return `read ${(args.path as string) || ""}`;
		case "write":
			return `write ${(args.path as string) || ""}`;
		case "edit":
			return `edit ${(args.path as string) || ""}`;
		case "grep":
		case "find":
			return `${name} ${((args.pattern || args.path) as string) || ""}`;
		case "ls":
			return `ls ${(args.path as string) || "."}`;
		case "web_search":
		case "search":
			return `search "${((args.query as string) || "").slice(0, 60)}"`;
		case "web_fetch":
		case "fetch":
			return `fetch ${(args.url as string) || ""}`;
		case "team":
			return `team action=${(args.action as string) || ""}`;
		case "agent":
			return `agent ${(args.agent as string) || ""}`;
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.slice(0, 60)}`;
		}
	}
}

// ── Tool Call Renderers ─────────────────────────────────────────────

/** team tool call: collapsed "team action='run' impl..." / expanded: header + goal */
export function renderTeamToolCall(
	args: { action?: string; goal?: string; team?: string; workflow?: string },
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const action = args.action || "",
		goal = args.goal || "";
	const team = args.team ? ` ${theme.fg("dim", `(${args.team})`)}` : "";

	if (!context.expanded) {
		const preview = goal.length > 60 ? goal.slice(0, 60) + "…" : goal;
		return new Text(
			`${theme.fg("toolTitle", theme.bold("team"))}  action=${theme.fg("accent", `'${action}'`)}${team}${theme.fg("dim", preview ? `  "${preview.replace(/\n/g, " ")}"` : "")}`,
			0,
			0,
		);
	}
	const c = context.lastComponent instanceof Container ? (context.lastComponent.clear(), context.lastComponent) : new Container();
	c.addChild(new Text(`${theme.fg("toolTitle", theme.bold("team"))}  action=${theme.fg("accent", `'${action}'`)}${team}`, 0, 0));
	if (goal) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("text", goal), 0, 0));
	}
	return c;
}

/** agent tool call: collapsed "Agent explorer..." / expanded: header + prompt */
export function renderAgentToolCall(
	args: { agent?: string; prompt?: string; task?: string; cwd?: string },
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const agentName = args.agent || "",
		prompt = args.prompt || args.task || "";

	if (!context.expanded) {
		const preview = prompt.length > 60 ? prompt.slice(0, 60) + "…" : prompt;
		return new Text(
			`${theme.fg("toolTitle", theme.bold("agent"))}  ${theme.fg("accent", agentName)}${theme.fg("dim", preview ? `  "${preview.replace(/\n/g, " ")}"` : "")}`,
			0,
			0,
		);
	}
	const c = context.lastComponent instanceof Container ? (context.lastComponent.clear(), context.lastComponent) : new Container();
	const cwdLabel = args.cwd ? theme.fg("dim", `  (cwd:  ${args.cwd})`) : "";
	c.addChild(new Text(`${theme.fg("toolTitle", theme.bold("agent"))}  ${theme.fg("accent", agentName)}${cwdLabel}`, 0, 0));
	if (prompt) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("text", prompt), 0, 0));
	}
	return c;
}

// ── Agent Progress Renderer ──────────────────────────────────────────

/**
 * Render a single crew agent's progress block.
 * Icon: ⟳ running ○ pending ✓ completed ✗ failed
 * Header: "✓ executor (model) — 5 tools · 12.3s"
 * Tool log: "▸ bash: $ npm test" / "  read: src/index.ts"
 * Usage: "↑12k ↓3k R45k W0 $0.023"
 */
export function renderAgentProgress(record: CrewAgentRecord, theme: Theme, expanded: boolean, w: number): Container {
	const c = new Container();
	const prog = record.progress;
	const isRunning = record.status === "running";
	const isPending = record.status === "queued" || record.status === "waiting";
	const innerW = Math.max(20, w);

	const addLine = (content: string) => c.addChild(new Text(expanded ? content : truncLine(content, innerW), 0, 0));

	// Status icon
	const icon = isRunning
		? theme.fg("warning", "⟳")
		: isPending
			? theme.fg("dim", "○")
			: record.status === "completed"
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");

	// Duration
	const durationMs = prog?.durationMs ?? computeDurationMs(record.startedAt, record.completedAt);
	const stats = `${prog?.toolCount ?? record.toolUses ?? 0} tools · ${formatDuration(durationMs)}`;
	const modelStr = record.model ? ` (${record.model})` : "";
	const roleLabel = record.role || record.agent || "agent";
	addLine(`${icon}  ${theme.fg("toolTitle", theme.bold(roleLabel))}${theme.fg("dim", modelStr)}  —  ${theme.fg("dim", stats)}`);

	// Current tool (running)
	if (isRunning && prog?.currentTool) {
		const toolLabel = formatToolPreview(prog.currentTool, parseArgs(prog.currentToolArgs));
		addLine(theme.fg("warning", `▸  ${prog.currentTool}:  ${toolLabel}`));
	}

	// Recent tools log
	if (prog?.recentTools?.length) {
		for (const tool of prog.recentTools) {
			const detail = tool.args ? `:  ${tool.args}` : "";
			const line = tool.endedAt ? theme.fg("muted", `  ${tool.tool}${detail}`) : theme.fg("warning", `▸  ${tool.tool}${detail}`);
			addLine(line);
		}
	}

	// Last assistant message (prose)
	const lastOutput = prog?.recentOutput?.slice(-1)[0];
	if (lastOutput?.trim()) {
		c.addChild(new Spacer(1));
		addLine(theme.fg("text", truncLine(lastOutput.replace(/\s+/g, " ").trim(), innerW)));
	}

	// Error
	// FIX (Round 20, render-utils sanitization): Sanitize tool-error display so
	// embedded tabs / control chars / newlines / very long strings cannot break
	// the terminal layout. Mirrors the upstream oh-my-pi pattern at
	// packages/coding-agent/src/tools/render-utils.ts:177-185:
	//   formatErrorMessage = replaceTabs(truncateToWidth(clean, LINE_CAP))
	if (record.error) {
		const clean = truncLine(replaceTabs(String(record.error)), innerW);
		addLine(theme.fg("error", `Error: ${clean}`));
	}

	// Usage line
	const usage = record.usage;
	const parts: string[] = [];
	if (usage?.input) parts.push(theme.fg("dim", `↑${formatTokens(usage.input)}`));
	if (usage?.output) parts.push(theme.fg("dim", `↓${formatTokens(usage.output)}`));
	if (usage?.cacheRead) parts.push(theme.fg("dim", `R${formatTokens(usage.cacheRead)}`));
	if (usage?.cacheWrite) parts.push(theme.fg("dim", `W${formatTokens(usage.cacheWrite)}`));
	if (usage?.cost) parts.push(theme.fg("dim", `$${usage.cost.toFixed(3)}`));
	const tokens = prog?.tokens ?? 0;
	if (tokens > 0) parts.push(theme.fg("dim", `${formatTokens(tokens)} ctx`));
	if (parts.length) {
		c.addChild(new Spacer(1));
		addLine(parts.join(" "));
	}

	return c;
}

// ── Tool Result Renderers ──────────────────────────────────────────────

/**
 * FIX (Round 14, M1): Properly typed shape for team-tool result details
 * that may be nested in `result.details` or flattened at the root level.
 * Replaces the prior `as any` casts that bypassed type checking.
 */
interface TeamToolFlattenedDetails {
	action?: string;
	status?: string;
	runId?: string;
	goal?: string;
	error?: string;
	team?: string;
	workflow?: string;
	agentRecords?: unknown[];
	results?: unknown[];
}

/** team tool result: 'run' shows agent progress rows, else compact summary */
export function renderTeamToolResult(
	result: { details?: TeamToolResultDetails; content?: unknown[] } & Record<string, unknown>,
	_options: unknown,
	theme: Theme,
	_context: unknown,
): Component {
	// Handle both nested details (result.details) and flattened result shape (details at root level)
	const d = (result as { details?: TeamToolResultDetails }).details;

	// If details is explicitly undefined/null, check if result itself looks like details (flattened)
	// This handles cases where the result object has details properties at root level
	if (d === undefined || d === null) {
		// Check if result has detail-like properties to treat as flattened details
		if ("action" in result || "status" in result || "runId" in result || "agentRecords" in result) {
			// Use result as the details object (cast through unknown for safety)
			const flat = result as unknown as TeamToolFlattenedDetails;
			const c = new Container();
			const records = (flat.agentRecords ?? flat.results) as CrewAgentRecord[] | undefined;
			if (flat.action === "run" && records?.length) {
				for (const r of records) c.addChild(renderAgentProgress(r, theme, false, 116));
				return c;
			}
			// For 'run' action without records: show goal prominently with status badge
			if (flat.action === "run") {
				const goalText = flat.goal || "";
				const statusBadge = flat.status
					? theme.fg(
							flat.status === "completed" ? "success" : flat.status === "failed" ? "error" : "warning",
							`[${flat.status}]`,
						) + " "
					: "";
				return new Text(statusBadge + theme.fg("text", truncLine(goalText, 116)), 0, 0);
			}
			// For other actions: compact info line
			const parts: string[] = [];
			if (flat.status) parts.push(`status=${flat.status}`);
			if (flat.runId) parts.push(`runId=${flat.runId}`);
			if (flat.error) parts.push(theme.fg("error", `error`));
			if (flat.goal && parts.length === 0) parts.push(theme.fg("dim", truncLine(flat.goal, 116)));
			return new Text(parts.join("  ·  "), 0, 0);
		}
		// No details found, fall back to content
		const text = extractText(result?.content).slice(0, 200);
		return new Text(text, 0, 0);
	}

	const c = new Container();
	// Support both 'results' array from subagents and direct agentRecords
	const records = (d.agentRecords ?? d.results) as CrewAgentRecord[] | undefined;
	if (d.action === "run" && records?.length) {
		for (const r of records) c.addChild(renderAgentProgress(r, theme, false, 116));
		return c;
	}
	const parts: string[] = [];
	if (d.status) parts.push(`status=${d.status}`);
	if (d.runId) parts.push(`runId=${d.runId}`);
	if (d.team) parts.push(`team=${d.team}`);
	if (d.workflow) parts.push(`workflow=${d.workflow}`);
	if (d.error) parts.push(theme.fg("error", `error=${d.error}`));
	if (d.goal) parts.push(theme.fg("dim", truncLine(d.goal, 116)));
	if (parts.length === 0) return new Text(theme.fg("muted", "(no output)"), 0, 0);
	return new Text(parts.join("  ·  "), 0, 0);
}

/** agent tool result: shows agent output rows with status icons */
export function renderAgentToolResult(
	result: { details?: AgentToolResultDetails; content?: unknown[] } & Record<string, unknown>,
	_options: unknown,
	theme: Theme,
	_context: unknown,
): Component {
	// Handle both nested details and flattened result shape
	const d = (result.details ?? result) as AgentResultData;
	const c = new Container();
	const w = 116;

	// Check for results array (from subagent) OR single agent properties (agentId, status)
	const results = d?.results;
	if (results?.length) {
		for (const item of results) {
			const icon =
				item.status === "completed"
					? theme.fg("success", "✓")
					: item.status === "failed"
						? theme.fg("error", "✗")
						: item.status === "running"
							? theme.fg("warning", "⟳")
							: theme.fg("dim", "○");
			const label = item.agentId || "agent";
			c.addChild(new Text(`${icon}  ${theme.fg("toolTitle", theme.bold(label))}`, 0, 0));
			if (item.error) {
				// FIX (Round 20, render-utils sanitization): Sanitize tool-error
				// display so embedded tabs / newlines / very long strings cannot
				// break the TUI border alignment. Mirrors upstream oh-my-pi
				// render-utils.ts:177-185.
				const clean = truncLine(replaceTabs(String(item.error)), w - 2);
				c.addChild(new Text(theme.fg("error", `  Error:  ${clean}`), 0, 0));
			} else if (item.output) {
				for (const line of item.output.split("\n").slice(0, 5))
					c.addChild(new Text(theme.fg("dim", `  ${truncLine(line, w - 2)}`), 0, 0));
			}
		}
		return c;
	}

	// Handle single agent result shape: { agentId, runId, status, output }
	if (d?.agentId) {
		const icon =
			d.status === "completed"
				? theme.fg("success", "✓")
				: d.status === "failed"
					? theme.fg("error", "✗")
					: d.status === "running"
						? theme.fg("warning", "⟳")
						: theme.fg("dim", "○");
		const label = d.agentId;
		c.addChild(new Text(`${icon}  ${theme.fg("toolTitle", theme.bold(label))}`, 0, 0));
		if (d.error) {
			// FIX (Round 20, render-utils sanitization): Same sanitization as
			// above — see renderAgentToolResult header comment.
			const clean = truncLine(replaceTabs(String(d.error)), w - 2);
			c.addChild(new Text(theme.fg("error", `  Error:  ${clean}`), 0, 0));
		} else if (d.output) {
			for (const line of d.output.split("\n").slice(0, 5)) c.addChild(new Text(theme.fg("dim", `  ${truncLine(line, w - 2)}`), 0, 0));
		}
		return c;
	}

	return new Text(extractText(result?.content).slice(0, 200), 0, 0);
}

// ── Utilities ─────────────────────────────────────────────────────────

function extractText(content: unknown[] | undefined): string {
	if (!content) return "(no output)";
	if (!Array.isArray(content)) return String(content);
	return (
		content
			.filter(
				(c): c is Record<string, unknown> => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
			)
			.map((c) => String((c as Record<string, unknown>).text ?? ""))
			.join("\n") || "(no output)"
	);
}

function parseArgs(argsStr: string | undefined): Record<string, unknown> {
	if (!argsStr) return {};
	try {
		const p = JSON.parse(argsStr);
		return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function computeDurationMs(startedAt: string, completedAt?: string): number {
	if (!startedAt) return 0;
	const start = new Date(startedAt).getTime();
	if (Number.isNaN(start)) return 0;
	if (completedAt) {
		const end = new Date(completedAt).getTime();
		return Number.isNaN(end) ? 0 : Math.max(0, end - start);
	}
	return Math.max(0, Date.now() - start);
}
