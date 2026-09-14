import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { loadConfig } from "../../config/config.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import { listLiveAgents } from "../../runtime/live-session/live-agent-manager.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import { AgentsJobsBrowser } from "../../ui/agents-jobs-browser.ts";
import { LiveConversationOverlay } from "../../ui/live-conversation-overlay.ts";
import { requestRenderTarget } from "../../ui/pi-ui-compat.ts";
import { asCrewTheme } from "../../ui/theme-adapter.ts";
// Lazy-loaded: DurableTranscriptViewer is 658ms — only needed for /crew transcript command
import type { DurableTranscriptViewer as DurableTranscriptViewerType } from "../../ui/transcript-viewer.ts";

async function getViewer(): Promise<typeof DurableTranscriptViewerType> {
	// LAZY: DurableTranscriptViewer is 658ms — only needed for /crew transcript.
	const mod = await import("../../ui/transcript-viewer.ts");
	return mod.DurableTranscriptViewer;
}

export async function selectAgentTask(
	ctx: ExtensionCommandContext,
	runId: string | undefined,
	taskId?: string,
): Promise<{ runId: string; taskId?: string } | undefined> {
	if (!runId) return undefined;
	if (taskId) return { runId, taskId };
	const loaded = loadRunManifestById(ctx.cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return { runId };
	const agents = readCrewAgents(loaded.manifest);
	if (ctx.hasUI && agents.length > 1) {
		const choice = await ctx.ui.select(
			"Select pi-crew agent",
			agents.map((agent) => `${agent.taskId} ${agent.role}→${agent.agent} [${agent.status}]`),
		);
		return { runId, taskId: choice?.split(" ")[0] };
	}
	return { runId, taskId: agents[0]?.taskId };
}

export async function openTranscriptViewer(
	ctx: ExtensionCommandContext,
	initialRunId: string | undefined,
	initialTaskId?: string,
): Promise<boolean> {
	const selected = await selectAgentTask(ctx, initialRunId, initialTaskId);
	if (!selected) return false;
	const runId = selected.runId;
	const taskId = selected.taskId;
	if (!runId || !ctx.hasUI) return false;
	const loaded = loadRunManifestById(ctx.cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return false;
	const uiConfig = loadConfig(ctx.cwd).config.ui;
	const DurableTranscriptViewer = await getViewer();
	await ctx.ui.custom<undefined>(
		(_tui, theme, _keybindings, done) =>
			new DurableTranscriptViewer(loaded.manifest, theme, done, taskId, {
				maxTailBytes: uiConfig?.transcriptTailBytes,
			}),
		{
			overlay: true,
			overlayOptions: {
				width: "90%",
				maxHeight: "85%",
				anchor: "center",
			},
		},
	);
	return true;
}

/** R2: Open live conversation overlay for a running live-session agent. */
export async function openLiveConversation(
	ctx: ExtensionCommandContext,
	initialRunId: string | undefined,
	initialTaskId?: string,
): Promise<boolean> {
	const selected = await selectAgentTask(ctx, initialRunId, initialTaskId);
	if (!selected || !ctx.hasUI) return false;
	const liveAgents = listLiveAgents();
	const handle = liveAgents.find((h) => h.runId === selected.runId && (selected.taskId ? h.taskId === selected.taskId : true));
	if (!handle) return false;
	const theme = asCrewTheme({});
	await ctx.ui.custom<undefined>(
		(tui, _theme, _keybindings, done) => {
			const columns = tui?.terminal?.columns ?? 80;
			const rows = tui?.terminal?.rows ?? 24;
			const overlay = new LiveConversationOverlay(handle, theme, columns, rows);
			return {
				render(width: number) {
					return overlay.render(width);
				},
				handleInput(data: string) {
					if (matchesKey(data, "escape") || matchesKey(data, "q")) {
						overlay.close();
						done(undefined);
					}
				},
				invalidate() {
					/* overlay polls */
				},
				dispose() {
					overlay.dispose();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "90%",
				maxHeight: "85%",
				anchor: "center",
			},
		},
	);
	return true;
}

/**
 * feat/agents-browser: open the unified Agents & Jobs browser overlay.
 *
 * Full-view component (the SAME custom() precedent as openLiveConversation —
 * pi's overlay-anchor option was evaluated and set aside: overlays float over
 * chat with different key routing; the modal form matches every existing
 * pi-crew viewer, so users get one consistent interaction model). Opened from the run
 * dashboard with ONE keypress (`b`); lists ALL live agents + scheduled jobs
 * via the G17 providers — independent of any single run. Headless sessions
 * (`ctx.hasUI === false`) are a silent no-op returning false.
 */
export async function openAgentsJobsBrowser(
	ctx: Pick<ExtensionCommandContext, "hasUI" | "cwd" | "ui" | "sessionManager">,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const theme = asCrewTheme({});
	const workspaceId = ctx.sessionManager?.getSessionId?.();
	await ctx.ui.custom<undefined>(
		(tui, _theme, _keybindings, done) => {
			const columns = tui?.terminal?.columns ?? 80;
			const rows = tui?.terminal?.rows ?? 24;
			const browser = new AgentsJobsBrowser({
				cwd: ctx.cwd,
				workspaceId,
				theme,
				columns,
				rows,
				requestRender: () => requestRenderTarget(tui),
			});
			return {
				render(width: number) {
					return browser.render(width);
				},
				handleInput(data: string) {
					browser.handleInput(data);
					if (browser.isClosed) done(undefined);
				},
				invalidate() {
					browser.refreshData(true);
				},
				dispose() {
					browser.dispose();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "92%",
				maxHeight: "70%",
				anchor: "bottom-center",
				margin: 0,
			},
		},
	);
	return true;
}
