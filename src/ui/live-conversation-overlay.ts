/**
 * live-conversation-overlay.ts — Live conversation overlay for viewing live-session agent output.
 *
 * R8: Subscribes to session events for real-time streaming updates.
 * Falls back to polling LiveAgentHandle.activity when subscribe is unavailable.
 *
 * Frame (RAIL design language, M4/E1 2026-09-16):
 *
 *   ┏ LIVE ▸ explorer
 *   ┃ ◉ building feature · turn 2/10 · 3 tools · 5.1s · ▕██░░░░░░▏ 24% ctx · sonnet
 *   ┃ <streamed transcript rows…>
 *   ┗ ↑/↓/PgUp/PgDn/G scroll · A pause · Esc/Q close ···· auto-scroll
 *
 * The rounded box (`╭─╮│╰─╯` + its two `│ ──── │` rules) is retired: the canopy
 * opens the surface, every body row is a `┃` rail line, the `┗` close cap
 * carries the hint (`formatHint`, close LAST) on the left and the scroll STATE
 * (`auto-scroll` / `manual 12-30/31`) on the dot-led right segment, so the state
 * is never the part that gets truncated. Chrome therefore drops from 6 rows to 3
 * (canopy + meta + cap) and the viewport gains the three freed rows — keys,
 * scroll rules and clamping are unchanged.
 *
 * Keyboard (P1-3: the overlay captures focus while open — see
 * `handleInput` below for the full key set):
 *   esc / q                            close, back to the main conversation
 *   pgup / pgdn / ↑ ↓ / j k / g G      scroll the transcript
 *   a                                  toggle auto-scroll
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { LiveAgentHandle } from "../runtime/live-session/live-agent-manager.ts";
import { truncate } from "../utils/visual.ts";
import { formatCount } from "./format-helpers.ts";
import { computeLiveDurationMs } from "./live-duration.ts";
import { canopyLine, formatHint, gaugeBar, RAIL, railLeaders, railLine, statusSlot } from "./rail.ts";
import { spinnerFrame } from "./spinner.ts";
import { iconForStatus } from "./status-colors.ts";
import type { CrewTheme, CrewThemeColor } from "./theme-adapter.ts";

/** Chrome rows: canopy + meta row + close cap. Every other row is transcript. */
const CHROME_LINES = 3;
const MIN_VIEWPORT = 3;
/** Lines moved by one ↑/k or ↓/j press. */
const SCROLL_LINE_STEP = 1;
/** Lines moved by one PgUp/PgDn press (same page size as the agent view overlay). */
const SCROLL_PAGE_STEP = 10;
/** Bar width of the `% ctx` gauge in the meta row. */
const CTX_GAUGE_WIDTH = 8;

