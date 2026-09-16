import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewTheme } from "../../ui/theme-adapter.ts";
import { type CrewVibesConfig, PROVIDER_STATUS_ID } from "./config.ts";

function asCrewTheme(theme: unknown): CrewTheme | undefined {
	if (theme && typeof theme === "object" && typeof (theme as CrewTheme).fg === "function") {
		return theme as CrewTheme;
	}
	return undefined;
}

export function clearVibesStatus(ctx: ExtensionContext): void {
	if (!ctx?.hasUI) return;
	ctx.ui.setStatus(PROVIDER_STATUS_ID, undefined);
}

// Provider rate-limit usage snapshot (mirrors provider-usage.ts interface).
// Defined locally to avoid a phase dependency on provider-usage.ts.
export type ProviderUsage = {
	providerName: string;
	fiveHourPercent: number;
	fiveHourResetAt: string | null;
	weeklyPercent: number;
	weeklyResetAt: string | null;
	copilotMonthlyPercent?: number;
};

/** Format a time-until-reset duration as a compact `2h30m` / `45m` / `3h` string. */
function formatResetTimer(resetAt: string | null): string | null {
	if (!resetAt) return null;
	const diffMs = new Date(resetAt).getTime() - Date.now();
	if (diffMs < 0) return null;
	const mins = Math.floor(diffMs / 60000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) {
		const remMins = mins % 60;
		return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

// Render provider rate-limit usage as a compact status string with bars.
// Returns `undefined` when there is nothing to show (null usage).

/** Render a progress bar using heavy line characters (matches pi-sub-bar style).
 * `━━━━━━┄┄┄┄` for 60% — filled uses ━ (U+2501), empty uses ┄ (U+2504). */
function renderBar(percent: number, width = 8): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	return `${"\u2501".repeat(filled)}${"\u2504".repeat(width - filled)}`;
}

export function renderProviderUsage(theme: CrewTheme | undefined, usage: ProviderUsage | null): string | undefined {
	if (!usage) return undefined;

	const parts: string[] = [];

	// Provider name — muted/bold
	if (usage.providerName) {
		const nameText = usage.providerName;
		parts.push(theme ? theme.fg("muted", nameText) : nameText);
	}

	// 5h window — error color at 80%+, accent otherwise
	const fiveHourBar = renderBar(usage.fiveHourPercent);
	const fiveHourRounded = Math.round(usage.fiveHourPercent);
	const fiveHourReset = formatResetTimer(usage.fiveHourResetAt);
	const fiveHourText = `5h ${fiveHourBar} ${fiveHourRounded}%${fiveHourReset ? " " + fiveHourReset : ""}`;
	const fiveHourColor = usage.fiveHourPercent >= 80 ? "error" : "accent";
	parts.push(theme ? theme.fg(fiveHourColor, fiveHourText) : fiveHourText);

	// Weekly window — dim
	const weeklyBar = renderBar(usage.weeklyPercent);
	const weeklyRounded = Math.round(usage.weeklyPercent);
	const weeklyReset = formatResetTimer(usage.weeklyResetAt);
	const weeklyText = `Wk ${weeklyBar} ${weeklyRounded}%${weeklyReset ? " " + weeklyReset : ""}`;
	parts.push(theme ? theme.fg("dim", weeklyText) : weeklyText);

	// Copilot monthly — dim (optional)
	if (typeof usage.copilotMonthlyPercent === "number" && Number.isFinite(usage.copilotMonthlyPercent)) {
		const monthlyRounded = Math.round(usage.copilotMonthlyPercent);
		const monthlyText = `Mo: ${monthlyRounded}%`;
		parts.push(theme ? theme.fg("dim", monthlyText) : monthlyText);
	}

	return parts.join(" ");
}

export function setProviderStatus(ctx: ExtensionContext, config: CrewVibesConfig, text: string | undefined): void {
	if (!ctx?.hasUI) return;
	if (!config.enabled || !config.capacity.providerUsage) {
		ctx.ui.setStatus(PROVIDER_STATUS_ID, undefined);
		return;
	}
	ctx.ui.setStatus(PROVIDER_STATUS_ID, text);
}

export { asCrewTheme };
