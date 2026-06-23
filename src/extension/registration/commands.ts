import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
// Lazy-loaded: team-tool.ts pulls in entire runtime chain (1.4s+).
import type { handleTeamTool as HandleTeamToolFn } from "../team-tool.ts";
let _cachedHandleTeamTool: typeof HandleTeamToolFn | undefined;
let _handleTeamToolPromise: Promise<typeof HandleTeamToolFn> | undefined;
async function handleTeamTool(params: Parameters<typeof HandleTeamToolFn>[0], ctx: Parameters<typeof HandleTeamToolFn>[1]): Promise<Awaited<ReturnType<typeof HandleTeamToolFn>>> {
	if (!_cachedHandleTeamTool) {
		if (!_handleTeamToolPromise) {
			_handleTeamToolPromise = import("../team-tool.ts").then((mod) => {
				_cachedHandleTeamTool = mod.handleTeamTool;
				return mod.handleTeamTool;
			});
		}
		const fn = await _handleTeamToolPromise;
		return fn(params, ctx);
	}
	return _cachedHandleTeamTool(params, ctx);
}
import { withSessionId } from "../team-tool/context.ts";
import { piTeamsHelp } from "../help.ts";
import { handleTeamManagerCommand } from "../team-manager-command.ts";
import { loadRunManifestById } from "../../state/state-store.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import { suggestRunIds, suggestTaskIds, suggestTeams } from "../command-completions.ts";
import * as path from "node:path";
// Heavy UI modules — lazy-loaded because they're only used in /crew commands.
// RunDashboard (288ms), DurableTextViewer (658ms), Overlays are unnecessary at Pi startup.
import type { RunDashboard as RunDashboardType, RunDashboardSelection } from "../../ui/run-dashboard.ts";
import type { DurableTextViewer as DurableTextViewerType } from "../../ui/transcript-viewer.ts";
import type { ConfirmOverlay as ConfirmOverlayType, ConfirmOptions } from "../../ui/overlays/confirm-overlay.ts";
import type { MailboxDetailOverlay as MailboxDetailOverlayType, MailboxAction } from "../../ui/overlays/mailbox-detail-overlay.ts";
import type { MailboxComposeOverlay as MailboxComposeOverlayType, MailboxComposeResult } from "../../ui/overlays/mailbox-compose-overlay.ts";
import type { AgentPickerOverlay as AgentPickerOverlayType } from "../../ui/overlays/agent-picker-overlay.ts";
import type { AnimatedMascot as AnimatedMascotType } from "../../ui/mascot.ts";
// Eagerly import lightweight modules
import { dispatchDiagnosticExport, dispatchHealthRecovery, dispatchKillStaleWorkers, dispatchMailboxAck, dispatchMailboxAckAll, dispatchMailboxCompose, dispatchMailboxNudge } from "../../ui/run-action-dispatcher.ts";
import { DEFAULT_UI } from "../../config/defaults.ts";
import { listRecentDiagnostic } from "../../runtime/diagnostic-export.ts";
import { commandText, notifyCommandResult, parseRunArgs, parseScalar, pushUnset, setNestedConfig } from "./command-utils.ts";
import { openTranscriptViewer, selectAgentTask, openLiveConversation } from "./viewers.ts";
import { getBuiltinTemplates, instantiateTemplate, listTemplates } from "../../skills/skill-templates.ts";
import * as fs from "node:fs";
import { printTimings, time } from "../../utils/timings.ts";
import { requestRenderTarget } from "../../ui/pi-ui-compat.ts";
import type { createRunSnapshotCache } from "../../ui/run-snapshot-cache.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";

