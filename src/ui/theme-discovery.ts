/**
 * Pi UI theme discovery and selection.
 *
 * Exposes:
 *  - Pi UI theme discovery (builtins + custom ~/.pi/agent/themes/*.json)
 *  - The active Pi theme
 *  - setPiTheme() to persist a choice in ~/.pi/agent/settings.json
 *
 * Wired into the `team-settings themes` / `theme` subcommands.
 *
 * P0-1 (2026-09-15): this module used bare `require("node:fs")` in three
 * places. It is an ESM module, so `require` is undefined there and every
 * filesystem probe threw a ReferenceError that the surrounding try/catch
 * swallowed: `discoverPiThemes()` collapsed to the 2 builtins, and
 * `getActivePiTheme()` always returned undefined (so no crew theme was
 * selectable and the active theme was misreported). The fs access is now a
 * static top-level import. `node:fs` is a builtin and this module is already
 * eagerly reachable from handle-settings.ts / settings-overlay.ts, so this
 * does not change lazy-load behaviour (check:lazy-imports only polices
 * `await import(` without a `// LAZY:` marker).
 */
import * as fs from "node:fs";
import { atomicWriteFile } from "../state/atomic-write.ts";
import { sanitizeUntrustedLine } from "../utils/visual.ts";
import { getAllThemes } from "./pi-ui-compat.ts";

/**
 * Minimal structural context for host delegation (B-4): anything with a
 * `ui` object (the real `ExtensionContext` satisfies this). Callers without
 * a live context (subagent/CI) omit it and get the filesystem fallback.
 */
export interface ThemeDiscoveryContext {
	ui: unknown;
}

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

/** Discover all available Pi UI themes.
 *
 * B-4 (host delegation): when a caller supplies an extension context whose
 * `ui.getAllThemes()` exists AND yields a non-empty list, the HOST list wins
 * (it is the authority — sees the same builtins + user themes the running
 * TUI sees, with no fs probing). Any miss (no ctx, missing API, throw, or an
 * EMPTY result — RPC-degraded hosts return `[]`) falls back to the builtin +
 * `~/.pi/agent/themes/*.json` scan below, unchanged.
 */
export function discoverPiThemes(ctx?: ThemeDiscoveryContext): PiThemeInfo[] {
	if (ctx) {
		const host = getAllThemes(ctx);
		if (host && host.length > 0) {
			return host
				.map((theme) => ({
					name: theme.name,
					source: theme.path ? ("custom" as const) : ("builtin" as const),
					...(theme.path ? { path: theme.path } : {}),
					displayName: theme.name,
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
		}
	}
	return discoverPiThemesFromFs();
}

/** Filesystem fallback: builtins + ~/.pi/agent/themes/*.json (pre-B-4 path, unchanged). */
function discoverPiThemesFromFs(): PiThemeInfo[] {
	const out: PiThemeInfo[] = [];
	const seen = new Set<string>();

	// Builtins
	for (const name of BUILTIN_PI_THEMES) {
		if (seen.has(name)) continue;
		seen.add(name);
		out.push({
			name,
			source: "builtin",
			displayName: name,
			mode: name === "light" ? "light" : "dark",
		});
	}

	// Custom themes from ~/.pi/agent/themes/
	const dir = customThemesDir();
	try {
		if (dir && fs.existsSync(dir)) {
			for (const file of fs.readdirSync(dir) as string[]) {
				if (!file.endsWith(".json")) continue;
				const name = file.slice(0, -5);
				// w7a-render (control-char-theme-name-render): ~/.pi/agent/themes is
				// worker-writable, so a filename stem carrying control/escape chars
				// (OSC-52/OSC-8/CSI) is attacker-plantable. Refuse the file entirely —
				// it can never become a picker value or a listing line.
				if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) continue;
				if (seen.has(name)) continue;
				const fullPath = `${dir}/${file}`;
				let displayName: string | undefined;
				let mode: "dark" | "light" | undefined;
				try {
					const json = JSON.parse(fs.readFileSync(fullPath, "utf8"));
					// The JSON body is worker-writable too — the human-friendly name is
					// untrusted display text (w7a-render defense in depth).
					displayName = typeof json.name === "string" ? sanitizeUntrustedLine(json.name) : undefined;
					mode = detectThemeMode(json);
				} catch {
					// keep undefined
				}
				seen.add(name);
				out.push({
					name,
					source: "custom",
					path: fullPath,
					displayName,
					mode,
				});
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
	const p = settingsPath();
	if (!p) throw new Error("Could not determine settings path (no HOME).");
	let settings: Record<string, unknown> = {};
	if (fs.existsSync(p)) {
		// wave-2b (theme atomic): a corrupt/unreadable settings file must NEVER
		// be silently replaced — the old behavior parsed anything unreadable into
		// {} and wrote it back, wiping the user's entire settings on one bad
		// read. Only an EMPTY file legitimately starts fresh; anything else that
		// fails to read/parse aborts the write (the operator fixes or removes it).
		let raw: string;
		try {
			raw = fs.readFileSync(p, "utf8");
		} catch (error) {
			throw new Error(`setPiTheme: settings unreadable at ${p} (${(error as Error).message}) — refusing to overwrite`);
		}
		if (raw.trim().length > 0) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					throw new Error("settings root is not a JSON object");
				}
				settings = parsed as Record<string, unknown>;
			} catch {
				throw new Error(`setPiTheme: corrupt settings at ${p} — refusing to overwrite (fix or remove the file first)`);
			}
		}
	}
	settings.theme = name;
	// wave-2b (theme atomic): temp+rename so a crash mid-write cannot leave a
	// truncated settings.json behind (the read side then refuses to touch it).
	atomicWriteFile(p, JSON.stringify(settings, null, 2) + "\n");
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
	// w7a-render: theme names derived from worker-writable files (fs scan or
	// host theme list) are untrusted display text — sanitize before the
	// listing becomes tool-result content (R4-B1). Identity comparison above
	// stays on the raw name so switching keeps working.
	return `  ${isActive ? "●" : "○"} ${sanitizeUntrustedLine(t.name)}${src}${tag}`;
}
