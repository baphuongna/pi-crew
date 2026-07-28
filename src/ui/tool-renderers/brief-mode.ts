/**
 * Brief mode for tool result display.
 *
 * Inspired by @ayulab/pi-brief — shows one-line summaries instead of
 * full output. Toggled via /crew-brief on|off, state persists across
 * session reloads via pi.appendEntry().
 */

import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { formatDuration, formatTokens, truncLine } from "../format-helpers.ts";
import type { CrewTheme } from "../theme-adapter.ts";

// ── State ──────────────────────────────────────────────────────────────

const BRIEF_ENTRY_TYPE = "pi-crew.brief-state";
let briefEnabled = false;

export function isBrief(): boolean {
	return briefEnabled;
}

export function setBrief(on: boolean): void {
	briefEnabled = on;
}

/** Entry type for persisting brief state across session reloads. */
export interface BriefStateEntry {
	readonly type: "custom";
	readonly customType: typeof BRIEF_ENTRY_TYPE;
	readonly data: { enabled: boolean };
}

export function makeBriefEntry(enabled: boolean): BriefStateEntry {
	return { type: "custom", customType: BRIEF_ENTRY_TYPE, data: { enabled } };
}

export function restoreBriefState(entries: Iterable<unknown>): void {
	for (const entry of entries) {
		if (
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			(entry as Record<string, unknown>).type === "custom" &&
			"customType" in entry &&
			(entry as Record<string, unknown>).customType === BRIEF_ENTRY_TYPE &&
			"data" in entry
		) {
			const data = (entry as Record<string, unknown>).data;
			if (typeof data === "object" && data !== null && "enabled" in data) {
				briefEnabled = !!(data as Record<string, unknown>).enabled;
			}
		}
	}
}

export { BRIEF_ENTRY_TYPE };

// ── Brief renderers ────────────────────────────────────────────────────

/** Brief summary for a single tool result. */
export function briefToolResult(toolName: string, result: { content?: unknown[] }, theme: CrewTheme): string {
	const text = extractText(result?.content);
	switch (toolName) {
		case "read":
			return briefRead(text, theme);
		case "bash":
			return briefBash(text, theme);
		case "edit":
			return briefEdit(text, theme);
		case "write":
			return briefWrite(text, theme);
		case "find":
			return briefFind(text, theme);
		case "grep":
			return briefGrep(text, theme);
		case "ls":
			return briefLs(text, theme);
		case "team":
			return briefTeam(result, theme);
		case "agent":
			return briefAgent(result, theme);
		default:
			return briefDefault(text, theme);
	}
}

function briefRead(text: string, theme: CrewTheme): string {
	if (!text) return theme.fg("dim", "→ empty");
	const count = text.trim().split("\n").filter(Boolean).length;
	return theme.fg("muted", `→ ${count} lines`);
}

function briefBash(text: string, theme: CrewTheme): string {
	if (!text?.trim()) return theme.fg("dim", "→ done");
	const lines = text.trim().split("\n");
	if (lines.length === 1 && lines[0]!.length < 40) {
		return theme.fg("muted", `→ ${lines[0]}`);
	}
	return theme.fg("muted", `→ ${lines.length} lines`);
}

function briefEdit(text: string, theme: CrewTheme): string {
	if (!text) return theme.fg("dim", "→ edited");
	if (text.includes("Error") || text.includes("error")) {
		return theme.fg("error", "→ failed");
	}
	const added = (text.match(/^\+ /gm) ?? []).length;
	const removed = (text.match(/^- /gm) ?? []).length;
	if (added === 0 && removed === 0) {
		return theme.fg("success", "→ edited");
	}
	return theme.fg("success", "→ edited ") + theme.fg("toolDiffAdded", `+${added} `) + theme.fg("toolDiffRemoved", `-${removed}`);
}

function briefWrite(text: string, theme: CrewTheme): string {
	if (text) return theme.fg("error", `→ ${text}`);
	return theme.fg("success", "→ written");
}

function briefFind(text: string, theme: CrewTheme): string {
	if (!text) return theme.fg("dim", "→ none");
	const count = text.trim().split("\n").filter(Boolean).length;
	return theme.fg("muted", `→ ${count} files`);
}

function briefGrep(text: string, theme: CrewTheme): string {
	if (!text) return theme.fg("dim", "→ none");
	const count = text.trim().split("\n").filter(Boolean).length;
	return theme.fg("muted", `→ ${count} matches`);
}

function briefLs(text: string, theme: CrewTheme): string {
	if (!text) return theme.fg("dim", "→ empty");
	const count = text.trim().split("\n").filter(Boolean).length;
	return theme.fg("muted", `→ ${count} entries`);
}

function briefTeam(result: { content?: unknown[] }, theme: CrewTheme): string {
	// Try to extract structured details
	const details = (result as Record<string, unknown>).details ?? result;
	const d = typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
	const status = typeof d.status === "string" ? d.status : "";
	const runId = typeof d.runId === "string" ? d.runId : "";
	const icon =
		status === "completed"
			? theme.fg("success", "✓")
			: status === "failed"
				? theme.fg("error", "✗")
				: status === "running"
					? theme.fg("warning", "⟳")
					: theme.fg("dim", "○");

	// Agent records summary
	const records = (d.agentRecords ?? d.results) as CrewAgentRecord[] | undefined;
	if (records?.length) {
		const completed = records.filter((r) => r.status === "completed").length;
		const total = records.length;
		const duration = computeTotalDuration(records);
		const tokens = computeTotalTokens(records);
		return `${icon} ${completed}/${total} tasks · ${formatDuration(duration)} · ${formatTokens(tokens)} tok`;
	}

	// Fallback: compact status line
	const parts: string[] = [];
	if (status) parts.push(status);
	if (runId) parts.push(runId.slice(-8));
	return `${icon} ${parts.join(" · ") || "done"}`;
}

function briefAgent(result: { content?: unknown[] }, theme: CrewTheme): string {
	const d = (result as Record<string, unknown>).details ?? result;
	const data = typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
	const status = typeof data.status === "string" ? data.status : "";
	const agentId = typeof data.agentId === "string" ? data.agentId : "agent";
	const icon =
		status === "completed"
			? theme.fg("success", "\u2713")
			: status === "failed"
				? theme.fg("error", "\u2717")
				: theme.fg("dim", "\u25CB");
	// P3: Show duration and tokens when available
	const parts: string[] = [agentId];
	if (data.durationMs) parts.push(formatDuration(data.durationMs as number));
	if (data.totalTokens) parts.push(`${formatTokens(data.totalTokens as number)} tok`);
	return `${icon} ${parts.join(" \u00B7 ")}`;
}

function briefDefault(text: string, theme: CrewTheme): string {
	if (!text) return theme.fg("dim", "→ done");
	const first = text.split("\n")[0] ?? "";
	return theme.fg("muted", `→ ${truncLine(first, 60)}`);
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractText(content: unknown[] | undefined): string {
	if (!content) return "";
	if (!Array.isArray(content)) return String(content);
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
		if (r.usage) {
			total += (r.usage.input ?? 0) + (r.usage.output ?? 0) + (r.usage.cacheWrite ?? 0);
		}
	}
	return total;
}
