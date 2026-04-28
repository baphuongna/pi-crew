import type { CrewTheme, CrewThemeColor } from "./theme-adapter.ts";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stopped" | "blocked" | (string & {});

export function colorForStatus(status: RunStatus): CrewThemeColor {
	switch (status) {
		case "running":
			return "accent";
		case "completed":
			return "success";
		case "failed":
		case "stale":
			return "error";
		case "cancelled":
		case "blocked":
		case "stopped":
			return "warning";
		case "queued":
		default:
			return "dim";
	}
}

export function iconForStatus(status: RunStatus, options?: { runningGlyph?: string }): string {
	const glyph = options?.runningGlyph ?? "▶";
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
		case "stale":
			return "✗";
		case "cancelled":
		case "stopped":
			return "■";
		case "running":
			return glyph;
		case "queued":
			return "◦";
		case "blocked":
			return "⏸";
		default:
			return "·";
	}
}

export function colorForActivity(activityState: string | undefined): CrewThemeColor {
	if (activityState === "needs_attention") return "warning";
	if (activityState === "stale") return "error";
	return "dim";
}

export function applyStatusColor(theme: CrewTheme, status: RunStatus, text: string): string {
	return theme.fg(colorForStatus(status), text);
}
