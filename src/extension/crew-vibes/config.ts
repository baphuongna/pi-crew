import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasCrewFontFile, isWebTerminal } from "./font-detect.ts";

/**
 * Self-contained config for the crew-vibes module (speed + capacity meters).
 * Stored in its own JSON file so it never touches the strict typebox schema
 * used by the rest of pi-crew.
 */

export const SPEED_STATUS_ID = "pi-crew-speed";
export const CAPACITY_STATUS_ID = "pi-crew-bar";
export const PROVIDER_STATUS_ID = "pi-crew-quota";
export const CREW_VIBES_WIDGET_KEY = "pi-crew-status";

function resolveHome(): string {
	return process.env.PI_TEAMS_HOME?.trim() || process.env.HOME || process.env.USERPROFILE || "";
}

export function configPath(): string {
	return join(resolveHome(), ".pi", "agent", "pi-crew-vibes.json");
}

export type TokenDisplay = "off" | "tokens" | "percentage";

export interface SpeedConfig {
	enabled: boolean;
	footer: boolean;
	indicator: boolean;
	label: string;
	renderIntervalMs: number;
	slidingWindowMs: number;
	minReliableDurationMs: number;
	maxDisplayTokS: number;
	defaultIntervalMs: number;
	minIntervalMs: number;
	maxIntervalMs: number;
	scale: number;
}

export interface CapacityConfig {
	enabled: boolean;
	tokenDisplay: TokenDisplay;
	showLabel: boolean;
	refreshIntervalMs: number;
	labels: [string, string, string, string, string, string];
	icons: [string, string, string, string, string, string];
	providerUsage: boolean;
	providerRefreshMs: number;
}

export interface CrewVibesConfig {
	enabled: boolean;
	speed: SpeedConfig;
	capacity: CapacityConfig;
}

export const DEFAULT_CONFIG: CrewVibesConfig = {
	enabled: true,
	speed: {
		enabled: true,
		footer: false,
		indicator: true,
		label: "tok/s",
		renderIntervalMs: 250,
		slidingWindowMs: 1000,
		minReliableDurationMs: 1000,
		maxDisplayTokS: 500,
		defaultIntervalMs: 167,
		minIntervalMs: 50,
		maxIntervalMs: 250,
		scale: 6000,
	},
	capacity: {
		enabled: true,
		tokenDisplay: "tokens",
		showLabel: true,
		refreshIntervalMs: 2000,
		labels: ["Orbit", "Cruise", "Warp", "Black Hole", "Supernova", "Big Bang"],
		icons: ["", "", "", "", "", ""],
		providerUsage: true,
		providerRefreshMs: 300000,
	},
};

// Fallback capacity icons using standard Unicode characters that render
// on any terminal without the crew-vibes PUA font.
const FALLBACK_CAPACITY_ICONS: [string, string, string, string, string, string] = [
	"\u25CB ", // ○ empty circle (lean)
	"\u25D4 ", // ◔ circle with dot (chonking)
	"\u25D1 ", // ◑ circle half filled (chonky)
	"\u25CF ", // ● filled circle (big chonk)
	"\u2B24 ", // ⬤ large filled circle (mega chonk)
	"\u2B22 ", // ⬢ filled hexagon (oh lawd)
];

/** Return capacity icons: standard Unicode glyphs that render on any terminal.
 * PUA glyphs (U+E710..U+E715) require crew-vibes.ttf AND terminal PUA
 * support — many terminals cannot render them even with the font installed. */
