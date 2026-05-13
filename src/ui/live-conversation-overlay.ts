/**
 * live-conversation-overlay.ts — Live conversation overlay for viewing live-session agent output.
 *
 * R8: Subscribes to session events for real-time streaming updates.
 * Falls back to polling LiveAgentHandle.activity when subscribe is unavailable.
 */
import type { LiveAgentHandle } from "../runtime/live-agent-manager.ts";
import { iconForStatus } from "./status-colors.ts";
import { SUBAGENT_SPINNER_FRAMES, spinnerFrame } from "./spinner.ts";
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
	private columns: number;
	private rows: number;
	private unsubscribe: (() => void) | undefined;

	constructor(
		private handle: LiveAgentHandle,
		private theme: CrewTheme,
		columns = 80,
		rows = 24,
	) {
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
						this.cachedLines.push(text);
						if (this.autoScroll) this.scrollOffset = Math.max(0, this.cachedLines.length - this.viewportHeight());
					}
				});
			} catch { /* ignore */ }
		}
		// Also poll for summary updates
		this.pollTimer = setInterval(() => {
			if (this.closed) return;
			this.frame++;
			this.refreshSummary();
		}, 200);
		this.refreshSummary();
	}

	private refreshSummary(): void {
		const act = this.handle.activity;
		const summary = `[${act.turnCount} turns · ${act.toolUses} tools · ${((act.completedAtMs ?? Date.now()) - act.startedAtMs) / 1000}s]`;
		const lastLine = this.cachedLines[this.cachedLines.length - 1];
		if (lastLine?.startsWith("[")) {
			this.cachedLines[this.cachedLines.length - 1] = summary;
		} else {
			this.cachedLines.push(summary);
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
		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));
		const row = (content: string) =>
			th.fg("border", "│") + " " + pad(content.slice(0, innerW), innerW) + " " + th.fg("border", "│");
		const hrTop = th.fg("border", `╭${"─".repeat(w - 2)}╮`);
		const hrBot = th.fg("border", `╰${"─".repeat(w - 2)}╯`);
		const hrMid = row(th.fg("dim", "─".repeat(innerW)));

		const lines: string[] = [];
		lines.push(hrTop);

		// Header
		const statusIcon = this.handle.status === "running"
			? th.fg("accent", SUBAGENT_SPINNER_FRAMES[this.frame % SUBAGENT_SPINNER_FRAMES.length] ?? "●")
			: iconForStatus(this.handle.status);
		const name = this.handle.agent ?? this.handle.taskId;
		const act = this.handle.activity;
		const elapsed = `${((act.completedAtMs ?? Date.now()) - act.startedAtMs) / 1000}s`;
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
		} catch { /* ignore */ }
		if (act.compactionCount > 0) headerParts.push(th.fg("dim", `↻${act.compactionCount}`));
		// Model name
		if (this.handle.modelName) headerParts.push(th.fg("muted", this.handle.modelName));

		const desc = this.handle.description ?? this.handle.role ?? "";
		lines.push(row(`${statusIcon} ${th.fg("accent", name)}  ${th.fg("muted", desc)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`));
		lines.push(hrMid);

		// Content
		const vh = this.viewportHeight();
		const visible = this.cachedLines.slice(this.scrollOffset, this.scrollOffset + vh);
		for (const line of visible) {
			lines.push(row(th.fg("dim", line)));
		}

		// Footer
		lines.push(hrMid);
		const footerText = this.autoScroll ? "auto-scroll · esc/q close" : `line ${this.scrollOffset + 1}/${this.cachedLines.length} · ↑/k ↓/j G/g · esc/q close`;
		lines.push(row(th.fg("dim", footerText)));
		lines.push(hrBot);
		return lines;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
	}

	dispose(): void {
		this.close();
	}
}
