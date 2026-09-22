/**
 * Tool renderer registry — RAIL design language (R3, 2026-09-16).
 *
 * Visual grammar (a full redesign; the previous rounded-box + `◀ BADGE ▶`
 * frame language is gone):
 *
 *   ┏ ┃ ┗   a vertical RAIL down the left edge marks one tool call.
 *           `┏` opens the card (call half), `┃` continues it (streaming /
 *           expanded rows), `┗` closes it with the outcome summary and the
 *           end cap. The rail colour carries status: neutral while idle,
 *           accent while streaming, green on success, red on failure.
 *
 *   `NAME ▸ SUBJECT`   identity canopy: `CREW ▸ implementation`,
 *                      `AGENT ▸ explorer`, `STATUS ▸ _ui_demo`.
 *
 *   `······`           dot leaders connect the left and right segments of a
 *                      line (metrics ↔ elapsed/expand-chord hint), and shrink to a
 *                      two-space gap when the column is too narrow.
 *
 *   `▕████▎░░▏`        gauge bar with EIGHTH-BLOCK sub-cell precision, so a
 *                      narrow column still shows meaningful progress.
 *
 * Cards are width-deferred through AdaptiveCard: the builder receives the
 * real render width, so nothing is "baked" at an assumed terminal size and
 * no line ever wraps into a torn frame.
 */

