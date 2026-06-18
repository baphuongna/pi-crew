import type { TeamContext } from "../team-tool/context.ts";
import { loadConfig, updateConfig } from "../../config/config.ts";
import { configPatchFromConfig } from "../team-tool/config-patch.ts";
import { result } from "../team-tool/context.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { suggestConfigKey } from "../../config/suggestions.ts";
import {
	formatThemesListing,
	discoverPiThemes,
	setPiTheme,
} from "../../ui/theme-discovery.ts";

// ---------------------------------------------------------------------------
// Effective defaults — values used when config key is not set
// ---------------------------------------------------------------------------

const EFFECTIVE_DEFAULTS: Record<string, unknown> = {
	"runtime.mode": "auto",
	"runtime.maxTurns": 10000,
	"runtime.graceTurns": 5,
	"runtime.inheritContext": false,
	"runtime.promptMode": "replace",
	"runtime.completionMutationGuard": "warn",
	"runtime.isolationPolicy": undefined,
	"limits.maxConcurrentWorkers": 1024,
	"limits.maxTaskDepth": 100,
	"limits.maxRunMinutes": 1440,
	"limits.maxRetriesPerTask": 100,
	"limits.maxTasksPerRun": 10000,
	"limits.heartbeatStaleMs": 86400000,
	"agents.disableBuiltins": false,
	"ui.showModel": true,
	"ui.showTokens": true,
	"ui.showTools": true,
	"ui.dashboardPlacement": "center",
	"ui.dashboardWidth": 72,
	"ui.autoOpenDashboard": false,
	"ui.widgetPlacement": "aboveEditor",
	"autonomous.enabled": true,
	"autonomous.injectPolicy": true,
	"autonomous.preferAsyncForLongTasks": false,
	"autonomous.allowWorktreeSuggestion": true,
	"executeWorkers": true,
	"asyncByDefault": false,
	"notifierIntervalMs": 5000,
	"reliability.autoRetry": false,
	"reliability.autoRecover": false,
	"reliability.cleanupOrphanedTempDirs": true,
	"telemetry.enabled": false,
	"notifications.enabled": false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	let target: Record<string, unknown> = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		if (!target[keys[i]] || typeof target[keys[i]] !== "object") {
			target[keys[i]] = {};
		}
		target = target[keys[i]] as Record<string, unknown>;
	}
	target[keys[keys.length - 1]] = value;
}

