import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { handleTeamTool } from "../team-tool.ts";
import { piTeamsHelp } from "../help.ts";
import { handleTeamManagerCommand } from "../team-manager-command.ts";
import { loadRunManifestById } from "../../state/state-store.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import { AnimatedMascot } from "../../ui/mascot.ts";
import * as path from "node:path";
import { RunDashboard, type RunDashboardSelection } from "../../ui/run-dashboard.ts";
import { DurableTextViewer } from "../../ui/transcript-viewer.ts";
import { ConfirmOverlay, type ConfirmOptions } from "../../ui/overlays/confirm-overlay.ts";
import { MailboxDetailOverlay, type MailboxAction } from "../../ui/overlays/mailbox-detail-overlay.ts";
import { MailboxComposeOverlay, type MailboxComposeResult } from "../../ui/overlays/mailbox-compose-overlay.ts";
import { AgentPickerOverlay } from "../../ui/overlays/agent-picker-overlay.ts";
import { dispatchDiagnosticExport, dispatchHealthRecovery, dispatchKillStaleWorkers, dispatchMailboxAck, dispatchMailboxAckAll, dispatchMailboxCompose, dispatchMailboxNudge } from "../../ui/run-action-dispatcher.ts";
import { listRecentDiagnostic } from "../../runtime/diagnostic-export.ts";
import { commandText, notifyCommandResult, parseRunArgs, parseScalar, pushUnset, setNestedConfig } from "./command-utils.ts";
import { openTranscriptViewer, selectAgentTask } from "./viewers.ts";
import { printTimings, time } from "../../utils/timings.ts";
import { requestRenderTarget } from "../../ui/pi-ui-compat.ts";
import type { createRunSnapshotCache } from "../../ui/run-snapshot-cache.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";

export interface RegisterTeamCommandsDeps {
	startForegroundRun: (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	openLiveSidebar: (ctx: ExtensionContext, runId: string) => void;
	getManifestCache: (cwd: string) => { list(max?: number): TeamRunManifest[] };
	getRunSnapshotCache?: (cwd: string) => ReturnType<typeof createRunSnapshotCache>;
	getMetricRegistry?: () => MetricRegistry | undefined;
	dismissNotifications?: () => void;
}

async function openConfirm(ctx: ExtensionCommandContext, options: ConfirmOptions): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return await ctx.ui.custom<boolean>((_tui, theme, _keybindings, done) => new ConfirmOverlay(options, done, theme), { overlay: true, overlayOptions: { width: 64, maxHeight: "70%", anchor: "center" } });
}