import { type Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { AdaptiveCard } from "../adaptive-card.ts";
import type { CrewComponent } from "../component.ts";
import { formatCount, formatDuration, formatTokens, truncLine } from "../format-helpers.ts";
import {
	ACTIVE,
	dedupeAgentLabel,
	gaugeBar,
	PI_EXPAND_CHORD,
	RAIL,
	type RailSlot,
	railLeaders,
	railLine,
	scanGauge,
	shortId,
	statusBadge,
	statusIcon,
	statusSlot,
	truncVisual,
} from "../rail.ts";
import { spinnerClockNow, spinnerFrame } from "../spinner.ts";
import type { CrewTheme } from "../theme-adapter.ts";
import { parseCompactToolProgress } from "../tool-progress-formatter.ts";
import { briefToolResult, isBrief } from "./brief-mode.ts";

// statusIcon stays part of this module's public API (team-tool.ts imports it
// from here); the implementation moved to the shared RAIL module.
export { statusIcon };

// ── Types ──────────────────────────────────────────────────────────────

export interface ToolRenderContext {
	expanded: boolean;
	lastComponent?: Container;
	/** Pi's ToolRenderContext carries no width — the render width is real. */
	width?: number;
	isPartial?: boolean;
	isError?: boolean;
	/** Pi signals (available since R1 audit): args may still be streaming in. */
	argsComplete?: boolean;
	executionStarted?: boolean;
}

export interface ToolRenderer {
	renderCall(args: Record<string, unknown>, theme: CrewTheme, ctx: ToolRenderContext): Component;
	renderResult(result: Record<string, unknown>, options: unknown, theme: CrewTheme, ctx: ToolRenderContext): Component;
}

export type Component = Container | Text | AdaptiveCard;

// PR-G3 (UI-3): `Container | Text` structurally satisfies the shared
// CrewComponent contract — both come from @earendil-works/pi-tui and each
// implements the library `Component` interface (render + invalidate). The
// assertion below makes the relationship compiler-enforced without changing
// the exported union type or any behavior.
type _AssertComponentIsCrewComponent = Container extends CrewComponent ? (Text extends CrewComponent ? true : never) : never;

// ── RAIL primitives ────────────────────────────────────────────────────
//
// Rail glyphs, leaders, gauge, status glyphs and the width helpers now live in
// the shared `src/ui/rail.ts` (RAIL design system, 2026-09-16) so every
// pi-crew surface draws from ONE source instead of each re-declaring `┏ ┃ ┗`.
// The tool-card-specific pieces stay here: the canopy composition (CREW /
// AGENT / STATUS) and the status→slot choice for the OPEN half of a card.

/** Rail colour for the OPEN half — the call was made; outcome unknown yet. */
function railOpenSlot(ctx: ToolRenderContext): RailSlot {
	if (ctx.isError) return "error";
	if (ctx.isPartial) return "borderAccent";
	return "border";
}

/** Rail colour for the CLOSE half — the outcome is known here. */
function railCloseSlot(status: string, ctx: ToolRenderContext): RailSlot {
	if (ctx.isError) return "error";
	return statusSlot(status);
}

// ── Identity canopy ────────────────────────────────────────────────────

/**
 * `┏ CREW ▸ implementation` / `┏ STATUS ▸ _ui_demo` / `┏ AGENT ▸ explorer`.
 * `action === "run"` promotes the subject (team) and the canopy word becomes
 * the brand; for any other action the action IS the identity.
 */
function canopy(args: {
	action?: string;
	team?: string;
	agentName?: string;
	runId?: string;
	theme: CrewTheme;
	ctx: ToolRenderContext;
	budget: number;
}): string {
	const { action = "", team, agentName, runId, theme, ctx, budget } = args;
	const isRun = !action || action === "run";
	const word = agentName !== undefined ? "AGENT" : isRun ? "CREW" : (action || "…").toUpperCase();
	const subject = agentName !== undefined ? agentName : isRun ? (team ?? "") : (team ?? shortRun(runId));
	// Subject rules: a real subject always prints; while args are still
	// streaming a `▸ …` placeholder signals "not parsed yet"; a COMPLETE call
	// with nothing to name (e.g. `team action=list`) prints the word alone —
	// a dangling chevron there would read as a bug.
	const streamingArgs = ctx.argsComplete === false;
	const tail = subject
		? ` ${theme.fg("dim", ACTIVE)} ${theme.fg("toolTitle", theme.bold(subject))}`
		: streamingArgs
			? ` ${theme.fg("dim", ACTIVE)} ${theme.fg("toolTitle", theme.bold("…"))}`
			: "";
	const label = `${theme.fg("accent", theme.bold(word))}${tail}`;
	return railLine(RAIL.open, railOpenSlot(ctx), label, theme, budget);
}

function shortRun(runId: string | undefined): string {
	return runId ? shortId(runId) : "";
}

// ── Shared line builders ───────────────────────────────────────────────

/** Dim preview line (goals, prompts, output snippets) with visual truncation. */
function previewLine(glyph: string, slot: RailSlot, text: string, theme: CrewTheme, budget: number, shorten = false): string {
	const flat = (shorten ? shortenPath(text) : text).replace(/\n/g, " ");
	const maxLen = budget - 2;
	const body = visibleWidth(flat) > maxLen ? `${truncVisual(flat, maxLen - 1)}…` : flat;
	return railLine(glyph, slot, theme.fg("dim", body), theme, budget);
}

/** `n/m · pct%` tally shared by streaming and expanded gauges. */
function tallyText(completed: number, total: number, theme: CrewTheme): string {
	const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
	return theme.fg("muted", `${completed}/${total} · ${pct}%`);
}

// ── Team Tool Renderer ─────────────────────────────────────────────────

export const teamToolRenderer: ToolRenderer = {
	renderCall(args, theme, ctx) {
		return new AdaptiveCard(
			(w) => {
				const budget = w - 2;
				const action = (args.action as string) ?? "";
				const goal = (args.goal as string) ?? "";
				const team = args.team as string | undefined;
				const lines = [canopy({ action, team, runId: (args.runId as string) ?? (args.run as string), theme, ctx, budget })];
				if (goal) lines.push(previewLine(RAIL.body, "border", goal, theme, budget, true));
				return lines.join("\n");
			},
			(text) => theme.fg("error", text),
		);
	},

	renderResult(result, _options, theme, ctx) {
		try {
			return new AdaptiveCard(
				(w) => renderTeamResult(result, _options, theme, ctx, w),
				(text) => theme.fg("error", text),
			);
		} catch (e) {
			// FAIL-VISIBLE: a render bug or an unexpected payload shape must
			// never masquerade as a successful card.
			const msg = e instanceof Error ? e.message : String(e);
			return new Text(theme.fg("error", `✖ crew render error: ${truncLine(msg, 56)}`), 0, 0);
		}
	},
};

function renderTeamResult(result: Record<string, unknown>, options: unknown, theme: CrewTheme, ctx: ToolRenderContext, w: number): string {
	const d = (result.details ?? result) as Record<string, unknown>;
	const records = (d.agentRecords ?? d.results) as CrewAgentRecord[] | undefined;
	const action = typeof d.action === "string" ? d.action : "";
	const status = typeof d.status === "string" ? d.status : "";
	const runId = typeof d.runId === "string" ? d.runId : "";
	const teamName = typeof d.team === "string" ? d.team : "";
	const budget = w - 2;
	const closeSlot = railCloseSlot(status, ctx);

	// ── Streaming (partial result, collapsed view) ──
	const isPartial = (options as Record<string, unknown>)?.isPartial === true;
	if (isPartial && !ctx.expanded) {
		const parsed = parseStreamingProgress(extractContentText(result?.content));
		if (parsed) {
			const spinner = theme.fg("accent", spinnerFrame(String(spinnerClockNow())));
			const elapsed = theme.fg("dim", formatDuration(parsed.elapsedMs));
			const lines: string[] = [];

			if (parsed.completed != null && parsed.total != null && parsed.total > 0) {
				const ratio = parsed.completed / parsed.total;
				const barW = Math.min(Math.max(8, budget - 26), 32);
				const left = `${spinner} ${tallyText(parsed.completed, parsed.total, theme)} ${gaugeBar(ratio, barW, theme)}`;
				lines.push(railLine(RAIL.body, "borderAccent", railLeaders(left, elapsed, budget, theme), theme, budget));
				if (parsed.activeAgent) {
					const dot = theme.fg("accent", spinnerFrame(parsed.activeAgent));
					const label = dedupeAgentLabel(parsed.activeAgent);
					lines.push(railLine(RAIL.body, "border", `  ${dot} ${theme.fg("dim", label)}`, theme, budget));
				}
			} else {
				const barW = Math.min(Math.max(8, budget - 24), 32);
				const left = `${spinner} ${theme.fg("muted", "starting")} ${scanGauge(barW, parsed.elapsedMs, theme)}`;
				lines.push(railLine(RAIL.body, "borderAccent", railLeaders(left, elapsed, budget, theme), theme, budget));
			}
			return lines.join("\n");
		}
		const fallback = extractContentText(result?.content).split("\n").filter(Boolean).pop();
		if (fallback) {
			return railLine(RAIL.body, "borderAccent", `${theme.fg("warning", "◉")} ${theme.fg("dim", fallback)}`, theme, budget);
		}
	}

	// ── Brief mode: single end-cap line (never for action=run) ──
	if (isBrief() && !ctx.expanded && action !== "run") {
		const briefText = briefToolResult("team", result as { content?: unknown[] }, theme);
		return railLine(RAIL.close, closeSlot, `${briefText}`, theme, budget);
	}

	// ── Closed card ──
	if (!ctx.expanded) {
		if (action === "run" && records?.length) {
			return railLine(RAIL.close, closeSlot, `${runCap(records, status, teamName, theme, budget)}`, theme, budget);
		}
		if (action === "run") {
			const m = d.metrics as Metrics | undefined;
			return railLine(RAIL.close, closeSlot, `${metricsCap(m, status, theme)}`, theme, budget);
		}
		const badge = statusBadge(status, theme);
		const label = [status || "done", runId ? shortId(runId) : ""].filter(Boolean).join(" · ");
		return railLine(RAIL.close, closeSlot, `${badge} ${theme.fg("text", label)}`, theme, budget);
	}

	// ── Expanded card ──
	const lines: string[] = [];
	if (action === "run" && records?.length) {
		const completed = records.filter((r) => r.status === "completed").length;
		const ratio = records.length > 0 ? completed / records.length : 0;
		const barW = Math.min(Math.max(8, budget - 26), 40);
		lines.push(
			railLine(RAIL.body, "border", `${gaugeBar(ratio, barW, theme)} ${tallyText(completed, records.length, theme)}`, theme, budget),
		);
		for (const r of records) {
			lines.push(railLine(RAIL.body, "border", agentRow(r, theme, budget), theme, budget));
			const usage = usageRow(r, theme, budget);
			if (usage) lines.push(railLine(RAIL.body, "border", usage, theme, budget));
		}
		const duration = computeTotalDuration(records);
		const tokens = computeTotalTokens(records);
		const cost = computeTotalCost(records);
		const tail = [teamName, formatDuration(duration), `${formatTokens(tokens)} tok`, cost > 0 ? `$${cost.toFixed(3)}` : ""]
			.filter(Boolean)
			.join(" · ");
		lines.push(
			railLine(
				RAIL.close,
				closeSlot,
				railLeaders(theme.fg("muted", tail), theme.fg("dim", PI_EXPAND_CHORD), budget, theme),
				theme,
				budget,
			),
		);
		return lines.join("\n");
	}
	if (action === "run") {
		const m = d.metrics as Metrics | undefined;
		if (m?.taskCount) {
			const ratio = (m.completedCount ?? 0) / m.taskCount;
			const barW = Math.min(Math.max(8, budget - 26), 40);
			lines.push(
				railLine(
					RAIL.body,
					"border",
					`${gaugeBar(ratio, barW, theme)} ${tallyText(m.completedCount ?? 0, m.taskCount, theme)}`,
					theme,
					budget,
				),
			);
		}
		const parts: string[] = [];
		if (m?.durationMs) parts.push(formatDuration(m.durationMs));
		if (m?.totalTokens) parts.push(`${formatTokens(m.totalTokens)} tok`);
		lines.push(railLine(RAIL.close, closeSlot, `${theme.fg("muted", parts.join(" · ") || "done")}`, theme, budget));
		return lines.join("\n");
	}
	// Non-run action, expanded: the raw payload.
	lines.push(previewLine(RAIL.body, "border", extractContentText(result?.content), theme, budget));
	lines.push(railLine(RAIL.close, closeSlot, "", theme, budget));
	return lines.join("\n");
}

/** End-cap for a finished run: `● 5/5 · implementation · 24m4s · 103k tok · $0.204 ···· ctrl+o`. */
function runCap(records: CrewAgentRecord[], status: string, teamName: string, theme: CrewTheme, budget: number): string {
	const completed = records.filter((r) => r.status === "completed").length;
	const duration = computeTotalDuration(records);
	const tokens = computeTotalTokens(records);
	const cost = computeTotalCost(records);
	const badge = statusBadge(status, theme);
	const parts = [
		`${completed}/${records.length}`,
		teamName,
		formatDuration(duration),
		`${formatTokens(tokens)} tok`,
		cost > 0 ? `$${cost.toFixed(3)}` : "",
	].filter(Boolean);
	return railLeaders(`${badge} ${theme.fg("text", parts.join(" · "))}`, theme.fg("dim", PI_EXPAND_CHORD), budget, theme);
}

function metricsCap(m: Metrics | undefined, status: string, theme: CrewTheme): string {
	const badge = statusBadge(status, theme);
	const parts: string[] = [];
	if (m?.completedCount != null && m.taskCount) parts.push(`${m.completedCount}/${m.taskCount}`);
	if (m?.durationMs) parts.push(formatDuration(m.durationMs));
	if (m?.totalTokens) parts.push(`${formatTokens(m.totalTokens)} tok`);
	if (m?.totalCost) parts.push(`$${m.totalCost.toFixed(3)}`);
	return `${badge} ${theme.fg("text", parts.join(" · ") || status || "done")}`;
}

/** `✓ explorer (gpt-5) · 2m1s` */
function agentRow(r: CrewAgentRecord, theme: CrewTheme, budget: number): string {
	const icon = statusIcon(r.status, theme);
	const role = theme.fg("toolTitle", theme.bold(r.role || r.agent || "agent"));
	const model = r.model ? theme.fg("dim", ` (${r.model.split("/").at(-1)})`) : "";
	const tools = formatCount(r.toolUses ?? r.progress?.toolCount ?? 0, "tool");
	const dur = r.startedAt ? formatDuration(computeRecordDuration(r)) : "";
	return `${icon} ${role}${model} ${theme.fg("dim", [tools, dur].filter(Boolean).join(" · "))}`;
}

/** `   ↑12k ↓4.1k $0.031` (omitted when the agent reported no usage). */
function usageRow(r: CrewAgentRecord, theme: CrewTheme, budget: number): string | undefined {
	const usage = r.usage;
	const parts: string[] = [];
	if (usage?.input) parts.push(theme.fg("dim", `↑${formatTokens(usage.input)}`));
	if (usage?.output) parts.push(theme.fg("dim", `↓${formatTokens(usage.output)}`));
	if (usage?.cost) parts.push(theme.fg("dim", `$${usage.cost.toFixed(3)}`));
	return parts.length ? `  ${parts.join(" ")}` : undefined;
}

// ── Agent Tool Renderer ────────────────────────────────────────────────

export const agentToolRenderer: ToolRenderer = {
	renderCall(args, theme, ctx) {
		return new AdaptiveCard(
			(w) => {
				const budget = w - 2;
				const agentName = (args.agent as string) ?? (args.subagent_type as string) ?? "";
				const prompt = (args.prompt ?? args.task ?? "") as string;
				const lines = [canopy({ agentName, theme, ctx, budget })];
				if (prompt) lines.push(previewLine(RAIL.body, "border", prompt, theme, budget));
				return lines.join("\n");
			},
			(text) => theme.fg("error", text),
		);
	},

	renderResult(result, _options, theme, ctx) {
		try {
			return new AdaptiveCard(
				(w) => renderAgentResult(result, _options, theme, ctx, w),
				(text) => theme.fg("error", text),
			);
		} catch (e) {
			// FAIL-VISIBLE — mirror the team renderer's error card.
			const msg = e instanceof Error ? e.message : String(e);
			return new Text(theme.fg("error", `✖ agent render error: ${truncLine(msg, 56)}`), 0, 0);
		}
	},
};

function renderAgentResult(result: Record<string, unknown>, options: unknown, theme: CrewTheme, ctx: ToolRenderContext, w: number): string {
	const d = (result.details ?? result) as Record<string, unknown>;
	const results = d.results as Array<Record<string, unknown>> | undefined;
	const budget = w - 2;
	const status = ((d.status ?? (results?.[0] as Record<string, unknown>)?.status ?? "") as string) || "completed";
	const closeSlot = railCloseSlot(status, ctx);

	// ── Streaming ──
	const isPartial = (options as Record<string, unknown>)?.isPartial === true;
	if (isPartial && !ctx.expanded) {
		const name = (d.agentName as string) ?? (d.agentId as string) ?? "agent";
		const spinner = theme.fg("accent", spinnerFrame(String(d.agentId ?? "")));
		const meta: string[] = [];
		const progressText = extractContentText(result?.content);
		if (progressText) {
			const parsed = parseCompactToolProgress(progressText);
			const elapsedSec = parsed ? Math.round(parsed.elapsedMs / 1000) : 0;
			const tokens = parsed?.tokens ?? 0;
			const tps = elapsedSec > 0 ? Math.round(tokens / elapsedSec) : 0;
			if (elapsedSec > 0) meta.push(formatDuration(elapsedSec * 1000));
			if (tps > 0) meta.push(`${formatTokens(tps)} tok/s`);
			if (parsed?.currentTool) meta.push(parsed.currentTool);
		}
		const left = `${spinner} ${theme.fg("toolTitle", theme.bold(name))}`;
		return railLine(RAIL.body, "borderAccent", railLeaders(left, theme.fg("dim", meta.join(" · ")), budget, theme), theme, budget);
	}

	// ── Brief / nameless results ──
	if (!results?.length && !d.agentId) {
		const briefText = briefToolResult("agent", result as { content?: unknown[] }, theme);
		return railLine(RAIL.close, closeSlot, `${briefText}`, theme, budget);
	}

	const label =
		(d.agentName as string) ?? (d.agentId as string) ?? ((results?.[0] as Record<string, unknown>)?.agentId as string) ?? "agent";

	// ── Closed card ──
	if (!ctx.expanded) {
		const badge = statusBadge(status, theme);
		const head = `${badge} ${theme.fg("toolTitle", theme.bold(label))}`;
		if (d.error) {
			return railLine(RAIL.close, "error", `${head} ${theme.fg("error", truncLine(String(d.error), budget - 24))}`, theme, budget);
		}
		const output = results?.length ? ((results[0] as Record<string, unknown>).output as string | undefined) : undefined;
		const preview = output ? output.split("\n").find((l) => l.trim()) : undefined;
		const right = theme.fg("dim", PI_EXPAND_CHORD);
		if (preview) {
			const left = `${head} ${theme.fg("muted", truncLine(preview, Math.max(8, budget - visibleWidth(head) - 8)))}`;
			return railLine(RAIL.close, closeSlot, railLeaders(left, right, budget, theme), theme, budget);
		}
		// Live 2026-09-16: with no output preview the cap printed a bare
		// `┗ ● explorer`, so the expand affordance vanished exactly when the card
		// is hardest to read (an agent run whose result carries no output line).
		// The team card always shows the chord; this one now does too.
		return railLine(RAIL.close, closeSlot, railLeaders(head, right, budget, theme), theme, budget);
	}

	// ── Expanded card ──
	const lines: string[] = [];
	if (results?.length) {
		for (const item of results) {
			const icon = statusIcon((item.status as string) ?? "", theme);
			lines.push(
				railLine(
					RAIL.body,
					"border",
					`${icon} ${theme.fg("toolTitle", theme.bold((item.agentId as string) ?? "agent"))}`,
					theme,
					budget,
				),
			);
			if (item.error) {
				lines.push(previewLine(RAIL.body, "error", String(item.error), theme, budget));
			} else if (item.output) {
				for (const line of String(item.output).split("\n").slice(0, 5)) {
					lines.push(previewLine(RAIL.body, "border", line, theme, budget));
				}
			}
		}
	} else if (d.agentId) {
		lines.push(
			railLine(RAIL.body, "border", `${statusIcon(status, theme)} ${theme.fg("toolTitle", theme.bold(label))}`, theme, budget),
		);
		if (d.error) lines.push(previewLine(RAIL.body, "error", String(d.error), theme, budget));
	} else {
		lines.push(previewLine(RAIL.body, "border", extractContentText(result?.content), theme, budget));
	}
	lines.push(railLine(RAIL.close, closeSlot, `${theme.fg("muted", label)} ${theme.fg("dim", PI_EXPAND_CHORD)}`, theme, budget));
	return lines.join("\n");
}

// ── Metrics ────────────────────────────────────────────────────────────

interface Metrics {
	taskCount?: number;
	completedCount?: number;
	totalTokens?: number;
	totalCost?: number;
	durationMs?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractContentText(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	// onUpdate appends text blocks — only use the LAST one to avoid stacking
	const texts = content.filter(
		(c): c is Record<string, unknown> => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
	);
	if (texts.length === 0) return "";
	return String((texts[texts.length - 1]! as Record<string, unknown>).text ?? "");
}

/** Parse streaming progress text from the team-tool progress binder.
 * The format is a shared contract — `parseCompactToolProgress`
 * (../tool-progress-formatter.ts) owns the tokens; this adapter only maps them
 * onto the card's display model (task counts win over the bare status row).
 */
interface StreamingProgress {
	elapsedMs: number;
	completed: number | null;
	total: number | null;
	status: string | null;
	activeAgent: string | null;
}

function parseStreamingProgress(text: string): StreamingProgress | null {
	const parsed = parseCompactToolProgress(text);
	if (!parsed) return null;

	const toolInfo = parsed.currentTool ? ` · ${parsed.currentTool}` : "";
	if (parsed.completed != null && parsed.total != null) {
		return {
			elapsedMs: parsed.elapsedMs,
			completed: parsed.completed,
			total: parsed.total,
			status: null,
			activeAgent: (parsed.activeAgent ?? "") + toolInfo,
		};
	}
	if (parsed.elapsedMs > 0) {
		return {
			elapsedMs: parsed.elapsedMs,
			completed: null,
			total: null,
			status: parsed.status,
			activeAgent: parsed.activeAgent,
		};
	}
	return null;
}

function computeTotalDuration(records: CrewAgentRecord[]): number {
	let total = 0;
	for (const r of records) total += computeRecordDuration(r);
	return total;
}

function computeRecordDuration(r: CrewAgentRecord): number {
	if (!r.startedAt) return 0;
	const start = new Date(r.startedAt).getTime();
	const end = r.completedAt ? new Date(r.completedAt).getTime() : spinnerClockNow();
	if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
	return Math.max(0, end - start);
}

function computeTotalCost(records: CrewAgentRecord[]): number {
	let total = 0;
	for (const r of records) {
		if (r.usage?.cost) total += r.usage.cost;
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

/** Shorten file path by replacing $HOME with ~ */
function shortenPath(p: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (home && p.startsWith(home)) return "~" + p.slice(home.length);
	return p;
}

/** Create clickable file hyperlink via OSC 8.
 * Removed (M-13 fix, code-review 2026-06-23): this function was dead code (no
 * callers) and interpolated a path into an OSC-8 escape without sanitizing
 * control chars (\x07 BEL / \x1b\\ ST), a potential terminal-injection sink.
 * Re-add with sanitized input if a caller is introduced. */
