/**
 * agent-pane.ts — full-width transcript pane for a single agent.
 *
 * Registered as widget key `pi-crew-agent-view` with `placement: "aboveEditor"`,
 * so it lives inside pi's document and pi handles layout — the same reason
 * pi-subtask migrated away from an overlay (overlays are positioned against
 * the viewport and bury the editor on tall terminals).
 *
 * Items render through pi's own transcript components (UserMessageComponent,
 * ToolExecutionComponent, Markdown) so the pane has visual parity with the
 * main conversation: real tool cards, markdown rendering, diffs. Components
 * are cached in a WeakMap keyed on the transcript item and dropped on theme
 * change or when a tool item gains its result.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	DynamicBorder,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

import { loadRunManifestById } from "../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";
import { type CrewTranscriptItem, readAgentTranscript, resetAgentTranscriptCursor } from "./agent-transcript.ts";
import { getViewedAgent, subscribePanelChange } from "./panel-store.ts";

const MAX_BODY_FRACTION = 14;
/** Minimum gap between disk re-reads while the pane is open (transcript-viewer parity). */
const TRANSCRIPT_READ_THROTTLE_MS = 500;
/** Re-check the manifest/tasks every this often so the header's status/model
 *  stay current without a disk read on every host tick. */
const MANIFEST_REFRESH_MS = 1500;
/** Terminal task statuses — after these the header shows the full-session hint. */
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

function formatTokenCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** pi-style per-turn usage footer: ↑in ↓out Rcache $cost (pi-subtask parity). */
function usageFooterLine(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } }): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokenCount(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokenCount(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
	const promptTokens = usage.input + usage.cacheRead;
	if (usage.cacheRead && promptTokens > 0) {
		parts.push(`CH${((usage.cacheRead / promptTokens) * 100).toFixed(1)}%`);
	}
	if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
	return parts.join(" ");
}

interface Renderable {
	render(width: number): string[];
}

/**
 * The pane is a window onto the run, never its owner: closing it must not
 * touch worker state. `dispose()` detaches only.
 */
export class CrewAgentPane {
	private disposed = false;
	/** Wrapped-line offset from the END of the transcript; 0 = tailing. */
	scrollBack = 0;
	private tui: TUI;
	private theme: CrewTheme;
	private cwd: string;
	/** Current agent target, read fresh from the panel store each render. */
	private currentTaskId: string | undefined;
	/** Cached manifest for the current run, to avoid re-reading on every tick. */
	private cachedRunId: string | undefined;
	private cachedManifest: TeamRunManifest | undefined;
	/** Tasks for the cached run (header shows the agent's real name/status). */
	private cachedTasks: TeamTaskState[] = [];
	/** Last time the manifest was re-read for header freshness. */
	private lastManifestRefreshAt = 0;

	private componentCache = new WeakMap<CrewTranscriptItem, Renderable>();
	/** Last disk read, so the open pane does not re-parse the JSONL every tick. */
	private lastTranscriptReadAt = 0;
	/** Most recent parsed items; kept alive because componentCache holds weak refs to them. */
	private lastItems: CrewTranscriptItem[] = [];
	/**
	 * Rendered-body cache. Rebuilding the pane re-parses every Markdown item,
	 * which on a 500-item transcript is the bulk of each ~160ms host tick.
	 * The fingerprint covers identity-relevant bits (seq, type, text length,
	 * result presence) so tool-result folds still refresh the pane.
	 */
	private bodyKey = 0;
	private cachedBody: string[] = [];
	private unsubscribePanel: () => void;

	constructor(tui: TUI, theme: Theme, cwd: string) {
		this.tui = tui;
		this.theme = asCrewTheme(theme);
		this.cwd = cwd;
		// Pane open/close/switch is a panel-store change; repaint immediately
		// instead of waiting for the next host tick, so the overlay swap is
		// instant even when the underlying run state is idle.
		this.unsubscribePanel = subscribePanelChange(() => {
			if (!this.disposed) this.tui.requestRender();
		});
	}

	requestRender(): void {
		if (!this.disposed) this.tui.requestRender();
	}

	scrollBy(delta: number): void {
		this.scrollBack = Math.max(0, this.scrollBack + delta);
		this.tui.requestRender();
	}

	private resolveManifest(runId: string): TeamRunManifest | undefined {
		const stale = Date.now() - this.lastManifestRefreshAt >= MANIFEST_REFRESH_MS;
		if (this.cachedRunId === runId && this.cachedManifest) {
			if (stale) {
				this.lastManifestRefreshAt = Date.now();
				const refreshed = loadRunManifestById(this.cwd, runId);
				if (refreshed) {
					this.cachedManifest = refreshed.manifest;
					this.cachedTasks = refreshed.tasks ?? [];
				}
			}
			return this.cachedManifest;
		}
		const loaded = loadRunManifestById(this.cwd, runId);
		if (!loaded) return undefined;
		this.cachedRunId = runId;
		this.cachedManifest = loaded.manifest;
		this.cachedTasks = loaded.tasks ?? [];
		this.lastManifestRefreshAt = Date.now();
		return loaded.manifest;
	}

	private itemComponent(item: CrewTranscriptItem): Renderable {
		const cached = this.componentCache.get(item);
		if (cached) return cached;

		let comp: Renderable;
		if (item.type === "user") {
			comp = new UserMessageComponent(item.text);
		} else if (item.type === "assistant") {
			// Full-message parity with a real pi session: pi's own assistant
			// component renders text, thinking blocks, and tool calls from the
			// compacted message. Falls back to markdown for old event logs
			// that predate message retention.
			comp = item.message
				? new AssistantMessageComponent(item.message as unknown as AssistantMessage)
				: new Markdown(item.text.trim(), 0, 0, getMarkdownTheme());
		} else if (item.type === "system") {
			// System lines are plain text — no component needed.
			comp = {
				render: () => [this.theme.fg("dim", truncateToWidth(item.text, 200, "…"))],
			};
		} else {
			// Tool item: use pi's own ToolExecutionComponent for visual parity.
			const tool = new ToolExecutionComponent(item.name, item.toolCallId, item.args, {}, undefined, this.tui, this.cwd);
			tool.markExecutionStarted();
			if (item.result !== undefined) {
				tool.updateResult(item.result as never);
			}
			comp = tool;
		}

		this.componentCache.set(item, comp);
		return comp;
	}

	/**
	 * Render one transcript item to lines, degrading to a dim text line when
	 * the item's shape confuses a pi component (the JSONL is worker-written
	 * and unvalidated — a once-bad record must never kill the pane render).
	 */
	private renderItem(item: CrewTranscriptItem, width: number): string[] {
		try {
			return this.itemComponent(item).render(width);
		} catch {
			const label = item.type === "tool" ? item.name : "text";
			return [this.theme.fg("dim", truncateToWidth(`(unrenderable ${label} item)`, width, "…"))];
		}
	}

	/** FNV-1a over the parts that change pane output; 32-bit is plenty for a
	 * 500-item cache key (a collision only delays a repaint by one tick). */
	private bodyFingerprint(items: readonly CrewTranscriptItem[], width: number): number {
		let h = (2166136261 ^ width) >>> 0;
		for (const item of items) {
			h ^= item.seq;
			h = Math.imul(h, 16777619) >>> 0;
			h ^= item.type.length;
			h = Math.imul(h, 16777619) >>> 0;
			if (item.type === "tool") {
				h ^= item.result !== undefined ? 7 : 3;
			} else {
				h ^= item.text.length;
			}
			h = Math.imul(h, 16777619) >>> 0;
		}
		return h;
	}

	private buildBody(items: readonly CrewTranscriptItem[], width: number): string[] {
		const body: string[] = [];
		for (const item of items) {
			for (const line of this.renderItem(item, width)) body.push(line);
			if (item.type === "assistant" && item.usage) {
				// pi's session transcript prints a usage footer under each
				// assistant message; mirror it so the pane reads like one.
				const footer = usageFooterLine(item.usage);
				if (footer) body.push(this.theme.fg("dim", footer));
			}
		}
		return body;
	}

	/** Session-style header: agent name · task · run · model · state. */
	private headerLines(manifest: TeamRunManifest, width: number): string[] {
		const t = this.theme;
		const task = this.cachedTasks.find((candidate) => candidate.id === this.currentTaskId);
		const name = task?.displayName ?? task?.title ?? this.currentTaskId ?? "agent";
		const model = manifest.modelContext?.parentModel ?? manifest.modelContext?.override;
		const parts: string[] = [
			t.fg("accent", t.bold(name)),
			t.fg("dim", `· ${this.currentTaskId ?? ""}`),
			t.fg("dim", `· …${manifest.runId.slice(-12)}`),
		];
		if (model) parts.push(t.fg("dim", `· ${model}`));

		const status = task?.status ?? manifest.status;
		let stateText = "";
		if (status === "completed") stateText = t.fg("success", "✓ completed");
		else if (status === "failed") stateText = t.fg("error", "✗ failed");
		else if (status === "cancelled") stateText = t.fg("warning", "■ cancelled");
		else if (status === "running") stateText = t.fg("success", "● running");
		else if (status) stateText = t.fg("dim", status);
		const line = truncateToWidth(`${parts.join(" ")}${stateText ? `   ${stateText}` : ""}`, width, "…");
		const lines = [line];
		if (task && TERMINAL_TASK_STATUSES.has(task.status)) {
			lines.push(t.fg("dim", truncateToWidth(`· finished — full log: /team-dashboard or artifacts/${manifest.runId}`, width, "…")));
		}
		return lines;
	}

	render(width: number): string[] {
		if (this.disposed) return [];

		const viewed = getViewedAgent();
		if (!viewed) return [];

		// Detect agent switch: reset the transcript cursor so the pane shows
		// the new agent's full history instead of continuing from the old cursor.
		if (this.currentTaskId !== viewed.taskId) {
			resetAgentTranscriptCursor(viewed.taskId);
			this.currentTaskId = viewed.taskId;
			this.scrollBack = 0;
			this.lastItems = [];
			this.lastTranscriptReadAt = 0;
			this.bodyKey = 0;
			this.cachedBody = [];
		}

		const manifest = this.resolveManifest(viewed.runId);
		if (!manifest) return [this.theme.fg("dim", "(run manifest unavailable)")];

		// Throttled disk read: the host repaints on its own ~160ms cadence, but
		// the JSONL only advances when the worker does something.
		if (Date.now() - this.lastTranscriptReadAt >= TRANSCRIPT_READ_THROTTLE_MS) {
			this.lastItems = readAgentTranscript(manifest, viewed.taskId);
			this.lastTranscriptReadAt = Date.now();
		}
		const items = this.lastItems;

		// Render every item at full width — pi's message components paint their
		// own edge-to-edge background and carry their own padding, so indenting
		// them leaves column 0 unpainted and notches the corners. The body is
		// cached under a content fingerprint; unchanged state skips the
		// Markdown re-parse on every host tick.
		const fingerprint = this.bodyFingerprint(items, width);
		if (fingerprint !== this.bodyKey) {
			this.cachedBody = this.buildBody(items, width);
			this.bodyKey = fingerprint;
		}
		const body = this.cachedBody;

		// Height: size to content, capped so the transcript above and the
		// editor/footer below stay reachable on small terminals.
		const header = this.headerLines(manifest, width);
		const rows = this.tui.terminal.rows;
		const maxBody = Math.max(6, rows - MAX_BODY_FRACTION - header.length);
		const visibleCount = Math.min(maxBody, Math.max(1, body.length));
		this.scrollBack = Math.max(0, Math.min(this.scrollBack, Math.max(0, body.length - visibleCount)));
		const end = body.length - this.scrollBack;
		const visible = body.slice(Math.max(0, end - visibleCount), end);

		const lines: string[] = [];
		// Session-style header first, then the border, then the transcript.
		for (const line of header) lines.push(line);
		lines.push(...new DynamicBorder((str) => this.theme.fg("border", str)).render(width));
		if (end - visibleCount > 0) {
			lines.push(this.theme.fg("dim", ` ↑ ${Math.max(0, end - visibleCount)} more line(s) (pageUp)`));
		} else {
			lines.push("");
		}
		for (const line of visible) lines.push(line);
		if (this.scrollBack > 0) {
			lines.push(this.theme.fg("dim", ` ↓ ${this.scrollBack} more line(s) (pageDown)`));
		}
		return lines;
	}

	invalidate(): void {
		// Components cache theme colors internally; rebuild on theme change.
		this.componentCache = new WeakMap();
		this.bodyKey = 0;
		this.cachedBody = [];
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribePanel();
		this.cachedManifest = undefined;
		this.cachedRunId = undefined;
	}
}