function getNested(obj: Record<string, unknown>, path: string): unknown {
	const keys = path.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function formatValue(value: unknown, key?: string): string {
	if (value === undefined || value === null) {
		const def = key ? EFFECTIVE_DEFAULTS[key] : undefined;
		if (def !== undefined) return `${String(def)} (default)`;
		return "<not set>";
	}
	if (typeof value === "object") return JSON.stringify(value, null, 2);
	return String(value);
}

function parseValue(raw: string): unknown {
	// JSON handles strings (quoted), numbers, booleans, null, arrays, objects.
	try { return JSON.parse(raw); } catch { /* keep as string */ }
	return raw;
}

/**
 * Flatten a config object into dotted key=value pairs.
 * Objects are recursed; arrays and scalars are formatted as values.
 * `prefix` is the current dotted path (empty for root).
 */
function flattenConfig(obj: unknown, prefix: string = ""): string[] {
	const lines: string[] = [];
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return lines;
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		const dotted = prefix ? `${prefix}.${key}` : key;
		if (value === undefined) continue;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			// Check if it's a "leaf object" — a value-type record like agent overrides
			// where keys are agent names and values are { model, thinking, ... }
			const entries = Object.entries(value as Record<string, unknown>);
			const allLeafValues = entries.every(([, v]) =>
				v === undefined || v === null || typeof v !== "object" || Array.isArray(v)
			);
			if (allLeafValues && entries.length > 0) {
				// It's a flat record like { explorer: { model: "...", thinking: "..." } }
				// Check if nested values are objects (agent overrides pattern)
				const hasNestedObjects = entries.some(([, v]) => v && typeof v === "object" && !Array.isArray(v));
				if (hasNestedObjects) {
					lines.push(...flattenConfig(value, dotted));
				} else {
					lines.push(`  ${dotted} = ${formatValue(value, dotted)}`);
				}
			} else if (entries.length > 0) {
				lines.push(...flattenConfig(value, dotted));
			}
		} else {
			lines.push(`  ${dotted} = ${formatValue(value, dotted)}`);
		}
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Known config keys — mirrors config-schema.ts + config.ts.
// ---------------------------------------------------------------------------

const KNOWN_KEYS = new Set([
	// top-level
	"asyncByDefault",
	"executeWorkers",
	"notifierIntervalMs",
	"requireCleanWorktreeLeader",
	"ignoreMethod",
	// runtime
	"runtime.mode",
	"runtime.preferLiveSession",
	"runtime.allowChildProcessFallback",
	"runtime.maxTurns",
	"runtime.graceTurns",
	"runtime.inheritContext",
	"runtime.promptMode",
	"runtime.groupJoin",
	"runtime.groupJoinAckTimeoutMs",
	"runtime.requirePlanApproval",
	"runtime.completionMutationGuard",
	"runtime.effectivenessGuard",
	"runtime.isolationPolicy",
	// limits
	"limits.maxConcurrentWorkers",
	"limits.allowUnboundedConcurrency",
	"limits.maxTaskDepth",
	"limits.maxChildrenPerTask",
	"limits.maxRunMinutes",
	"limits.maxRetriesPerTask",
	"limits.maxTasksPerRun",
	"limits.heartbeatStaleMs",
	// control
	"control.enabled",
	"control.needsAttentionAfterMs",
	// autonomous
	"autonomous.profile",
	"autonomous.enabled",
	"autonomous.injectPolicy",
	"autonomous.preferAsyncForLongTasks",
	"autonomous.allowWorktreeSuggestion",
	"autonomous.magicKeywords",
	// tools
	"tools.enableClaudeStyleAliases",
	"tools.enableSteer",
	"tools.terminateOnForeground",
	// agents
	"agents.disableBuiltins",
	// observability
	"observability.enabled",
	"observability.pollIntervalMs",
	"observability.metricRetentionDays",
	// telemetry
	"telemetry.enabled",
	// policy
	"policy.requireIntentForDestructiveActions",
	"policy.disabledCapabilities",
	// notifications
	"notifications.enabled",
	"notifications.severityFilter",
	"notifications.dedupWindowMs",
	"notifications.batchWindowMs",
	"notifications.quietHours",
	"notifications.sinkRetentionDays",
	// reliability
	"reliability.autoRetry",
	"reliability.autoRecover",
	"reliability.cleanupOrphanedTempDirs",
	"reliability.deadletterThreshold",
	"reliability.retryPolicy.maxAttempts",
	"reliability.retryPolicy.backoffMs",
	"reliability.retryPolicy.jitterRatio",
	"reliability.retryPolicy.exponentialFactor",
	"reliability.retryPolicy.retryableErrors",
	// F7: opt-in model scope enforcement (hard-error caller out-of-scope, warn frontmatter).
	"reliability.scopeModels",
	// otlp
	"otlp.enabled",
	"otlp.endpoint",
	"otlp.intervalMs",
	// worktree
	"worktree.setupHook",
	"worktree.setupHookTimeoutMs",
	"worktree.linkNodeModules",
	// ui
	"ui.widgetPlacement",
	"ui.widgetMaxLines",
	"ui.dashboardPlacement",
	"ui.dashboardWidth",
	"ui.dashboardLiveRefreshMs",
	"ui.autoOpenDashboard",
	"ui.autoOpenDashboardForForegroundRuns",
	"ui.showModel",
	"ui.showTokens",
	"ui.showTools",
	"ui.transcriptTailBytes",
	"ui.powerbar",
	"ui.mascotStyle",
	"ui.mascotEffect",
]);

const KNOWN_SORTED = [...KNOWN_KEYS].sort();

// ---------------------------------------------------------------------------
// Detail objects
// ---------------------------------------------------------------------------

const OK = { action: "settings", status: "ok" as const };
const ERR = { action: "settings", status: "error" as const };

// ---------------------------------------------------------------------------
// Usage help
// ---------------------------------------------------------------------------

const USAGE = [
	"Usage: team-settings [command]",
	"  list                  Show all effective config values",
	"  json                  Show full effective config as JSON",
	"  schema                Show all known config keys (schema reference)",
	"  paths                 Show config file paths (user + project)",
	"  themes                Browse theme gallery (Pi UI themes)",
	"  theme <name>          Switch the Pi UI theme (applies live, no restart)",
	"  get <key>             Get a specific config value",
	"  set <key> <value>     Set a config value",
	"  unset <key>           Remove a config value",
	"  scope [user|project]  Get/set write scope for set/unset",
].join("\n");

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export function handleSettings(params: { config?: Record<string, unknown> }, ctx: TeamContext): PiTeamsToolResult {
	const cfg = (params.config ?? {}) as Record<string, unknown>;
	const args = typeof cfg.args === "string" ? cfg.args.trim() : "";
	const scope = cfg.scope === "project" ? "project" : "user";
	const loaded = loadConfig(ctx.cwd);
	const effective = loaded.config as Record<string, unknown>;

	// team-settings list — show ALL effective values (not just KNOWN_KEYS)
	if (!args || args === "list") {
		const lines = ["pi-crew effective settings:", `Config file: ${loaded.path}`, ""];
		const flatLines = flattenConfig(effective);
		if (flatLines.length > 0) {
			lines.push(...flatLines);
		} else {
			lines.push("  (all defaults — no config overrides)");
		}
		lines.push("", `Source paths: ${loaded.paths?.join(", ") ?? loaded.path}`);
		if (loaded.warnings?.length) {
			lines.push("", "Warnings:");
			for (const w of loaded.warnings) lines.push(`  ${w}`);
		}
		lines.push("", USAGE);
		return result(lines.join("\n"), { ...OK, count: flatLines.length } as never);
	}

	// team-settings json — full JSON dump
	if (args === "json") {
		const lines = [
			`// pi-crew effective config (merged from all sources)`,
			`// Config file: ${loaded.path}`,
			`// Sources: ${loaded.paths?.join(", ") ?? loaded.path}`,
			...loaded.warnings?.map(w => `// WARNING: ${w}`) ?? [],
			"",
			JSON.stringify(effective, null, 2),
		];
		return result(lines.join("\n"), { ...OK } as never);
	}

	// team-settings schema — show all known keys
	if (args === "schema") {
		const lines = ["pi-crew config schema (all known keys):", ""];
		for (const key of KNOWN_SORTED) {
			const value = getNested(effective, key);
			const marker = value !== undefined ? " ✓" : "";
			lines.push(`  ${key}${marker}`);
		}
		lines.push("", "✓ = currently set in config. Keys without ✓ use defaults.", "", USAGE);
		return result(lines.join("\n"), { ...OK, count: KNOWN_KEYS.size } as never);
	}

	// team-settings paths — show all config file paths
	if (args === "path" || args === "paths") {
		const lines = [
			"pi-crew config paths:",
			`  User config:     ${loaded.path}`,
		];
		if (ctx.cwd && loaded.paths) {
			for (const p of loaded.paths) {
				if (p !== loaded.path) lines.push(`  Additional:      ${p}`);
			}
		}
		lines.push(`  Write scope:     ${scope} (${scope === "project" ? projectConfigPath(ctx.cwd) : loaded.path})`);
		return result(lines.join("\n"), { ...OK, path: loaded.path } as never);
	}

	// team-settings themes — browse the theme gallery
	if (args === "themes" || args === "theme-gallery") {
		return result(formatThemesListing(), { ...OK } as never);
	}

	// team-settings theme <name> — switch the Pi UI theme
	if (args === "theme" || args.startsWith("theme ")) {
		const name = args === "theme" ? "" : args.slice(6).trim();
		if (!name) {
			const available = discoverPiThemes().map((t) => t.name).join(", ");
			return result(
				`Usage: team-settings theme <name>\n\nAvailable Pi themes: ${available}\n\nBrowse all: team-settings themes`,
				{ ...ERR },
				true,
			);
		}
		const available = discoverPiThemes();
		const exists = available.some((t) => t.name === name);
		if (!exists) {
			const hint = available.map((t) => t.name).join(", ");
			return result(
				`Unknown Pi theme: ${name}\n\nAvailable: ${hint}\n\nCustom themes live in ~/.pi/agent/themes/<name>.json`,
				{ ...ERR },
				true,
			);
		}
		try {
			const savedTo = setPiTheme(name);
			return result(
				[
					`✓ Pi theme set to '${name}'`,
					`  Written to: ${savedTo}`,
					`  Applied live — no restart needed.`,
				].join("\n"),
				{ ...OK, theme: name } as never,
			);
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), { ...ERR }, true);
		}
	}

	// team-settings shiki <name> — removed (Shiki highlighting dropped)
	if (args === "shiki" || args === "shiki-theme" || args.startsWith("shiki ") || args.startsWith("shiki-theme ")) {
		return result(
			`Shiki syntax highlighting has been removed from pi-crew.\nUse 'team-settings theme <name>' to switch the Pi UI theme, which drives code-block colors.`,
			{ ...ERR },
			true,
		);
	}

	// team-settings scope [user|project]
	if (args === "scope" || args.startsWith("scope ")) {
		const scopeArg = args === "scope" ? "" : args.slice(6).trim();
		if (!scopeArg) {
			return result([
				`Current write scope: ${scope}`,
				`  user    → writes to ${loaded.path}`,
				`  project → writes to ${projectConfigPath(ctx.cwd)}`,
				"Usage: team-settings scope [user|project]",
			].join("\n"), { ...OK, scope } as never);
		}
		if (scopeArg !== "user" && scopeArg !== "project") {
			return result("Scope must be 'user' or 'project'.", { ...ERR }, true);
		}
		return result([
			`Write scope is a per-command option. Use:`,
			`  team-settings set <key> <value>  (writes to ${scopeArg === "project" ? "project" : "user"} config)`,
			``,
			`To change scope for a single command, pass scope in the team tool:`,
			`  team(action="settings", config={ args: "set <key> <value>", scope: "${scopeArg}" })`,
		].join("\n"), { ...OK } as never);
	}

	// team-settings get <key>
	if (args.startsWith("get ")) {
		const key = args.slice(4).trim();
		if (!key) return result("Usage: team-settings get <key>\nUse 'team-settings schema' to see all known keys.", { ...ERR }, true);
		const value = getNested(effective, key);
		// Try to provide helpful note for unknown keys
		let note = "";
		if (!KNOWN_KEYS.has(key) && !key.startsWith("agents.overrides.")) {
			const suggestion = suggestConfigKey(key, KNOWN_SORTED);
			if (suggestion) note = `\n(did you mean '${suggestion}'?)`;
			else note = "\n(unknown key — may not take effect)";
		}
		return result(`${key} = ${formatValue(value, key)}${note}`, { ...OK, key, value } as never);
	}

	// team-settings unset <key>
	if (args.startsWith("unset ")) {
		const key = args.slice(6).trim();
		if (!key) return result("Usage: team-settings unset <key>", { ...ERR }, true);
		try {
			const saved = updateConfig({}, { cwd: ctx.cwd, scope, unsetPaths: [key] });
			return result(`Unset ${key}\nSaved to: ${saved.path}`, { ...OK, key } as never);
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), { ...ERR }, true);
		}
	}

	// team-settings set <key> <value>
	if (args.startsWith("set ")) {
		const rest = args.slice(4).trim();
		const spaceIdx = rest.indexOf(" ");
		if (spaceIdx === -1) return result("Usage: team-settings set <key> <value>\nExample: team-settings set runtime.mode child-process", { ...ERR }, true);
		const key = rest.slice(0, spaceIdx);
		const rawValue = rest.slice(spaceIdx + 1).trim();
		if (!key) return result("Usage: team-settings set <key> <value>", { ...ERR }, true);

		const value = parseValue(rawValue);
		const patch: Record<string, unknown> = {};
		setNested(patch, key, value);

		try {
			const converted = configPatchFromConfig(patch as Record<string, unknown>);
			const saved = updateConfig(converted, { cwd: ctx.cwd, scope });
			const reloadCheck = loadConfig(ctx.cwd);
			const effectiveValue = getNested(reloadCheck.config as Record<string, unknown>, key);

			let warning = "";
			if (!KNOWN_KEYS.has(key) && !key.startsWith("agents.overrides.") && !key.startsWith("ui.")) {
				const suggestion = suggestConfigKey(key, KNOWN_SORTED);
				warning = suggestion ? `\nWarning: unknown key. Did you mean '${suggestion}'?` : "\nWarning: unknown key — verify it exists in config schema.";
			}

			// Check if project config would sanitize this key
			if (scope === "project") {
				const sensitiveKeys = ["executeWorkers", "asyncByDefault", "runtime.mode", "runtime.preferLiveSession", "runtime.allowChildProcessFallback", "runtime.inheritContext", "runtime.isolationPolicy", "autonomous.profile", "autonomous.enabled", "autonomous.injectPolicy", "agents.overrides", "agents.disableBuiltins"];
				if (sensitiveKeys.some(k => key === k || key.startsWith(k + "."))) {
					warning += "\nNote: this key is sensitive and will be ignored in project-level config for security. Set it in user scope instead.";
				}
			}

			return result([
				`Set ${key} = ${formatValue(value, key)}`,
				`Effective: ${formatValue(effectiveValue, key)}`,
				`Saved to: ${saved.path}`,
				warning,
			].filter(Boolean).join("\n"), { ...OK, key, value } as never);
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), { ...ERR }, true);
		}
	}

	return result(`Unknown subcommand: ${args.split(" ")[0]}\n\n${USAGE}`, { ...ERR }, true);
}

import { projectCrewRoot } from "../../utils/paths.ts";

function projectConfigPath(cwd: string): string {
	return projectCrewRoot(cwd) + "/config.json";
}
