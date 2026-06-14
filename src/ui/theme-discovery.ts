/**
 * Pi UI theme discovery and selection.
 *
 * Exposes:
 *  - Pi UI theme discovery (builtins + custom ~/.pi/agent/themes/*.json)
 *  - The active Pi theme
 *  - setPiTheme() to persist a choice in ~/.pi/agent/settings.json
 *
 * Wired into the `team-settings themes` / `theme` subcommands.
 */

export interface PiThemeInfo {
	/** Theme name (filename stem or builtin id). */
	name: string;
	/** Where it comes from. */
	source: "builtin" | "custom";
	/** Absolute path to the .json file, if applicable. */
	path?: string;
	/** Human-friendly display name from the JSON `name` field, if present. */
	displayName?: string;
	/** "dark" or "light" — derived from background luminance. */
	mode?: "dark" | "light";
}

/** Builtin Pi themes shipped with the pi-coding-agent package. */
const BUILTIN_PI_THEMES = ["dark", "light"];

/**
 * Detect whether a theme is dark or light based on its background luminance.
 * Reads vars.bg or export.pageBg or a resolved colors ref. Returns undefined
 * if it can't be determined.
 */
function detectThemeMode(json: Record<string, unknown>): "dark" | "light" | undefined {
	const vars = json.vars as Record<string, string> | undefined;
	const bgRaw = vars?.bg;
	if (!bgRaw || !/^#[0-9a-fA-F]{6}$/.test(bgRaw)) return undefined;
	const r = parseInt(bgRaw.slice(1, 3), 16);
	const g = parseInt(bgRaw.slice(3, 5), 16);
	const b = parseInt(bgRaw.slice(5, 7), 16);
	// Relative luminance (ITU-R BT.709)
	const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	return lum < 0.5 ? "dark" : "light";
}

function customThemesDir(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	return home ? `${home}/.pi/agent/themes` : "";
}

function settingsPath(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	return home ? `${home}/.pi/agent/settings.json` : "";
}

/** Discover all available Pi UI themes (builtins + custom). */
export function discoverPiThemes(): PiThemeInfo[] {
	const out: PiThemeInfo[] = [];
	const seen = new Set<string>();

	// Builtins
	for (const name of BUILTIN_PI_THEMES) {
		if (seen.has(name)) continue;
		seen.add(name);
		out.push({ name, source: "builtin", displayName: name, mode: name === "light" ? "light" : "dark" });
	}

	// Custom themes from ~/.pi/agent/themes/
	const dir = customThemesDir();
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs");
		if (dir && fs.existsSync(dir)) {
			for (const file of fs.readdirSync(dir) as string[]) {
				if (!file.endsWith(".json")) continue;
				const name = file.slice(0, -5);
				if (seen.has(name)) continue;
				const fullPath = `${dir}/${file}`;
				let displayName: string | undefined;
				let mode: "dark" | "light" | undefined;
				try {
					const json = JSON.parse(fs.readFileSync(fullPath, "utf8"));
					displayName = typeof json.name === "string" ? json.name : undefined;
					mode = detectThemeMode(json);
				} catch {
					// keep undefined
				}
				seen.add(name);
				out.push({ name, source: "custom", path: fullPath, displayName, mode });
			}
		}
	} catch {
		// directory unreadable — skip
	}

	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read the currently active Pi theme from ~/.pi/agent/settings.json. */
export function getActivePiTheme(): string | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs");
		const p = settingsPath();
		if (!p || !fs.existsSync(p)) return undefined;
		const json = JSON.parse(fs.readFileSync(p, "utf8"));
		return typeof json.theme === "string" ? json.theme : undefined;
	} catch {
		return undefined;
	}
}

/** Persist a Pi theme choice in ~/.pi/agent/settings.json. Returns the path or throws. */
export function setPiTheme(name: string): string {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("node:fs");
	const p = settingsPath();
	if (!p) throw new Error("Could not determine settings path (no HOME).");
	let settings: Record<string, unknown> = {};
	try {
		if (fs.existsSync(p)) {
			settings = JSON.parse(fs.readFileSync(p, "utf8"));
		}
	} catch {
		// corrupt settings — start fresh
		settings = {};
	}
	settings.theme = name;
	fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
	return p;
}

// ---------------------------------------------------------------------------
// Formatted listing for `team-settings themes`
// ---------------------------------------------------------------------------

/**
 * Build the full formatted listing of Pi UI themes for display.
 * Shows available themes, the active selection, and switching instructions.
 */
export function formatThemesListing(): string {
	const piThemes = discoverPiThemes();
	const activePi = getActivePiTheme();
	const lines: string[] = [];

	const darkThemes = piThemes.filter((t) => t.mode !== "light");
	const lightThemes = piThemes.filter((t) => t.mode === "light");

	lines.push("═══ Theme Gallery ═══");
	lines.push("");

	// ── Dark themes ──
	if (darkThemes.length) {
		lines.push("Dark themes:");
		lines.push("");
		for (const t of darkThemes) {
			lines.push(themeLine(t, activePi));
		}
		lines.push("");
	}

	// ── Light themes ──
	if (lightThemes.length) {
		lines.push("Light themes:");
		lines.push("");
		for (const t of lightThemes) {
			lines.push(themeLine(t, activePi));
		}
		lines.push("");
	}

	lines.push("  Switch (live, no restart): team-settings theme <name>");
	lines.push("  Browse interactively:      /team-settings → Themes tab");
	lines.push("");

	lines.push("Notes:");
	lines.push("  • Switching applies live via ctx.ui.setTheme() (Pi redraws immediately).");
	lines.push("  • Bundled crew-* themes deploy to ~/.pi/agent/themes/ on startup.");
	lines.push(`  • ${piThemes.length} themes available (${darkThemes.length} dark, ${lightThemes.length} light).`);

	return lines.join("\n");
}

function themeLine(t: PiThemeInfo, active: string | undefined): string {
	const isActive = t.name === active;
	const tag = isActive ? " ← active" : "";
	const src = t.source === "builtin" ? " (builtin)" : "";
	return `  ${isActive ? "●" : "○"} ${t.name}${src}${tag}`;
}