export class LiveConversationOverlay {
	private scrollOffset = 0;
	private autoScroll = true;
	private closed = false;
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
						if (this.autoScroll) this.scrollOffset = this.maxScrollOffset();
					}
				});
			} catch {
				/* ignore */
			}
		}
		// Also poll for summary updates. Skip when the user has scrolled up
		// (autoScroll === false): the summary refresh also bumps scrollOffset
		// to the tail, which would yank the viewport out from under them.
		this.pollTimer = setInterval(() => {
			if (this.closed) return;
			if (!this.autoScroll) return;
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
		const summary = `${LiveConversationOverlay.SUMMARY_PREFIX}[${formatCount(act.turnCount ?? 0, "turn")} · ${formatCount(act.toolUses ?? 0, "tool")} · ${(computeLiveDurationMs(act) / 1000).toFixed(1)}s]`;
		const lastLine = this.cachedLines[this.cachedLines.length - 1];
		if (lastLine?.startsWith(LiveConversationOverlay.SUMMARY_PREFIX)) {
			this.cachedLines[this.cachedLines.length - 1] = summary;
		} else {
			this.pushLine(summary);
		}
		if (this.autoScroll) this.scrollOffset = this.maxScrollOffset();
	}

	private viewportHeight(): number {
		return Math.max(MIN_VIEWPORT, this.rows - CHROME_LINES);
	}

	/** Largest offset that still shows the newest line in the viewport. */
	private maxScrollOffset(): number {
		return Math.max(0, this.cachedLines.length - this.viewportHeight());
	}

	/**
	 * autoScroll rule (M1-6):
	 *   - a manual scroll always recomputes autoScroll from the position — the
	 *     viewport tails the stream only while it sits at the newest line;
	 *   - scrolling DOWN to (or past) the newest line therefore restores
	 *     autoScroll, and scrolling UP away from it pauses it so incoming lines
	 *     cannot yank the viewport back;
	 *   - `a` toggles explicitly: turning it on jumps to the newest line,
	 *     turning it off pauses wherever the viewport currently is.
	 */
	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.maxScrollOffset(), this.scrollOffset + delta));
		this.autoScroll = this.scrollOffset >= this.maxScrollOffset();
	}

	/** Jump to the oldest buffered line. */
	private scrollHome(): void {
		this.scrollBy(-this.cachedLines.length);
	}

	/** Jump to the newest line (re-enables auto-scroll). */
	private scrollEnd(): void {
		this.scrollBy(this.cachedLines.length);
	}

	/** Toggle auto-scroll; turning it on jumps to the newest line. */
	private toggleAutoScroll(): void {
		if (this.autoScroll) this.autoScroll = false;
		else this.scrollEnd();
	}

	/**
	 * Handle a keypress while the overlay has focus. Mirrors the key set of
	 * src/ui/inline-panel/agent-view-overlay.ts:160-182:
	 *
	 *   esc / q            close the overlay
	 *   ↓ / j              scroll down one line
	 *   ↑ / k              scroll up one line
	 *   PgDn / PgUp        scroll one page
	 *   g (home)           jump to the oldest buffered line
	 *   G (end)            jump to the newest line (re-enables auto-scroll)
	 *   a                  toggle auto-scroll
	 *
	 * The host component in src/extension/registration/viewers.ts intercepts
	 * esc/q itself (it owns the `done()` callback) and forwards every other key
	 * here; the esc/q branch below keeps this class self-contained for direct
	 * callers and for the host contract. Unrecognised keys are ignored — the
	 * overlay never leaks keys into the editor underneath.
	 */
	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape") || data === "q") {
			this.close();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.scrollBy(SCROLL_LINE_STEP);
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.scrollBy(-SCROLL_LINE_STEP);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollBy(SCROLL_PAGE_STEP);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollBy(-SCROLL_PAGE_STEP);
			return;
		}
		if (matchesKey(data, "home") || data === "g") {
			this.scrollHome();
			return;
		}
		if (matchesKey(data, "end") || data === "G") {
			this.scrollEnd();
			return;
		}
		if (data === "a") {
			this.toggleAutoScroll();
		}
	}

	/** Left half of the close cap: the key legend, through `formatHint`. */
	private hintText(): string {
		return formatHint([
			[["up", "down", "pageup", "pagedown", "g", "G"], "scroll"],
			["a", this.autoScroll ? "pause" : "resume"],
			[["escape", "q"], "close"],
		]);
	}

	/**
	 * Right half of the close cap: the scroll STATE (dot-led so it can never be
	 * the segment that gets truncated). Every key advertised is handled by
	 * `handleInput` in BOTH states (P1-3: the old `↑/k ↓/j G/g` hint lived in an
	 * autoScroll === false branch that could never be reached, because nothing
	 * ever turned autoScroll off).
	 */
	private stateText(): string {
		if (this.autoScroll) return "auto-scroll";
		const total = this.cachedLines.length;
		const from = total === 0 ? 0 : this.scrollOffset + 1;
		const to = Math.min(total, this.scrollOffset + this.viewportHeight());
		return `manual ${from}-${to}/${total}`;
	}

	render(width?: number): string[] {
		const w = width ?? this.columns;
		if (w < 6) return [];
		const th = this.theme;
		const budget = w - 2;
		const act = this.handle.activity;
		const slot = statusSlot(this.handle.status);

		const lines: string[] = [];
		// Canopy: ┏ LIVE ▸ <agent> (every identity field guarded — the handle is
		// assembled at runtime and a missing name must never print `undefined`).
		lines.push(canopyLine({ word: "LIVE", subject: this.handle.agent ?? this.handle.taskId ?? "?", theme: th, budget }));

		// Meta row: status glyph, description, then the counters.
		const statusIcon =
			this.handle.status === "running"
				? th.fg("accent", spinnerFrame(this.handle.taskId ?? this.handle.agentId ?? ""))
				: iconForStatus(this.handle.status);
		const desc = this.handle.description ?? this.handle.role ?? "";
		const parts: string[] = [];
		if (act.maxTurns != null) parts.push(`turn ${act.turnCount ?? 0}/${act.maxTurns}`);
		else if ((act.turnCount ?? 0) > 0) parts.push(`turn ${act.turnCount}`);
		if ((act.toolUses ?? 0) > 0) parts.push(formatCount(act.toolUses ?? 0, "tool"));
		parts.push(`${(computeLiveDurationMs(act) / 1000).toFixed(1)}s`);
		try {
			const ctxPct = this.handle.session.getSessionStats?.()?.contextUsage?.percent;
			if (ctxPct != null) {
				const color: CrewThemeColor = ctxPct >= 85 ? "error" : ctxPct >= 70 ? "warning" : "dim";
				parts.push(th.fg(color, `${gaugeBar(ctxPct / 100, CTX_GAUGE_WIDTH, th, color)} ${Math.round(ctxPct)}% ctx`));
			}
		} catch {
			/* ignore */
		}
		if ((act.compactionCount ?? 0) > 0) parts.push(th.fg("dim", `↻${act.compactionCount}`));
		if (this.handle.modelName) parts.push(th.fg("muted", this.handle.modelName));
		const describe = desc ? `${th.fg("muted", desc)} ${th.fg("dim", "·")} ` : "";
		lines.push(railLine(RAIL.body, slot, truncate(`${statusIcon} ${describe}${th.fg("dim", parts.join(" · "))}`, budget), th, budget));

		// Transcript body.
		const vh = this.viewportHeight();
		const visible = this.cachedLines.slice(this.scrollOffset, this.scrollOffset + vh);
		for (const line of visible) {
			lines.push(railLine(RAIL.body, "border", th.fg("dim", truncate(line, budget)), th, budget));
		}

		// Close cap: hint (left) ···· scroll state (right).
		lines.push(
			railLine(RAIL.close, slot, railLeaders(th.fg("dim", this.hintText()), th.fg("dim", this.stateText()), budget, th), th, budget),
		);
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
