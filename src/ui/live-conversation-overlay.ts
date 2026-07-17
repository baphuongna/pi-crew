/**
 * live-conversation-overlay.ts — Live conversation overlay for viewing live-session agent output.
 *
 * R8: Subscribes to session events for real-time streaming updates.
 * Falls back to polling LiveAgentHandle.activity when subscribe is unavailable.
 */
import type { LiveAgentHandle } from "../runtime/live-agent-manager.ts";
import { pad, truncate } from "../utils/visual.ts";
import { computeLiveDurationMs } from "./live-duration.ts";
import { spinnerFrame } from "./spinner.ts";
import { iconForStatus } from "./status-colors.ts";
import type { CrewTheme } from "./theme-adapter.ts";

const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;

export class LiveConversationOverlay {
	private scrollOffset = 0;
	private autoScroll = true;
	private closed = false;
	private frame = 0;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	cachedLines: string[] = [];
	// H-4 fix (code-review 2026-06-23): cap the in-memory line buffer to avoid
	// unbounded growth (OOM) during long-running live sessions. Oldest lines are
	// dropped first; scrollOffset is adjusted to keep the viewport stable.
	static readonly MAX_CACHED_LINES = 5000;
	private columns: number;
	private rows: number;
	private unsubscribe: (() => void) | undefined;

	private handle: LiveAgentHandle;
	private theme: CrewTheme;

	constructor(handle: LiveAgentHandle, theme: CrewTheme, columns = 80, rows = 24) {
		this.handle = handle;
		this.theme = theme;
		this.columns = columns;
		this.rows = rows;
		// R8: Subscribe to real session events if available
		const session = handle.session as Record<string, unknown>;
		if (typeof session.subscribe === "function") {
			try {
				this.unsubscribe = (session.subscribe as (cb: (event: unknown) => void) => () => void)((event) => {
					if (this.closed) return;
					const obj = event as Record<string, unknown>;
					const text = typeof obj.text === "string" ? obj.text : typeof obj.content === "string" ? obj.content : "";
					if (text.trim()) {
						this.pushLine(text);
						if (this.autoScroll) this.scrollOffset = Math.max(0, this.cachedLines.length - this.viewportHeight());
					}
				});
			} catch {
				/* ignore */
			}
		}
		// Also poll for summary updates
		this.pollTimer = setInterval(() => {
			if (this.closed) return;
			this.frame++;
			try {
				this.refreshSummary();
			} catch {
				/* ignore */
			}
		}, 200);
		this.pollTimer.unref();
		try {
			this.refreshSummary();
		} catch {
			/* ignore */
		}
	}

	private pushLine(line: string): void {
		this.cachedLines.push(line);
		if (this.cachedLines.length > LiveConversationOverlay.MAX_CACHED_LINES) {
			const drop = this.cachedLines.length - LiveConversationOverlay.MAX_CACHED_LINES;
			this.cachedLines.splice(0, drop);
			this.scrollOffset = Math.max(0, this.scrollOffset - drop);
		}
	}

	private static readonly SUMMARY_PREFIX = "\u200B"; // zero-width space as summary sentinel

	private refreshSummary(): void {
		const act = this.handle.activity;
		const summary = `${LiveConversationOverlay.SUMMARY_PREFIX}[${act.turnCount} turns · ${act.toolUses} tools · ${(computeLiveDurationMs(act) / 1000).toFixed(1)}s]`;
		const lastLine = this.cachedLines[this.cachedLines.length - 1];
		if (lastLine?.startsWith(LiveConversationOverlay.SUMMARY_PREFIX)) {
			this.cachedLines[this.cachedLines.length - 1] = summary;
		} else {
			this.pushLine(summary);
		}
		if (this.autoScroll) this.scrollOffset = Math.max(0, this.cachedLines.length - this.viewportHeight());
	}

	private viewportHeight(): number {
		return Math.max(MIN_VIEWPORT, this.rows - CHROME_LINES);
	}

	render(width?: number): string[] {
		const w = width ?? this.columns;
		if (w < 6) return [];
		const th = this.theme;
		const innerW = w - 4;
		const row = (content: string) => th.fg("border", "│") + " " + pad(truncate(content, innerW), innerW) + " " + th.fg("border", "│");
		const hrTop = th.fg("border", `╭${"─".repeat(w - 2)}╮`);
		const hrBot = th.fg("border", `╰${"─".repeat(w - 2)}╯`);
		const hrMid = row(th.fg("dim", "─".repeat(innerW)));

		const lines: string[] = [];
		lines.push(hrTop);

		// Header
		const statusIcon =
			this.handle.status === "running"
				? th.fg("accent", spinnerFrame(this.handle.taskId ?? this.handle.agentId))
				: iconForStatus(this.handle.status);
		const name = this.handle.agent ?? this.handle.taskId;
		const act = this.handle.activity;
		const elapsed = `${(computeLiveDurationMs(act) / 1000).toFixed(1)}s`;
		const headerParts: string[] = [];
		if (act.maxTurns != null) headerParts.push(`turn ${act.turnCount}/${act.maxTurns}`);
		else if (act.turnCount > 0) headerParts.push(`turn ${act.turnCount}`);
		if (act.toolUses > 0) headerParts.push(`${act.toolUses} tools`);
		headerParts.push(elapsed);

		// Context % + compaction
		try {
			const ctxPct = this.handle.session.getSessionStats?.()?.contextUsage?.percent;
			if (ctxPct != null) {
				const color = ctxPct >= 85 ? "error" : ctxPct >= 70 ? "warning" : "dim";
				headerParts.push(th.fg(color, `${Math.round(ctxPct)}% ctx`));
			}
		} catch {
			/* ignore */
		}
		if (act.compactionCount > 0) headerParts.push(th.fg("dim", `↻${act.compactionCount}`));
		// Model name
		if (this.handle.modelName) headerParts.push(th.fg("muted", this.handle.modelName));

		const desc = this.handle.description ?? this.handle.role ?? "";
		lines.push(
			row(
				`${statusIcon} ${th.fg("accent", name)}  ${th.fg("muted", desc)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`,
			),
		);
		lines.push(hrMid);

		// Content
		const vh = this.viewportHeight();
		const visible = this.cachedLines.slice(this.scrollOffset, this.scrollOffset + vh);
		for (const line of visible) {
			lines.push(row(th.fg("dim", line)));
		}

		// Footer
		lines.push(hrMid);
		const footerText = this.autoScroll
			? "auto-scroll · esc/q close"
			: `line ${this.scrollOffset + 1}/${this.cachedLines.length} · ↑/k ↓/j G/g · esc/q close`;
		lines.push(row(th.fg("dim", footerText)));
		lines.push(hrBot);
		return lines;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	dispose(): void {
		this.close();
	}
}
