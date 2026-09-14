import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCrewEnv } from "../../config/env-vars.ts";
import { hasCrewFontFile, isWebTerminal } from "./font-detect.ts";

/**
 * Self-contained config for the crew-vibes module (provider quota).
 * Stored in its own JSON file so it never touches the strict typebox schema
 * used by the rest of pi-crew.
 */

export const CAPACITY_STATUS_ID = "pi-crew-bar";
export const PROVIDER_STATUS_ID = "pi-crew-bar";

function resolveHome(): string {
	return getCrewEnv("PI_CREW_HOME")?.trim() || process.env.HOME || process.env.USERPROFILE || "";
}

export function configPath(): string {
	return join(resolveHome(), ".pi", "agent", "pi-crew-vibes.json");
}

export type TokenDisplay = "off" | "tokens" | "percentage";

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
	capacity: CapacityConfig;
}

export const DEFAULT_CONFIG: CrewVibesConfig = {
	enabled: true,
	capacity: {
		enabled: true,
		tokenDisplay: "tokens",
		showLabel: true,
		refreshIntervalMs: 2000,
		labels: ["Orbit", "Cruise", "Warp", "Black Hole", "Supernova", "Big Bang"],
		icons: ["", "", "", "", "", ""],
		providerUsage: true,
		providerRefreshMs: 120000,
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
