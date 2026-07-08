import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewTheme } from "../../ui/theme-adapter.ts";
import { CAPACITY_STATUS_ID, type CapacityConfig, type CrewVibesConfig, SPEED_STATUS_ID, type SpeedConfig, type TokenDisplay } from "./config.ts";
import { capacityIndex, isDangerStage, RUN_CREW_FRAMES } from "./figures.ts";

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
	const speedText = theme ? `${theme.fg(speed === null ? "dim" : "accent", speed === null ? "--" : speed.toFixed(1))} ${theme.fg("dim", config.label)}` : `${speed === null ? "--" : speed.toFixed(1)} ${config.label}`;
	return theme ? `${theme.fg("muted", left)}  ${speedText}` : `${left}  ${speedText}`;
}

export function crewIndicatorFrames(theme: CrewTheme | undefined): string[] {
	if (!theme) return [...RUN_CREW_FRAMES];
	return RUN_CREW_FRAMES.map((frame) => theme.fg("accent", frame));
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
	const levels = config.icons.length;
	const index = capacityIndex(usage.percent, levels);
	const icon = config.icons[index] ?? config.icons[0];
	const label = config.labels[index] ?? config.labels[0];
	const prefix = theme ? theme.fg("muted", formatCapacityPrefix(config, usage)) : formatCapacityPrefix(config, usage);
	const coloredIcon = colorStage(theme, index, levels, icon);
	const afterIcon = config.showLabel ? `  ${colorStage(theme, index, levels, label)}` : " ";
	return `${prefix}${coloredIcon}${afterIcon}`;
}

export function setSpeedStatus(ctx: ExtensionContext, config: CrewVibesConfig, text: string | undefined): void {
	if (!ctx || !ctx.hasUI) return;
	if (!config.enabled || !config.speed.enabled || !config.speed.footer) {
		ctx.ui.setStatus(SPEED_STATUS_ID, undefined);
		return;
	}
	ctx.ui.setStatus(SPEED_STATUS_ID, text);
}

export function setCapacityStatus(ctx: ExtensionContext, config: CrewVibesConfig, text: string | undefined): void {
	if (!ctx || !ctx.hasUI) return;
	if (!config.enabled || !config.capacity.enabled) {
		ctx.ui.setStatus(CAPACITY_STATUS_ID, undefined);
		return;
	}
	ctx.ui.setStatus(CAPACITY_STATUS_ID, text);
}

export function clearVibesStatus(ctx: ExtensionContext): void {
	if (!ctx || !ctx.hasUI) return;
	ctx.ui.setStatus(SPEED_STATUS_ID, undefined);
	ctx.ui.setStatus(CAPACITY_STATUS_ID, undefined);
	if (ctx.ui.setWorkingIndicator) ctx.ui.setWorkingIndicator();
	if (ctx.ui.setWorkingMessage) ctx.ui.setWorkingMessage();
}

export { asCrewTheme };
