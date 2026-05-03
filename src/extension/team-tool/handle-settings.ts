import type { TeamContext } from "../team-tool.ts";
import { loadConfig, updateConfig } from "../../config/config.ts";
import { configPatchFromConfig } from "../team-tool/config-patch.ts";
import { result } from "../team-tool/context.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";

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

function formatValue(value: unknown): string {
	if (value === undefined) return "<not set>";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function parseValue(raw: string): unknown {
	// JSON handles strings (quoted), numbers, booleans, null, arrays, objects.
	try { return JSON.parse(raw); } catch { /* keep as string */ }
	return raw;
}

// ---------------------------------------------------------------------------
// Known config keys — mirrors config-schema.ts + config.ts.
// When adding new config fields, add the dotted path here so team-settings
// can discover and display them.
// ---------------------------------------------------------------------------

const KNOWN_KEYS = new Set([
	// top-level
	"asyncByDefault",
	"executeWorkers",
	"notifierIntervalMs",
	"requireCleanWorktreeLeader",
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
	// tools
	"tools.enableClaudeStyleAliases",
	"tools.enableSteer",
	"tools.terminateOnForeground",
	// agents
	"agents.disableBuiltins",
	// observability
	"observability.prometheus.enabled",
	"observability.otlp.enabled",
	// worktree
	"worktree.enabled",
]);

const KNOWN_SORTED = [...KNOWN_KEYS].sort();

// ---------------------------------------------------------------------------
// Detail objects – all require { action, status } from TeamToolDetails.
// Extras (count, key, value, path) are passed as never to bypass the narrow
// TeamToolDetails interface (consistent with the rest of the codebase).
// ---------------------------------------------------------------------------

const OK = { action: "settings", status: "ok" as const };
const ERR = { action: "settings", status: "error" as const };

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export function handleSettings(params: { config?: Record<string, unknown> }, ctx: TeamContext): PiTeamsToolResult {
	const cfg = (params.config ?? {}) as Record<string, unknown>;
	const args = typeof cfg.args === "string" ? cfg.args.trim() : "";
	const scope = cfg.scope === "project" ? "project" : "user";
	const loaded = loadConfig(ctx.cwd);
	const effective = loaded.config as Record<string, unknown>;

	// team-settings list
	if (!args || args === "list") {
		const lines = ["pi-crew settings:", `Path: ${loaded.path}`, ""];
		for (const key of KNOWN_SORTED) {
			const value = getNested(effective, key);
			lines.push(`  ${key} = ${formatValue(value)}`);
		}
		lines.push("", "Usage: team-settings [list|get <key>|set <key> <value>|unset <key>|path|scope]");
		return result(lines.join("\n"), { ...OK, count: KNOWN_KEYS.size } as never);
	}

	// team-settings path
	if (args === "path") {
		return result(`pi-crew config path: ${loaded.path}`, { ...OK, path: loaded.path } as never);
	}

	// team-settings scope
	if (args === "scope") {
		return result(`Current scope: ${scope}\nConfig at: ${loaded.path}`, { ...OK, scope } as never);
	}

	// team-settings get <key>
	if (args.startsWith("get ")) {
		const key = args.slice(4).trim();
		if (!key) return result("Usage: team-settings get <key>", { ...ERR }, true);
		const value = getNested(effective, key);
		const note = KNOWN_KEYS.has(key) ? "" : " (unknown key — may not take effect)";
		return result(`${key} = ${formatValue(value)}${note}`, { ...OK, key, value } as never);
	}

	// team-settings unset <key>
	if (args.startsWith("unset ")) {
		const key = args.slice(6).trim();
		if (!key) return result("Usage: team-settings unset <key>", { ...ERR }, true);
		try {
			const saved = updateConfig({}, { cwd: ctx.cwd, scope, unsetPaths: [key] });
			return result(`Unset ${key}\nPath: ${saved.path}`, { ...OK, key } as never);
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), { ...ERR }, true);
		}
	}

	// team-settings set <key> <value>
	if (args.startsWith("set ")) {
		const rest = args.slice(4).trim();
		const spaceIdx = rest.indexOf(" ");
		if (spaceIdx === -1) return result("Usage: team-settings set <key> <value>", { ...ERR }, true);
		const key = rest.slice(0, spaceIdx);
		const rawValue = rest.slice(spaceIdx + 1).trim();
		if (!key) return result("Usage: team-settings set <key> <value>", { ...ERR }, true);

		const value = parseValue(rawValue);
		const patch = {};
		setNested(patch as Record<string, unknown>, key, value);

		try {
			const converted = configPatchFromConfig({ config: patch as Record<string, unknown> });
			const saved = updateConfig(converted, { cwd: ctx.cwd, scope });
			const warning = KNOWN_KEYS.has(key) ? "" : "\nWarning: unknown key — verify it exists in config schema.";
			return result(`Set ${key} = ${formatValue(value)}\nPath: ${saved.path}${warning}`, { ...OK, key, value } as never);
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), { ...ERR }, true);
		}
	}

	return result("Unknown subcommand. Usage: team-settings [list|get <key>|set <key> <value>|unset <key>|path|scope]", { ...ERR }, true);
}