async function handleMailboxDashboardAction(ctx: ExtensionCommandContext, runId: string): Promise<void> {
	if (!ctx.hasUI) return;
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
		const compose = await ctx.ui.custom<MailboxComposeResult>((_tui, theme, _keybindings, done) => new MailboxComposeOverlay({ done, theme }), { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
		if (compose.type === "cancel") return;
		const result = await dispatchMailboxCompose(ctx as ExtensionContext, runId, compose.payload);
		ok = result.ok;
		resultMessage = result.message;
	} else if (action.type === "nudge") {
		let agentId = action.agentId;
		if (!agentId) {
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

async function handleHealthDashboardAction(ctx: ExtensionCommandContext, selection: RunDashboardSelection): Promise<void> {
	const loaded = loadRunManifestById(ctx.cwd, selection.runId);
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
			const result = await handleTeamTool({ action: "list" }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-run", {
		description: "Manually start a pi-crew run (agent may also use the team tool autonomously)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool(parseRunArgs(args), { ...ctx, metricRegistry: deps.getMetricRegistry?.(), startForegroundRun: (runner, runId) => deps.startForegroundRun(ctx as ExtensionContext, runner, runId), onRunStarted: (runId) => deps.openLiveSidebar(ctx as ExtensionContext, runId) });
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
		pi.registerCommand(name, { description, handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			const result = await handleTeamTool({ action, runId }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		} });
	}

	pi.registerCommand("team-respond", {
		description: "Respond to a waiting pi-crew task: <runId> <taskId|--all> <message>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.shift();
			const taskToken = tokens[0] === "--all" ? tokens.shift() : tokens.shift();
			const taskId = taskToken === "--all" ? undefined : taskToken;
			const message = tokens.join(" ") || undefined;
			const result = await handleTeamTool({ action: "respond", runId, taskId, message }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-api", {
		description: "Run safe pi-crew API interop operations: <runId> <operation> [key=value]",
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
			const result = await handleTeamTool({ action: "api", runId, config }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-metrics", { description: "Show pi-crew metrics snapshot: [filter]", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const filter = args.trim() || undefined;
		const result = await handleTeamTool({ action: "api", config: { operation: "metrics-snapshot", filter } }, { ...ctx, metricRegistry: deps.getMetricRegistry?.() });
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-imports", { description: "List imported pi-crew run bundles", handler: async (_args: string, ctx: ExtensionCommandContext) => {
		const result = await handleTeamTool({ action: "imports" }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-import", { description: "Import a pi-crew run-export.json bundle into local imports", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const pathArg = tokens.find((token) => !token.startsWith("--"));
		const scope = tokens.includes("--user") ? "user" : "project";
		const result = await handleTeamTool({ action: "import", config: { path: pathArg, scope } }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-prune", { description: "Prune old finished pi-crew runs, keeping the newest N", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const keepToken = tokens.find((token) => token.startsWith("--keep="));
		const keep = keepToken ? Number.parseInt(keepToken.slice("--keep=".length), 10) : undefined;
		const result = await handleTeamTool({ action: "prune", keep, confirm: tokens.includes("--confirm") }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-forget", { description: "Forget a pi-crew run by deleting its state and artifacts", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const runId = tokens.find((token) => !token.startsWith("--"));
		const result = await handleTeamTool({ action: "forget", runId, force: tokens.includes("--force"), confirm: tokens.includes("--confirm") }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-settings", {
		description: "View or update pi-crew settings: [list|get <key>|set <key> <value>|unset <key>|path|scope]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "settings", config: { args: args.trim() } }, ctx);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-cleanup", { description: "Open a simple pi-crew interactive manager", handler: handleTeamManagerCommand });

	pi.registerCommand("team-result", { description: "Open a pi-crew agent result viewer: <runId> [taskId]", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const [runId, rawTaskId] = args.trim().split(/\s+/).filter(Boolean);
		const selected = await selectAgentTask(ctx, runId, rawTaskId);
		const loaded = selected ? loadRunManifestById(ctx.cwd, selected.runId) : undefined;
		if (ctx.hasUI && loaded) {
			const agent = readCrewAgents(loaded.manifest).find((item) => item.taskId === selected?.taskId || item.id === selected?.taskId) ?? readCrewAgents(loaded.manifest)[0];
			const resultText = agent?.resultArtifactPath ? commandText(await handleTeamTool({ action: "api", runId: selected?.runId ?? "", config: { operation: "read-agent-output", agentId: agent.taskId, maxBytes: 64_000 } }, ctx)) : "(no result)";
			await ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) => new DurableTextViewer("pi-crew result", `${selected?.runId ?? ""}:${agent?.taskId ?? "unknown"}`, resultText.split(/\r?\n/), theme, done), { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
			return;
		}
		const result = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-output", agentId: rawTaskId, maxBytes: 64_000 } }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-transcript", { description: "Open a pi-crew transcript viewer: <runId> [taskId]", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const [runId, taskId] = args.trim().split(/\s+/).filter(Boolean);
		if (await openTranscriptViewer(ctx, runId, taskId)) return;
		const result = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-transcript", agentId: taskId } }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-dashboard", { description: "Open a pi-crew run dashboard overlay", handler: async (_args: string, ctx: ExtensionCommandContext) => {
		for (;;) {
			const runs = deps.getManifestCache(ctx.cwd).list(50);
			const uiConfig = loadConfig(ctx.cwd).config.ui;
			const rightPanel = uiConfig?.dashboardPlacement !== "center";
			const width = rightPanel ? Math.min(90, Math.max(40, uiConfig?.dashboardWidth ?? 56)) : "90%";
			const selection = await ctx.ui.custom<RunDashboardSelection | undefined>((_tui, theme, _keybindings, done) => new RunDashboard(runs, done, theme, { placement: rightPanel ? "right" : "center", showModel: uiConfig?.showModel, showTokens: uiConfig?.showTokens, showTools: uiConfig?.showTools, snapshotCache: deps.getRunSnapshotCache?.(ctx.cwd), runProvider: () => deps.getManifestCache(ctx.cwd).list(50), registry: deps.getMetricRegistry?.() }), { overlay: true, overlayOptions: rightPanel ? { width, minWidth: 40, maxHeight: "100%", anchor: "top-right", offsetX: 0, offsetY: 0, margin: { top: 0, right: 0, bottom: 0, left: 0 } } : { width, maxHeight: "90%", anchor: "center", margin: 2 } });
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
			const result = selection.action === "api" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-manifest" } }, ctx) : selection.action === "agents" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "agent-dashboard" } }, ctx) : selection.action === "mailbox" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-mailbox" } }, ctx) : selection.action === "agent-events" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-agent-events", limit: 50 } }, ctx) : selection.action === "agent-output" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-agent-output", maxBytes: 32_000 } }, ctx) : selection.action === "agent-transcript" ? await handleTeamTool({ action: "api", runId: selection.runId, config: { operation: "read-agent-transcript" } }, ctx) : await handleTeamTool({ action: selection.action, runId: selection.runId }, ctx);
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
		const style = (styleArg as "cat" | "armin" | undefined) ?? uiConfig?.mascotStyle ?? "cat";
		const effect = (effectArg as "random" | "none" | "typewriter" | "scanline" | "rain" | "fade" | "crt" | "glitch" | "dissolve" | undefined) ?? uiConfig?.mascotEffect ?? "random";
		await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new AnimatedMascot(theme, () => done(undefined), { frameIntervalMs: style === "armin" ? 33 : 180, autoCloseMs: 7000, requestRender: () => requestRenderTarget(tui), style, effect }), { overlay: true, overlayOptions: { width: style === "armin" ? 48 : 62, maxHeight: "85%", anchor: "center" } });
	} });

	pi.registerCommand("team-init", { description: "Initialize project-local pi-crew directories and gitignore entries", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const result = await handleTeamTool({ action: "init", config: { copyBuiltins: tokens.includes("--copy-builtins"), overwrite: tokens.includes("--overwrite") } }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-autonomy", { description: "Show or toggle pi-crew autonomous delegation policy: status|on|off", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const mode = tokens[0]?.toLowerCase();
		const config = mode === "on" ? { profile: "suggested", enabled: true, injectPolicy: true } : mode === "off" ? { profile: "manual", enabled: false } : mode === "manual" || mode === "suggested" || mode === "assisted" || mode === "aggressive" ? { profile: mode, enabled: mode !== "manual", injectPolicy: mode !== "manual" } : { preferAsyncForLongTasks: tokens.includes("--prefer-async") ? true : undefined, allowWorktreeSuggestion: tokens.includes("--no-worktree-suggest") ? false : undefined };
		const result = await handleTeamTool({ action: "autonomy", config }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-config", { description: "Show or update pi-crew config. Use key=value [--project] to update.", handler: async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) {
			const result = await handleTeamTool({ action: "config" }, ctx);
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
		const result = await handleTeamTool({ action: "config", config }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	for (const [name, action, description] of [
		["team-validate", "validate", "Validate pi-crew agents, teams, and workflows"],
		["team-doctor", "doctor", "Check pi-crew installation and discovery readiness"],
	] as const) pi.registerCommand(name, { description, handler: async (_args: string, ctx: ExtensionCommandContext) => {
		const result = await handleTeamTool({ action }, ctx);
		await notifyCommandResult(ctx, commandText(result));
	} });

	pi.registerCommand("team-help", { description: "Show pi-crew command help", handler: async (_args: string, ctx: ExtensionCommandContext) => {
		await notifyCommandResult(ctx, piTeamsHelp());
	} });
	time("register.commands");
	printTimings();
}
