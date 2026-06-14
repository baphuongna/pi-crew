import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadRunManifestById } from "../../state/state-store.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import { loadConfig } from "../../config/config.ts";
import { listLiveAgents } from "../../runtime/live-agent-manager.ts";
import { LiveConversationOverlay } from "../../ui/live-conversation-overlay.ts";
import { asCrewTheme } from "../../ui/theme-adapter.ts";
// Lazy-loaded: DurableTranscriptViewer is 658ms — only needed for /crew transcript command
import type { DurableTranscriptViewer as DurableTranscriptViewerType } from "../../ui/transcript-viewer.ts";
let _cachedViewer: typeof DurableTranscriptViewerType | undefined;
let _viewerPromise: Promise<typeof DurableTranscriptViewerType> | undefined;
async function getViewer(): Promise<typeof DurableTranscriptViewerType> {
	if (_cachedViewer) return _cachedViewer;
	if (!_viewerPromise) {
		_viewerPromise = import("../../ui/transcript-viewer.ts").then((mod) => {
			_cachedViewer = mod.DurableTranscriptViewer;
			return mod.DurableTranscriptViewer;
		});
	}
	return _viewerPromise;
}

export async function selectAgentTask(ctx: ExtensionCommandContext, runId: string | undefined, taskId?: string): Promise<{ runId: string; taskId?: string } | undefined> {
	if (!runId) return undefined;
	if (taskId) return { runId, taskId };
	const loaded = loadRunManifestById(ctx.cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return { runId };
	const agents = readCrewAgents(loaded.manifest);
	if (ctx.hasUI && agents.length > 1) {
		const choice = await ctx.ui.select("Select pi-crew agent", agents.map((agent) => `${agent.taskId} ${agent.role}→${agent.agent} [${agent.status}]`));
		return { runId, taskId: choice?.split(" ")[0] };
	}
	return { runId, taskId: agents[0]?.taskId };
}

export async function openTranscriptViewer(ctx: ExtensionCommandContext, initialRunId: string | undefined, initialTaskId?: string): Promise<boolean> {
	const selected = await selectAgentTask(ctx, initialRunId, initialTaskId);
	if (!selected) return false;
	const runId = selected.runId;
	const taskId = selected.taskId;
	if (!runId || !ctx.hasUI) return false;
	const loaded = loadRunManifestById(ctx.cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return false;
	const uiConfig = loadConfig(ctx.cwd).config.ui;
	const DurableTranscriptViewer = await getViewer();
	await ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) => new DurableTranscriptViewer(loaded.manifest, theme, done, taskId, { maxTailBytes: uiConfig?.transcriptTailBytes }), {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" },
	});
	return true;
}

/** R2: Open live conversation overlay for a running live-session agent. */
export async function openLiveConversation(ctx: ExtensionCommandContext, initialRunId: string | undefined, initialTaskId?: string): Promise<boolean> {
	const selected = await selectAgentTask(ctx, initialRunId, initialTaskId);
	if (!selected || !ctx.hasUI) return false;
	const liveAgents = listLiveAgents();
	const handle = liveAgents.find((h) => h.runId === selected.runId && (selected.taskId ? h.taskId === selected.taskId : true));
	if (!handle) return false;
	const theme = asCrewTheme({});
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	await ctx.ui.custom<undefined>((tui: any, _theme: any, _keybindings: any, done: (result: undefined) => void) => {
		const columns = tui?.terminal?.columns ?? 80;
		const rows = tui?.terminal?.rows ?? 24;
		const overlay = new LiveConversationOverlay(handle, theme, columns, rows);
		return {
			render(width: number) { return overlay.render(width); },
			handleInput(data: string) {
				if (data === "\x1b" || data === "q") { overlay.close(); done(undefined); }
			},
			invalidate() { /* overlay polls */ },
		};
	}, {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" },
	});
	return true;
}