export interface RegisterTeamCommandsDeps {
	startForegroundRun: (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	abortForegroundRun: (runId: string) => boolean;
	openLiveSidebar: (ctx: ExtensionContext, runId: string) => void;
	getManifestCache: (cwd: string) => { list(max?: number): TeamRunManifest[] };
	getRunSnapshotCache?: (cwd: string) => ReturnType<typeof createRunSnapshotCache>;
	getMetricRegistry?: () => MetricRegistry | undefined;
	dismissNotifications?: () => void;
}

// Lazy-loaded UI module cache — avoids importing 900ms+ of UI at Pi startup.
// These modules are only needed when user invokes /crew commands.
let _uiCache: {
	RunDashboard: typeof RunDashboardType;
	DurableTextViewer: typeof DurableTextViewerType;
	ConfirmOverlay: typeof ConfirmOverlayType;
	MailboxDetailOverlay: typeof MailboxDetailOverlayType;
	MailboxComposeOverlay: typeof MailboxComposeOverlayType;
	AgentPickerOverlay: typeof AgentPickerOverlayType;
	AnimatedMascot: typeof AnimatedMascotType;
} | undefined;
let _uiCachePromise: Promise<NonNullable<typeof _uiCache>> | undefined;
async function ui(): Promise<NonNullable<typeof _uiCache>> {
	if (!_uiCache) {
		if (!_uiCachePromise) {
			_uiCachePromise = (async () => {
				const [rd, tv, co, md, mc, ap, ma] = await Promise.all([
					import("../../ui/run-dashboard.ts"),
					import("../../ui/transcript-viewer.ts"),
					import("../../ui/overlays/confirm-overlay.ts"),
					import("../../ui/overlays/mailbox-detail-overlay.ts"),
					import("../../ui/overlays/mailbox-compose-overlay.ts"),
					import("../../ui/overlays/agent-picker-overlay.ts"),
					import("../../ui/mascot.ts"),
				]);
				const cache = {
					RunDashboard: rd.RunDashboard,
					DurableTextViewer: tv.DurableTextViewer,
					ConfirmOverlay: co.ConfirmOverlay,
					MailboxDetailOverlay: md.MailboxDetailOverlay,
					MailboxComposeOverlay: mc.MailboxComposeOverlay,
					AgentPickerOverlay: ap.AgentPickerOverlay,
					AnimatedMascot: ma.AnimatedMascot,
				};
				_uiCache = cache;
				return cache;
			})();
		}
		return _uiCachePromise;
	}
	return _uiCache;
}

async function openConfirm(ctx: ExtensionCommandContext, options: ConfirmOptions): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const { ConfirmOverlay } = await ui();
	return await ctx.ui.custom<boolean>((_tui, theme, _keybindings, done) => new ConfirmOverlay(options, done, theme), { overlay: true, overlayOptions: { width: 64, maxHeight: "70%", anchor: "center" } });
}

