import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewTheme } from "../../ui/theme-adapter.ts";
import {
	CAPACITY_STATUS_ID,
	type CapacityConfig,
	CREW_VIBES_WIDGET_KEY,
	type CrewVibesConfig,
	capacityIcons,
	PROVIDER_STATUS_ID,
	SPEED_STATUS_ID,
	type SpeedConfig,
	type TokenDisplay,
} from "./config.ts";
import { capacityIndex, crewFrames, isDangerStage } from "./figures.ts";

export type CapacityUsage = {
	tokens: number | null;
	percent: number | null;
};

export function formatCount(value: number): string {
	if (value < 1000) return value.toString();
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

function asCrewTheme(theme: unknown): CrewTheme | undefined {
	if (theme && typeof theme === "object" && typeof (theme as CrewTheme).fg === "function") {
		return theme as CrewTheme;
	}
	return undefined;
}

export function getCapacityUsage(ctx: ExtensionContext): CapacityUsage {
	const fn = (ctx as { getContextUsage?: () => { tokens?: number; percent?: number } | null }).getContextUsage;
	const usage = typeof fn === "function" ? fn.call(ctx) : null;
	return {
		tokens: typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null,
		percent: typeof usage?.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null,
	};
}

export function formatSpeed(config: SpeedConfig, speed: number | null): string {
	return speed === null ? `-- ${config.label}` : `${speed.toFixed(1)} ${config.label}`;
}

export function renderSpeedFooter(theme: CrewTheme | undefined, config: SpeedConfig, speed: number | null): string {
	const value = speed === null ? "--" : speed.toFixed(1);
	const valueTone = speed === null ? "dim" : "accent";
	const styled = theme ? `${theme.fg(valueTone, value)} ${theme.fg("dim", config.label)}` : `${value} ${config.label}`;
	return styled;
}

export function renderWorkingMessage(theme: CrewTheme | undefined, config: SpeedConfig, speed: number | null): string {
	const left = "Working";
	const speedText = theme
		? `${theme.fg(speed === null ? "dim" : "accent", speed === null ? "--" : speed.toFixed(1))} ${theme.fg("dim", config.label)}`
		: `${speed === null ? "--" : speed.toFixed(1)} ${config.label}`;
	return theme ? `${theme.fg("muted", left)}  ${speedText}` : `${left}  ${speedText}`;
}

export function crewIndicatorFrames(theme: CrewTheme | undefined): string[] {
	const frames = crewFrames();
	if (!theme) return [...frames];
	return frames.map((frame) => theme.fg("accent", frame));
}

function formatCapacityPrefix(config: CapacityConfig, usage: CapacityUsage): string {
	const display: TokenDisplay = config.tokenDisplay;
	if (display === "off") return "";
	if (display === "percentage") {
		return `${usage.percent === null ? "?" : Math.round(Math.max(0, Math.min(999, usage.percent)))}% `;
	}
	return `${usage.tokens === null ? "?" : formatCount(usage.tokens)} `;
}

function colorStage(theme: CrewTheme | undefined, index: number, levels: number, text: string): string {
	if (!theme || text.length === 0) return text;
	return theme.fg(isDangerStage(index, levels) ? "error" : "success", text);
}

export function renderCapacity(theme: CrewTheme | undefined, config: CapacityConfig, usage: CapacityUsage): string {
	const icons = capacityIcons();
	const levels = icons.length;
	const index = capacityIndex(usage.percent, levels);
	const icon = icons[index] ?? icons[0];
	const label = config.labels[index] ?? config.labels[0];
	const prefix = theme ? theme.fg("muted", formatCapacityPrefix(config, usage)) : formatCapacityPrefix(config, usage);
	const coloredIcon = colorStage(theme, index, levels, icon);
	const afterIcon = config.showLabel ? `  ${colorStage(theme, index, levels, label)}` : " ";
	return `${prefix}${coloredIcon}${afterIcon}`;
}

export function setSpeedStatus(ctx: ExtensionContext, config: CrewVibesConfig, text: string | undefined): void {
	if (!ctx?.hasUI) return;
	if (!config.enabled || !config.speed.enabled || !config.speed.footer) {
		ctx.ui.setStatus(SPEED_STATUS_ID, undefined);
		return;
	}
	ctx.ui.setStatus(SPEED_STATUS_ID, text);
}

export function setCapacityStatus(ctx: ExtensionContext, config: CrewVibesConfig, text: string | undefined): void {
	if (!ctx?.hasUI) return;
	if (!config.enabled || !config.capacity.enabled) {
		ctx.ui.setStatus(CAPACITY_STATUS_ID, undefined);
		return;
	}
	ctx.ui.setStatus(CAPACITY_STATUS_ID, text);
}

export function clearVibesStatus(ctx: ExtensionContext): void {
	if (!ctx?.hasUI) return;
	ctx.ui.setStatus(SPEED_STATUS_ID, undefined);
	ctx.ui.setWidget(CREW_VIBES_WIDGET_KEY, undefined);
	if (ctx.ui.setWorkingIndicator) ctx.ui.setWorkingIndicator();
	if (ctx.ui.setWorkingMessage) ctx.ui.setWorkingMessage();
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

/** Render capacity + provider quota as a 2-line widget below the editor.
 * setWidget uses `wrapTextWithAnsi` per line (no truncation, no "..."),
 * so each line keeps its full content even when narrow. */
export function setCrewVibesWidget(
	ctx: ExtensionContext,
	config: CrewVibesConfig,
	capText: string | undefined,
	quotaText: string | undefined,
): void {
	if (!ctx?.hasUI) return;
	if (!config.enabled) {
		ctx.ui.setWidget(CREW_VIBES_WIDGET_KEY, undefined);
		return;
	}
	const lines: string[] = [];
	if (capText) lines.push(capText);
	if (quotaText) lines.push(quotaText);
	ctx.ui.setWidget(CREW_VIBES_WIDGET_KEY, lines.length ? lines : undefined, { placement: "belowEditor" });
}

export { asCrewTheme };