export function capacityIcons(): [string, string, string, string, string, string] {
	// Web terminals cannot render PUA glyphs — use fallback.
	if (isWebTerminal()) return FALLBACK_CAPACITY_ICONS;
	return hasCrewFontFile() ? DEFAULT_CONFIG.capacity.icons : FALLBACK_CAPACITY_ICONS;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boolFrom(raw: unknown, fallback: boolean): boolean {
	return typeof raw === "boolean" ? raw : fallback;
}

function stringFrom(raw: unknown, fallback: string): string {
	return typeof raw === "string" ? raw : fallback;
}

function positiveFrom(raw: unknown, fallback: number): number {
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function sextet(
	raw: unknown,
	fallback: [string, string, string, string, string, string],
): [string, string, string, string, string, string] {
	if (Array.isArray(raw) && raw.length === 6 && raw.every((entry) => typeof entry === "string")) {
		return raw as [string, string, string, string, string, string];
	}
	return fallback;
}

function tokenDisplayFrom(raw: unknown, fallback: TokenDisplay): TokenDisplay {
	return raw === "off" || raw === "tokens" || raw === "percentage" ? raw : fallback;
}

function normalizeSpeed(raw: unknown): SpeedConfig {
	const input = asRecord(raw);
	const speed: SpeedConfig = {
		enabled: boolFrom(input.enabled, DEFAULT_CONFIG.speed.enabled),
		footer: boolFrom(input.footer, DEFAULT_CONFIG.speed.footer),
		indicator: boolFrom(input.indicator, DEFAULT_CONFIG.speed.indicator),
		label: stringFrom(input.label, DEFAULT_CONFIG.speed.label),
		renderIntervalMs: positiveFrom(input.renderIntervalMs, DEFAULT_CONFIG.speed.renderIntervalMs),
		slidingWindowMs: positiveFrom(input.slidingWindowMs, DEFAULT_CONFIG.speed.slidingWindowMs),
		minReliableDurationMs: positiveFrom(input.minReliableDurationMs, DEFAULT_CONFIG.speed.minReliableDurationMs),
		maxDisplayTokS: positiveFrom(input.maxDisplayTokS, DEFAULT_CONFIG.speed.maxDisplayTokS),
		defaultIntervalMs: positiveFrom(input.defaultIntervalMs, DEFAULT_CONFIG.speed.defaultIntervalMs),
		minIntervalMs: positiveFrom(input.minIntervalMs, DEFAULT_CONFIG.speed.minIntervalMs),
		maxIntervalMs: positiveFrom(input.maxIntervalMs, DEFAULT_CONFIG.speed.maxIntervalMs),
		scale: positiveFrom(input.scale, DEFAULT_CONFIG.speed.scale),
	};
	if (speed.minIntervalMs > speed.maxIntervalMs) {
		speed.minIntervalMs = DEFAULT_CONFIG.speed.minIntervalMs;
		speed.maxIntervalMs = DEFAULT_CONFIG.speed.maxIntervalMs;
	}
	return speed;
}

function normalizeCapacity(raw: unknown): CapacityConfig {
	const input = asRecord(raw);
	return {
		enabled: boolFrom(input.enabled, DEFAULT_CONFIG.capacity.enabled),
		tokenDisplay: tokenDisplayFrom(input.tokenDisplay, DEFAULT_CONFIG.capacity.tokenDisplay),
		showLabel: boolFrom(input.showLabel, DEFAULT_CONFIG.capacity.showLabel),
		refreshIntervalMs: positiveFrom(input.refreshIntervalMs, DEFAULT_CONFIG.capacity.refreshIntervalMs),
		labels: sextet(input.labels, DEFAULT_CONFIG.capacity.labels),
		icons: sextet(input.icons, DEFAULT_CONFIG.capacity.icons),
		providerUsage: boolFrom(input.providerUsage, DEFAULT_CONFIG.capacity.providerUsage),
		providerRefreshMs: positiveFrom(input.providerRefreshMs, DEFAULT_CONFIG.capacity.providerRefreshMs),
	};
}

export function normalizeConfig(raw: unknown): CrewVibesConfig {
	const input = asRecord(raw);
	return {
		enabled: boolFrom(input.enabled, DEFAULT_CONFIG.enabled),
		speed: normalizeSpeed(input.speed),
		capacity: normalizeCapacity(input.capacity),
	};
}

export function loadConfig(): CrewVibesConfig {
	try {
		const path = configPath();
		if (!existsSync(path)) return normalizeConfig(undefined);
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return normalizeConfig(undefined);
	}
}

export function saveConfig(config: CrewVibesConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}
