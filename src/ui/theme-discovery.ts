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
}

/** Builtin Pi themes shipped with the pi-coding-agent package. */
const BUILTIN_PI_THEMES = ["dark", "light"];

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
		out.push({ name, source: "builtin", displayName: name });
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
				try {
					const json = JSON.parse(fs.readFileSync(fullPath, "utf8"));
					displayName = typeof json.name === "string" ? json.name : undefined;
				} catch {
					// keep undefined
				}
				seen.add(name);
				out.push({ name, source: "custom", path: fullPath, displayName });
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

	lines.push("═══ Theme Gallery ═══");
	lines.push("");

	// ── Pi UI themes ──
	lines.push("Pi UI themes (overall terminal colors):");
	lines.push("");
	for (const t of piThemes) {
		const isActive = t.name === activePi;
		const tag = isActive ? " ← active" : "";
		const src = t.source === "custom" ? " (custom)" : " (builtin)";
		const disp = t.displayName && t.displayName !== t.name ? ` — ${t.displayName}` : "";
		lines.push(`  ${isActive ? "●" : "○"} ${t.name}${src}${disp}${tag}`);
	}
	lines.push("");
	lines.push("  Switch (live, no restart): team-settings theme <name>");
	lines.push("  Browse interactively:      /team-settings → Themes tab");
	lines.push("");

	lines.push("Notes:");
	lines.push("  • Switching applies live via ctx.ui.setTheme() (Pi redraws immediately).");
	lines.push("  • Custom themes live in ~/.pi/agent/themes/<name>.json.");
	lines.push(`  • ${piThemes.length} themes available.`);

	return lines.join("\n");
}