async function handleMailboxDashboardAction(ctx: ExtensionCommandContext, runId: string): Promise<void> {
	if (!ctx.hasUI) return;
	const { MailboxDetailOverlay } = await ui();
	const action = await ctx.ui.custom<MailboxAction | undefined>((_tui, theme, _keybindings, done) => new MailboxDetailOverlay({ runId, cwd: ctx.cwd, done, theme }), { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
	if (!action || action.type === "close") return;
	let resultMessage: string | undefined;
	let ok = true;
	if (action.type === "ack") {
		const result = await dispatchMailboxAck(ctx as ExtensionContext, runId, action.messageId);
		ok = result.ok;
		resultMessage = result.message;
	} else if (action.type === "ackAll") {
		const confirmed = await openConfirm(ctx, { title: "Acknowledge all unread messages?", body: "This cannot be undone. Y=ack all, N=cancel.", dangerLevel: "medium", defaultAction: "cancel" });
		if (!confirmed) return;
		const result = await dispatchMailboxAckAll(ctx as ExtensionContext, runId);
		ok = result.ok;
		resultMessage = result.message;
	} else if (action.type === "compose") {
		const { MailboxComposeOverlay } = await ui();
		const compose = await ctx.ui.custom<MailboxComposeResult>((_tui, theme, _keybindings, done) => new MailboxComposeOverlay({ done, theme }), { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
		if (compose.type === "cancel") return;
		const result = await dispatchMailboxCompose(ctx as ExtensionContext, runId, compose.payload);
		ok = result.ok;
		resultMessage = result.message;
	} else if (action.type === "nudge") {
		let agentId = action.agentId;
		if (!agentId) {
			const { AgentPickerOverlay } = await ui();
			const picked = await ctx.ui.custom<{ agentId: string } | undefined>((_tui, theme, _keybindings, done) => new AgentPickerOverlay({ cwd: ctx.cwd, runId, done, theme }), { overlay: true, overlayOptions: { width: 72, maxHeight: "75%", anchor: "center" } });
			agentId = picked?.agentId;
		}
		if (!agentId) return;
		const result = await dispatchMailboxNudge(ctx as ExtensionContext, runId, agentId, "Please report your current status, blocker, or smallest next step.");
		ok = result.ok;
		resultMessage = result.message;
	}
	depsNotify(ctx, resultMessage ?? "Mailbox action complete.", ok ? "info" : "error");
}

function depsNotify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

function teamCommandContext(ctx: ExtensionCommandContext): ExtensionCommandContext & { sessionId?: string } {
	return withSessionId(ctx);
}

/**
 * Open the pi-crew settings overlay (config editor + theme picker).
 *
 * Extracted from the `team-settings` command so it is reusable from a
 * keyboard shortcut. Takes the base `ExtensionContext` (the shortcut
 * handler's context) — uses only `hasUI`, `cwd`, and `ui` fields, so both
 * `ExtensionContext` and `ExtensionCommandContext` satisfy it.
 */
export async function openTeamSettingsOverlay(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const [{ updateConfig, parseConfig }, { asCrewTheme }, { createSettingsOverlay }] = await Promise.all([
		import("../../config/config.ts"),
		import("../../ui/theme-adapter.ts"),
		import("../../ui/settings-overlay.ts"),
	]);
	const loaded = loadConfig(ctx.cwd);
	const config = loaded.config as Record<string, unknown>;
	await ctx.ui.custom<undefined>((_tui, _theme, _keybindings, done) => {
		const theme = asCrewTheme(_theme);
		const { overlay } = createSettingsOverlay(config, theme, (id: string, value: unknown) => {
			try {
				const patch: Record<string, unknown> = {};
				const keys = id.split(".");
				let target: Record<string, unknown> = patch;
				for (let i = 0; i < keys.length - 1; i++) {
					if (!target[keys[i]!] || typeof target[keys[i]!] !== "object") target[keys[i]!] = {};
					target = target[keys[i]!] as Record<string, unknown>;
				}
				target[keys[keys.length - 1]!] = value;
				if (value === undefined) { updateConfig({}, { unsetPaths: [id] }); }
				else { updateConfig(parseConfig(patch)); }
			} catch (error) {
				ctx.ui.notify(`Failed to save: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}, () => done(undefined), async (action: string, value: unknown) => {
			// Action callbacks (Pi theme switch) write to a different store
			// than pi-crew config (e.g. ~/.pi/agent/settings.json).
			try {
				if (action === "piTheme" && typeof value === "string") {
					// Live theme switch: ctx.ui.setTheme() swaps the global theme,
					// persists it to settings.json, and triggers a UI redraw — no
					// restart needed. Falls back to file-write + restart hint if
					// the live API is unavailable (e.g. non-TUI mode).
					if (typeof ctx.ui.setTheme === "function") {
						const res = ctx.ui.setTheme(value);
						if (res.success) {
							ctx.ui.notify(`Theme: ${value} (applied live)`, "info");
						} else {
		// LAZY: defer dynamic import of ../../ui/theme-discovery.ts to its call site.
							const { setPiTheme } = await import("../../ui/theme-discovery.ts");
							setPiTheme(value);
							ctx.ui.notify(`Theme saved as '${value}' but failed to apply: ${res.error ?? "unknown"}. Restart Pi.`, "warning");
						}
					} else {
		// LAZY: defer dynamic import of ../../ui/theme-discovery.ts to its call site.
						const { setPiTheme } = await import("../../ui/theme-discovery.ts");
						setPiTheme(value);
						ctx.ui.notify(`Pi theme set to '${value}'. Restart Pi to apply.`, "info");
					}
				}
			} catch (error) {
				ctx.ui.notify(`Failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		});
		return overlay;
	}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
}

async function handleHealthDashboardAction(ctx: ExtensionCommandContext, selection: RunDashboardSelection): Promise<void> {
	const loaded = loadRunManifestById(ctx.cwd, selection.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) {
		depsNotify(ctx, `Run '${selection.runId}' not found.`, "error");
		return;
	}
	if (selection.action === "health-recovery") {
		if (loaded.manifest.async) {
			depsNotify(ctx, "Recovery is only available for foreground runs.", "warning");
			return;
		}
		const confirmed = await openConfirm(ctx, { title: "Interrupt foreground run?", body: "Tasks may be marked failed. Y=interrupt, N=cancel.", dangerLevel: "high", defaultAction: "cancel" });
		if (!confirmed) return;
		const result = await dispatchHealthRecovery(ctx as ExtensionContext, selection.runId);
		depsNotify(ctx, result.message, result.ok ? "info" : "error");
		return;
	}
	if (selection.action === "health-kill-stale") {
		const confirmed = await openConfirm(ctx, { title: "Mark stale workers dead?", body: "This updates worker heartbeat state. Y=mark dead, N=cancel.", dangerLevel: "medium", defaultAction: "cancel" });
		if (!confirmed) return;
		const result = await dispatchKillStaleWorkers(ctx as ExtensionContext, selection.runId);
		depsNotify(ctx, result.message, result.ok ? "info" : "error");
		return;
	}
	if (selection.action === "health-diagnostic-export") {
		const diagDir = path.join(loaded.manifest.artifactsRoot, "diagnostic");
		const recent = listRecentDiagnostic(diagDir, 60_000);
		if (recent) {
			const confirmed = await openConfirm(ctx, { title: "Recent diagnostic exists", body: `File ${recent} was created <1min ago. Export another diagnostic?`, defaultAction: "cancel" });
			if (!confirmed) return;
		}
		const result = await dispatchDiagnosticExport(ctx as ExtensionContext, selection.runId, { registry: depsRef?.getMetricRegistry?.() });
		depsNotify(ctx, result.message, result.ok ? "info" : "error");
	}
}

let depsRef: RegisterTeamCommandsDeps | undefined;

export function registerTeamCommands(pi: ExtensionAPI, deps: RegisterTeamCommandsDeps): void {
	depsRef = deps;
	pi.registerCommand("teams", {
		description: "List pi-crew teams, workflows, and agents",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "list" }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-run", {
		description: "Manually start a pi-crew run (agent may also use the team tool autonomously)",
		// Round 13 UX: suggest team names for Tab-completion of the first positional arg.
		getArgumentCompletions: (argumentPrefix: string) => suggestTeams(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool(parseRunArgs(args), { ...teamCommandContext(ctx), metricRegistry: deps.getMetricRegistry?.(), startForegroundRun: (runner, runId) => deps.startForegroundRun(ctx as ExtensionContext, runner, runId), abortForegroundRun: deps.abortForegroundRun, onRunStarted: undefined });
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	for (const [name, action, description] of [
		["team-status", "status", "Show pi-crew run status"],
		["team-resume", "resume", "Resume a pi-crew run by re-queueing failed/cancelled/skipped/running tasks"],
		["team-summary", "summary", "Show pi-crew run summary"],
		["team-events", "events", "Show full pi-crew event log for a run"],
		["team-artifacts", "artifacts", "List pi-crew artifacts for a run"],
		["team-worktrees", "worktrees", "List pi-crew worktrees for a run"],
		["team-export", "export", "Export a pi-crew run bundle to artifacts/export"],
		["team-cancel", "cancel", "Cancel a pi-crew run"],
	] as const) {
		pi.registerCommand(name, {
			description,
			// Round 13 UX: suggest recent run IDs for Tab-completion.
			getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const runId = args.trim() || undefined;
				const result = await handleTeamTool({ action, runId }, { ...teamCommandContext(ctx), getRunSnapshotCache: deps.getRunSnapshotCache });
				await notifyCommandResult(ctx, commandText(result));
			},
		});
	}

	pi.registerCommand("team-invalidate", {
		description: "Invalidate the snapshot cache for a run so the UI refreshes immediately: <runId>",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			if (!runId) {
				await notifyCommandResult(ctx, "Usage: /team-invalidate <runId>");
				return;
			}
			const result = await handleTeamTool({ action: "invalidate", runId }, { ...teamCommandContext(ctx), getRunSnapshotCache: deps.getRunSnapshotCache });
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-retry", {
		description: "Retry failed/cancelled pi-crew tasks: <runId> [taskId]",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.shift();
			const taskId = tokens.shift();
			if (!runId) {
				await notifyCommandResult(ctx, "Usage: /team-retry <runId> [taskId]");
				return;
			}
			const retryResult = await handleTeamTool({ action: "retry", runId, taskId }, { ...teamCommandContext(ctx), getRunSnapshotCache: deps.getRunSnapshotCache });
			await notifyCommandResult(ctx, commandText(retryResult));
		},
	});

	pi.registerCommand("team-respond", {
		description: "Respond to a waiting pi-crew task: <runId> <taskId|--all> <message>",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.shift();
			const taskToken = tokens[0] === "--all" ? tokens.shift() : tokens.shift();
			const taskId = taskToken === "--all" ? undefined : taskToken;
			const message = tokens.join(" ") || undefined;
			const result = await handleTeamTool({ action: "respond", runId, taskId, message }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-follow-up", {
		description: "Send a follow-up prompt to a pi-crew task: <runId> <taskId> <prompt>",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.shift();
			const taskId = tokens.shift();
			const prompt = tokens.join(" ") || undefined;
			if (!runId || !taskId || !prompt) {
				await notifyCommandResult(ctx, "Usage: /team-follow-up <runId> <taskId> <prompt>. Use /team-respond for waiting-task replies.");
				return;
			}
			const result = await handleTeamTool({ action: "api", runId, config: { operation: "follow-up-agent", taskId, prompt } }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-api", {
		description: "Run safe pi-crew API interop operations: <runId> <operation> [key=value]",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const positional = tokens.filter((token) => !token.includes("=") && !token.startsWith("--"));
			const runIdLessOperations = new Set(["metrics-snapshot"]);
			const first = positional[0];
			const runId = first && runIdLessOperations.has(first) ? undefined : first;
			const operation = runId ? (positional[1] ?? "read-manifest") : (first ?? "read-manifest");
			const config: Record<string, unknown> = { operation };
			for (const token of tokens.filter((item) => item.includes("="))) {
				const [key, ...rest] = token.split("=");
				if (key) config[key] = parseScalar(rest.join("="));
			}
			const result = await handleTeamTool({ action: "api", runId, config }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-goal", {
		description: "Autonomous goal loop control: [start|status|pause|resume|stop|step|clear] [goalId] [--objective=...] [--evaluatorModel=...] [--maxTurns=N]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const knownSubs = new Set(["start", "status", "pause", "resume", "stop", "step", "clear", "cancel", "reset"]);
			const subAction = tokens[0] && knownSubs.has(tokens[0]) ? tokens[0] : "status";
			const positional = tokens.filter((token) => !token.includes("=") && !token.startsWith("--") && token !== subAction);
			const goalId = positional[0];
			const config: Record<string, unknown> = { subAction };
			if (goalId) config.goalId = goalId;
			for (const token of tokens.filter((item) => item.includes("="))) {
				const [key, ...rest] = token.split("=");
				if (key) config[key.replace(/^--/, "")] = parseScalar(rest.join("="));
			}
			const result = await handleTeamTool({ action: "goal", config }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("workflows", {
		description: "List all workflows (static + dynamic .dwf.ts)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "workflow-list" }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-metrics", { description: "Show pi-crew metrics snapshot: [filter]", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const filter = args.trim() || undefined;
		const result = await handleTeamTool({ action: "api", config: { operation: "metrics-snapshot", filter } }, { ...teamCommandContext(ctx), metricRegistry: deps.getMetricRegistry?.() });
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-imports", { description: "List imported pi-crew run bundles", handler: async (_args: string, ctx: ExtensionCommandContext) => {
		const result = await handleTeamTool({ action: "imports" }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-import", { description: "Import a pi-crew run-export.json bundle into local imports", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const pathArg = tokens.find((token) => !token.startsWith("--"));
		const scope = tokens.includes("--user") ? "user" : "project";
		const result = await handleTeamTool({ action: "import", config: { path: pathArg, scope } }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-prune", { description: "Prune old finished pi-crew runs, keeping the newest N", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const keepToken = tokens.find((token) => token.startsWith("--keep="));
		const keep = keepToken ? Number.parseInt(keepToken.slice("--keep=".length), 10) : undefined;
		const result = await handleTeamTool({ action: "prune", keep, confirm: tokens.includes("--confirm") }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-forget", { description: "Forget a pi-crew run by deleting its state and artifacts", getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix), handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const runId = tokens.find((token) => !token.startsWith("--"));
		const result = await handleTeamTool({ action: "forget", runId, force: tokens.includes("--force"), confirm: tokens.includes("--confirm") }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-settings", {
	description: "View or update pi-crew settings: interactive UI or [list|get <key>|set <key> <value>|unset <key>|path|scope]",
	handler: async (args: string, ctx: ExtensionCommandContext) => {
		if (ctx.hasUI && !args.trim()) {
			await openTeamSettingsOverlay(ctx);
			return;
		}
		const result = await handleTeamTool({ action: "settings", config: { args: args.trim() } }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
		// Live-switch hook: when the text subcommand 'theme <name>' succeeds,
		// also apply the theme live via ctx.ui.setTheme() (no restart). The
		// handler above only writes to settings.json.
		const trimmed = args.trim();
		if (trimmed.startsWith("theme ")) {
			const themeName = trimmed.slice(6).trim();
			if (themeName && typeof ctx.ui.setTheme === "function") {
				const res = ctx.ui.setTheme(themeName);
				if (res.success) ctx.ui.notify(`Theme: ${themeName} (applied live)`, "info");
				else ctx.ui.notify(`Saved but live-switch failed: ${res.error ?? "unknown"}. Restart Pi.`, "warning");
			}
		}
	},
})

	pi.registerCommand("team-manager", { description: "Open the pi-crew interactive menu (list/run/status/cleanup/manage resources/doctor)", handler: handleTeamManagerCommand });
	// Backward-compat alias: this command was originally registered as "team-cleanup"
	// (the interactive menu predates the runId-targeted cleanup action). Keep both so
	// existing muscle memory + help docs both work.
	pi.registerCommand("team-cleanup-menu", { description: "Alias for /team-manager (pi-crew interactive menu)", handler: handleTeamManagerCommand });

	pi.registerCommand("team-result", { description: "Open a pi-crew agent result viewer: <runId> [taskId]", getArgumentCompletions: async (argumentPrefix: string) => { const parts = argumentPrefix.trim().split(/\s+/); return parts.length <= 1 ? suggestRunIds(parts[0] ?? "") : suggestTaskIds(parts[0] ?? "", parts[1] ?? ""); }, handler: async (args: string, ctx: ExtensionCommandContext) => {
		const [runId, rawTaskId] = args.trim().split(/\s+/).filter(Boolean);
		const selected = await selectAgentTask(ctx, runId, rawTaskId);
		const loaded = selected ? loadRunManifestById(ctx.cwd, selected.runId) : undefined; // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
		if (ctx.hasUI && loaded) {
			const agent = readCrewAgents(loaded.manifest).find((item) => item.taskId === selected?.taskId || item.id === selected?.taskId) ?? readCrewAgents(loaded.manifest)[0];
			const resultText = agent?.resultArtifactPath ? commandText(await handleTeamTool({ action: "api", runId: selected?.runId ?? "", config: { operation: "read-agent-output", agentId: agent.taskId, maxBytes: 64_000 } }, teamCommandContext(ctx))) : "(no result)";
			const { DurableTextViewer } = await ui();
			await ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) => new DurableTextViewer("pi-crew result", `${selected?.runId ?? ""}:${agent?.taskId ?? "unknown"}`, resultText.split(/\r?\n/), theme, done), { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
			return;
		}
		const result = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-output", agentId: rawTaskId, maxBytes: 64_000 } }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-transcript", { description: "Open a pi-crew transcript viewer: <runId> [taskId]", getArgumentCompletions: async (argumentPrefix: string) => { const parts = argumentPrefix.trim().split(/\s+/); return parts.length <= 1 ? suggestRunIds(parts[0] ?? "") : suggestTaskIds(parts[0] ?? "", parts[1] ?? ""); }, handler: async (args: string, ctx: ExtensionCommandContext) => {
		const [runId, taskId] = args.trim().split(/\s+/).filter(Boolean);
		if (await openTranscriptViewer(ctx, runId, taskId)) return;
		const result = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-transcript", agentId: taskId } }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-dashboard", { description: "Open a pi-crew run dashboard overlay", handler: async (_args: string, ctx: ExtensionCommandContext) => {
		for (;;) {
			// Extract sessionId for workspace-scoped filtering
			const sessionId = ctx.sessionManager?.getSessionId?.();
			const runs = deps.getManifestCache(ctx.cwd).list(50);
			const uiConfig = loadConfig(ctx.cwd).config.ui;
			const rightPanel = (uiConfig?.dashboardPlacement ?? DEFAULT_UI.dashboardPlacement) === "right";
			const width = rightPanel ? Math.min(90, Math.max(40, uiConfig?.dashboardWidth ?? DEFAULT_UI.dashboardWidth)) : "90%";
			const { RunDashboard } = await ui();
			const selection = await ctx.ui.custom<RunDashboardSelection | undefined>((tui, theme, _keybindings, done) => new RunDashboard(runs, done, theme, { placement: rightPanel ? "right" : "center", showModel: uiConfig?.showModel, showTokens: uiConfig?.showTokens, showTools: uiConfig?.showTools, snapshotCache: deps.getRunSnapshotCache?.(ctx.cwd), runProvider: () => deps.getManifestCache(ctx.cwd).list(50), registry: deps.getMetricRegistry?.(), workspaceId: sessionId, requestRender: () => requestRenderTarget(tui) }), { overlay: true, overlayOptions: rightPanel ? { width, minWidth: 40, maxHeight: "100%", anchor: "top-right", offsetX: 0, offsetY: 0, margin: { top: 0, right: 0, bottom: 0, left: 0 } } : { width, maxHeight: "90%", anchor: "center", margin: 2 } });
			if (!selection) return;
			if (selection.action === "reload") continue;
			if (selection.action === "notifications-dismiss") {
				deps.dismissNotifications?.();
				ctx.ui.notify("pi-crew notifications dismissed.", "info");
				continue;
			}
			if (selection.action === "mailbox-detail") {
				await handleMailboxDashboardAction(ctx, selection.runId);
				deps.getRunSnapshotCache?.(ctx.cwd).invalidate(selection.runId);
				continue;
			}
			if (selection.action === "health-recovery" || selection.action === "health-kill-stale" || selection.action === "health-diagnostic-export") {
				await handleHealthDashboardAction(ctx, selection);
				deps.getRunSnapshotCache?.(ctx.cwd).invalidate(selection.runId);
				continue;
			}
			if (selection.action === "agent-transcript" && await openTranscriptViewer(ctx, selection.runId)) continue;
			if (selection.action === "agent-live" && await openLiveConversation(ctx, selection.runId)) continue;
			if (selection.action === "agent-live") { await notifyCommandResult(ctx, commandText({ content: [{ type: "text", text: "No live agent found for this run." }] })); continue; }
			const result = selection.action === "api" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-manifest" } }, teamCommandContext(ctx)) : selection.action === "agents" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "agent-dashboard" } }, teamCommandContext(ctx)) : selection.action === "mailbox" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-mailbox" } }, teamCommandContext(ctx)) : selection.action === "agent-events" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-agent-events", limit: 50 } }, teamCommandContext(ctx)) : selection.action === "agent-output" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-agent-output", maxBytes: 32_000 } }, teamCommandContext(ctx)) : selection.action === "agent-transcript" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-agent-transcript" } }, teamCommandContext(ctx)) : // eslint-disable-next-line @typescript-eslint/no-explicit-any
				await handleTeamTool({ action: selection.action as any, runId: selection.runId }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
			return;
		}
	} });

	pi.registerCommand("team-mascot", { description: "Show an animated mascot splash", handler: async (args: string, ctx: ExtensionCommandContext) => {
		if (!ctx.hasUI) return;
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const uiConfig = loadConfig(ctx.cwd).config.ui;
		const styleArg = tokens.find((t) => t === "cat" || t === "armin");
		const effectArg = tokens.find((t) => ["random", "none", "typewriter", "scanline", "rain", "fade", "crt", "glitch", "dissolve"].includes(t));
		const style = (styleArg as "cat" | "armin" | undefined) ?? uiConfig?.mascotStyle ?? DEFAULT_UI.mascotStyle;
		const effect = (effectArg as "random" | "none" | "typewriter" | "scanline" | "rain" | "fade" | "crt" | "glitch" | "dissolve" | undefined) ?? uiConfig?.mascotEffect ?? DEFAULT_UI.mascotEffect;
		const { AnimatedMascot } = await ui();
		await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new AnimatedMascot(theme, () => done(undefined), { frameIntervalMs: style === "armin" ? 33 : 180, autoCloseMs: 7000, requestRender: () => requestRenderTarget(tui), style, effect }), { overlay: true, overlayOptions: { width: style === "armin" ? 48 : 62, maxHeight: "85%", anchor: "center" } });
	} });

	pi.registerCommand("team-init", { description: "Initialize pi-crew layout and global config. Use --project-config to write .pi/pi-crew.json.", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const configScope = tokens.includes("--project-config") || tokens.includes("--project") ? "project" : tokens.includes("--no-config") ? "none" : "global";
		const result = await handleTeamTool({ action: "init", config: { copyBuiltins: tokens.includes("--copy-builtins"), overwrite: tokens.includes("--overwrite"), configScope } }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-autonomy", { description: "Show or toggle pi-crew autonomous delegation policy: status|on|off", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const mode = tokens[0]?.toLowerCase();
		const config = mode === "on" ? { profile: "suggested", enabled: true, injectPolicy: true } : mode === "off" ? { profile: "manual", enabled: false } : mode === "manual" || mode === "suggested" || mode === "assisted" || mode === "aggressive" ? { profile: mode, enabled: mode !== "manual", injectPolicy: mode !== "manual" } : { preferAsyncForLongTasks: tokens.includes("--prefer-async") ? true : undefined, allowWorktreeSuggestion: tokens.includes("--no-worktree-suggest") ? false : undefined };
		const result = await handleTeamTool({ action: "autonomy", config }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-config", { description: "Show or update pi-crew config. Use key=value [--project] to update.", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) {
			const result = await handleTeamTool({ action: "config" }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
			return;
		}
		const config: Record<string, unknown> = { scope: tokens.includes("--project") ? "project" : "user" };
		for (const token of tokens) {
			if (token.startsWith("--unset=")) {
				pushUnset(config, token.slice("--unset=".length));
				continue;
			}
			if (!token.includes("=")) continue;
			const [key, ...rest] = token.split("=");
			if (!key) continue;
			const raw = rest.join("=");
			if (raw === "unset" || raw === "null") pushUnset(config, key);
			else setNestedConfig(config, key, parseScalar(raw));
		}
		const result = await handleTeamTool({ action: "config", config }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	for (const [name, action, description] of [
		["team-validate", "validate", "Validate pi-crew agents, teams, and workflows"],
		["team-doctor", "doctor", "Check pi-crew installation and discovery readiness"],
	] as const) pi.registerCommand(name, { description, handler: async (_args: string, ctx: ExtensionCommandContext) => {
		const result = await handleTeamTool({ action }, teamCommandContext(ctx));
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("skill-list", { description: "List available builtin skill templates. Use --json for machine-readable output.", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const asJson = args.trim().split(/\s+/).includes("--json");
		const templates = listTemplates();
		if (asJson) {
			await notifyCommandResult(ctx, JSON.stringify(templates, null, 2));
		} else {
			const lines = ["Available builtin skill templates:", ""];
			for (const t of templates) {
				lines.push(`  ${t.id.padEnd(20)} ${t.description}`);
				lines.push(`    Variables: ${t.variables.map((v) => (v.required ? "[required] " : "[optional] ") + v.name).join(", ")}`);
			}
			lines.push("");
			lines.push("Create a skill: /skill-create <template-id> --var key=value [--var ...]");
			await notifyCommandResult(ctx, lines.join("\n"));
		}
	} });

	pi.registerCommand("skill-create", { description: "Create a skill from a builtin template: <template-id> [--var key=value...] [--project]", handler: async (args: string, ctx: ExtensionCommandContext) => {
		// LAZY: load withSessionId only when needed for skill-create command
		const { withSessionId } = await import("../team-tool/context.ts");
		const sessionId = withSessionId(ctx);
		const cwd = (ctx as unknown as { workspaceFolder?: { uri: { fsPath: string } } }).workspaceFolder?.uri?.fsPath ?? process.cwd();
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const useProject = tokens.includes("--project");
		const varEntries = tokens.filter((t) => t.startsWith("--var=") || t.startsWith("--var ")).map((t) => t.replace(/^--var(?:\s+|=)/, "").split("=", 2) as [string, string]);
		const templateId = tokens.find((t) => !t.startsWith("--") && !t.includes("="));
		if (!templateId) {
			await notifyCommandResult(ctx, "Usage: /skill-create <template-id> [--var key=value...] [--project]\nRun /skill-list to see available templates.");
			return;
		}
		const template = getBuiltinTemplates().find((t) => t.id === templateId);
		if (!template) {
			await notifyCommandResult(ctx, `Unknown template '${templateId}'. Run /skill-list to see available templates.`);
			return;
		}
		const variables: Record<string, string> = {};
		const errors: string[] = [];
		for (const v of template.variables) {
			const entry = varEntries.find(([k]) => k === v.name);
			if (!entry) {
				if (v.required) errors.push(`Missing required variable: ${v.name} (${v.description})`);
				else if (v.defaultValue !== undefined) variables[v.name] = v.defaultValue;
				continue;
			}
			const [, value] = entry;
			if (v.options && !v.options.includes(value)) {
				errors.push(`Invalid value '${value}' for '${v.name}'. Allowed: ${v.options.join(", ")}`);
				continue;
			}
			variables[v.name] = value;
		}
		if (errors.length > 0) {
			await notifyCommandResult(ctx, errors.join("\n"));
			return;
		}
		let instantiated: { filename: string; content: string };
		try {
			instantiated = instantiateTemplate(template, variables);
		} catch (error) {
			await notifyCommandResult(ctx, error instanceof Error ? error.message : String(error));
			return;
		}
		const skillsDir = path.resolve(cwd, useProject ? "skills" : path.join(path.dirname(require.resolve("../../../package.json", { paths: [__dirname] })), "skills"));
		const skillDir = path.join(skillsDir, template.id);
		const skillPath = path.join(skillDir, "SKILL.md");
		try {
			fs.mkdirSync(skillDir, { recursive: true });
			fs.writeFileSync(skillPath, instantiated.content, "utf-8");
			await notifyCommandResult(ctx, `Created skill '${template.id}' at:\n${skillPath}\n\n${instantiated.content.slice(0, 200)}...`);
		} catch (error) {
			await notifyCommandResult(ctx, `Failed to write skill: ${error instanceof Error ? error.message : String(error)}`);
		}
	} });

	pi.registerCommand("team-help", { description: "Show pi-crew command help", handler: async (_args: string, ctx: ExtensionCommandContext) => {
		await notifyCommandResult(ctx, piTeamsHelp());
	} });

	// Brief mode command — toggle compact tool output display
	pi.registerCommand("crew-brief", {
		description: "Toggle brief tool output mode: on | off | status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
		// LAZY: defer dynamic import of ../../ui/tool-renderers/brief-mode.ts to its call site.
			const { isBrief, setBrief, BRIEF_ENTRY_TYPE, makeBriefEntry } = await import("../../ui/tool-renderers/brief-mode.ts");
			const trimmed = args.trim();

			if (trimmed === "on") {
				setBrief(true);
				pi.appendEntry(BRIEF_ENTRY_TYPE, { enabled: true });
				ctx.ui.notify("Brief mode: on — tool output will show compact summaries", "info");
				return;
			}
			if (trimmed === "off") {
				setBrief(false);
				pi.appendEntry(BRIEF_ENTRY_TYPE, { enabled: false });
				ctx.ui.notify("Brief mode: off — full tool output restored", "info");
				return;
			}
			// status (default)
			ctx.ui.notify(`Brief mode: ${isBrief() ? "on" : "off"}`, "info");
		},
	});

	time("register.commands");
	printTimings();
}
