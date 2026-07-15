/**
 * Widget formatting utilities.
 *
 * Extracted from crew-widget.ts for reuse and testability.
 */

import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import type { LiveAgentHandle } from "../../runtime/live-agent-manager.ts";
import { getTaskUsage } from "../../runtime/usage-tracker.ts";
import { visibleWidth } from "../../utils/visual.ts";
import { computeLiveDurationMs } from "../live-duration.ts";

// ── Token formatting ──────────────────────────────────────────────────

// V-1: fixed visible widths for per-agent numeric metrics so columns don't
// jitter every tick as values change width (e.g. 9.9s→10.0s, 950→1.0k).
// alignMetric right-aligns to the width; values wider than the width overflow
// verbatim (no truncation/crash) — these are rare one-off states, not jitter.
const TOOLS_METRIC_WIDTH = 8; // "127 tools"
const TOKENS_METRIC_WIDTH = 10; // "1.2k tok", "12.3M tok"
const TPS_METRIC_WIDTH = 9; // "411 tok/s"
const CTX_METRIC_WIDTH = 7; // "100% ctx"
const DURATION_METRIC_WIDTH = 6; // "120.0s"

function alignMetric(value: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(value));
	return " ".repeat(pad) + value;
}

export function formatTokensCompact(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tok`;
	return `${count} tok`;
}

// ── Elapsed time ──────────────────────────────────────────────────────

export function elapsed(iso: string | undefined, now = Date.now()): string | undefined {
	if (!iso) return undefined;
	const ms = Math.max(0, now - new Date(iso).getTime());
	if (!Number.isFinite(ms)) return undefined;
	if (ms < 1000) return "now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h`;
}

// ── Agent activity description ────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
	read: "reading",
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

export function describeLiveActivity(handle: LiveAgentHandle): string {
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
		const line =
			act.responseText
				.split("\n")
				.find((l) => l.trim())
				?.trim() ?? "";
		return line.length > 60 ? line.slice(0, 60) + "…" : line;
	}
	return "thinking…";
}

export function agentActivity(agent: CrewAgentRecord, liveHandle?: LiveAgentHandle): string {
	if (liveHandle && liveHandle.status === "running") {
		const live = describeLiveActivity(liveHandle);
		if (live === "thinking…" && agent.progress?.currentTool)
			return `${TOOL_LABELS[agent.progress.currentTool] ?? agent.progress.currentTool}…`;
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

// ── Agent stats line ──────────────────────────────────────────────────

export function agentStats(agent: CrewAgentRecord, liveHandle?: LiveAgentHandle): string {
	const parts: string[] = [];
	if (liveHandle) {
		const act = liveHandle.activity;
		if (act.toolUses > 0) parts.push(alignMetric(`${act.toolUses} tools`, TOOLS_METRIC_WIDTH));
		const usage = getTaskUsage(liveHandle.taskId);
		const total = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
		if (total > 0) parts.push(alignMetric(formatTokensCompact(total), TOKENS_METRIC_WIDTH));
		try {
			const stats = liveHandle.session.getSessionStats?.();
			const ctxPct = stats?.contextUsage?.percent;
			if (ctxPct != null) parts.push(alignMetric(`${Math.round(ctxPct)}% ctx`, CTX_METRIC_WIDTH));
		} catch {
			/* ignore */
		}
		const ms = computeLiveDurationMs(act);
		if (total > 0 && ms > 1000) {
			const tps = Math.round(total / (ms / 1000));
			if (tps > 0) parts.push(alignMetric(`${formatTokensCompact(tps)}/s`, TPS_METRIC_WIDTH));
		}
		parts.push(alignMetric(`${(ms / 1000).toFixed(1)}s`, DURATION_METRIC_WIDTH));
	} else {
		if (agent.toolUses) parts.push(alignMetric(`${agent.toolUses} tools`, TOOLS_METRIC_WIDTH));
		if (agent.progress?.tokens) parts.push(alignMetric(formatTokensCompact(agent.progress.tokens), TOKENS_METRIC_WIDTH));
		const ageMs = agent.startedAt ? Math.max(0, Date.now() - new Date(agent.startedAt).getTime()) : 0;
		if (agent.progress?.tokens && ageMs > 1000) {
			const tps = Math.round(agent.progress.tokens / (ageMs / 1000));
			if (tps > 0) parts.push(alignMetric(`${formatTokensCompact(tps)}/s`, TPS_METRIC_WIDTH));
		}
		const age = elapsed(agent.completedAt ?? agent.startedAt);
		if (age) parts.push(alignMetric(age, DURATION_METRIC_WIDTH));
	}
	return parts.join(" · ");
}

// ── Notification badge ────────────────────────────────────────────────

// Bug 021: the bell glyph 🔔 was misread as "queued messages" — users saw
// `🔔227` and concluded there were 227 pending items, when the value is a
// CUMULATIVE warning/error/critical count with zero actual queue behind it.
// Fix: relabel to an explicit "alerts" segment (no bell) and cap the display
// at 99+ (standard badge practice). The cumulative count stays accurate
// internally (widgetState.notificationCount) and remains fully logged in
// .crew/state/notifications/YYYY-MM-DD.jsonl — this bounds presentation only.
// Deeper fixes (decay window, owner-scope, auto-reset on all-runs-terminal,
// full deprecation) are product decisions documented in
// docs/bugs/bug-021-notification-badge-counter-misleading.md.
export const NOTIFICATION_BADGE_CAP = 99;

export function notificationBadge(count: number | undefined, env: NodeJS.ProcessEnv = process.env): string {
	if (!count || count <= 0) return "";
	const term = `${env.TERM ?? ""} ${env.WT_SESSION ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
	const supportsEmoji = !term.includes("dumb") && env.NO_COLOR !== "1";
	const label = count > NOTIFICATION_BADGE_CAP ? `${NOTIFICATION_BADGE_CAP}+ alerts` : `${count} alerts`;
	return supportsEmoji ? ` · ${label}` : ` [${label}]`;
}
