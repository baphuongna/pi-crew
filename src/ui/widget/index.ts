/**
 * Crew widget — public API and component.
 *
 * Re-exports from widget submodules. The main component class and
 * update/stop functions live here.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewUiConfig } from "../../config/config.ts";
import { DEFAULT_UI } from "../../config/defaults.ts";
import type { ManifestCache } from "../../runtime/manifest-cache.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { truncate } from "../../utils/visual.ts";
import { requestRender, requestRenderTarget, setExtensionWidget } from "../pi-ui-compat.ts";
import { RenderScheduler } from "../render-scheduler.ts";
import { runEventBusAsRenderScheduler } from "../run-event-bus.ts";
import type { RunSnapshotCache } from "../snapshot-types.ts";
import { spinnerBucket, spinnerFrame } from "../spinner.ts";
import type { CrewTheme } from "../theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "../theme-adapter.ts";
import { activeWidgetRuns, statusSummary } from "./widget-model.ts";
import { buildWidgetLines, colorWidgetLine, DEFAULT_WIDGET_WIDTH, renderLines } from "./widget-renderer.ts";
import type { CrewWidgetModel, CrewWidgetState, WidgetRun } from "./widget-types.ts";

export { activeWidgetRuns, statusSummary } from "./widget-model.ts";
export {
	buildWidgetLines as buildCrewWidgetLines,
	DEFAULT_WIDGET_WIDTH,
	TASK_DESC_MAX,
	widgetHeader,
} from "./widget-renderer.ts";
// Re-export types and helpers for backward compatibility
export type {
	CrewWidgetModel,
	CrewWidgetState,
	WidgetRun,
} from "./widget-types.ts";

/**
 * Resolve the real render width for widget lines, in priority order:
 *   1. explicit `width` argument (e.g. from caller that already knows terminal width)
 *   2. `process.stdout.columns` (works in Node when stdout is a TTY)
 *   3. `DEFAULT_WIDGET_WIDTH` (100) — last-resort fallback so we never paint
 *      a line wider than the smallest expected TUI.
 *
 * Callers SHOULD pass the width they already hold (e.g. `WidgetRender.render(width)`
 * in this file already receives one). This helper exists for paths that don't.
 */
export function getRenderWidth(width?: number): number {
	if (Number.isFinite(width) && width! > 0) return Math.floor(width!);
	const stdoutCols = (globalThis as { process?: { stdout?: { columns?: number } } }).process?.stdout?.columns;
	if (Number.isFinite(stdoutCols) && stdoutCols! > 0) return Math.floor(stdoutCols!);
	return DEFAULT_WIDGET_WIDTH;
}
export {
	NOTIFICATION_BADGE_CAP,
	notificationBadge,
} from "./widget-formatters.ts";

// ── Constants ─────────────────────────────────────────────────────────

const MAX_LINES_DEFAULT = DEFAULT_UI.widgetMaxLines;
const LEGACY_WIDGET_KEY = "pi-crew";
const WIDGET_KEY = "pi-crew-active";
const STATUS_KEY = "pi-crew";

// ── Terminal resize handling (T-2) ────────────────────────────────────
// On a terminal resize the widget's cached render width goes stale until the
// next invalidate; a mid-run resize could briefly paint a frame at the old
// width. We register ONE debounced process-level listener (guarded so it never
// accumulates across widget reinstalls) that busts the active widget's cache
// and pokes Pi to repaint at the new width. The listener references a
// module-level `activeResizeTarget` (the most-recently-mounted widget) rather
// than a specific instance, so replaced widgets do not leak listeners.
let resizeListenerInstalled = false;
let activeResizeTarget: { invalidate(): void; requestRepaint(): void } | undefined;

function installResizeListener(): void {
	if (resizeListenerInstalled) return;
	resizeListenerInstalled = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onResize = (): void => {
		if (timer) clearTimeout(timer);
		// Debounce (~120ms) so a drag-resize doesn't thrash renders.
		timer = setTimeout(() => {
			timer = undefined;
			activeResizeTarget?.invalidate();
			activeResizeTarget?.requestRepaint();
		}, 120);
	};
	process.on("SIGWINCH", onResize);
	// Windows has no SIGWINCH; Node emits "resize" on stdout instead.
	if (typeof process.stdout?.on === "function") process.stdout.on("resize", onResize);
}

// ── Widget Component ──────────────────────────────────────────────────

interface WidgetComponent {
	render(width: number): string[];
	invalidate(): void;
}

class CrewWidgetComponent implements WidgetComponent {
	private readonly model: CrewWidgetModel;
	private theme: CrewTheme;
	private cacheSignature = "";
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private cachedBaseLines: string[] = [];
	private cachedTheme: CrewTheme;
	/** Peak line count seen during the current active cycle. The widget pads
	 * returned lines up to this height so the terminal layout never reflows
	 * when agents spawn/complete mid-run (only the content changes, not the
	 * height). Reset to 0 when all runs leave the display-active set, so the
	 * widget disappears cleanly once every task is done. */
	private peakHeight = 0;
	private readonly tui: unknown;
	private readonly unsubscribeTheme: () => void;
	private readonly renderScheduler: RenderScheduler;

	constructor(model: CrewWidgetModel, themeLike: unknown, tui?: unknown) {
		this.model = model;
		this.theme = asCrewTheme(themeLike);
		this.cachedTheme = this.theme;
		this.tui = tui;
		// Register as the active resize target and ensure the single, guarded
		// terminal-resize listener is installed. On a resize the cached width
		// goes stale; busting the cache + requesting a repaint refreshes the
		// widget at the new width without waiting for the next event tick (T-2).
		activeResizeTarget = this;
		installResizeListener();
		this.unsubscribeTheme = subscribeThemeChange(themeLike, () => this.invalidate());
		// 1.10 (UI-P1-1): route run:state / worker:lifecycle / ui:invalidate
		// through a RenderScheduler (debounce + fallback) instead of three
		// direct runEventBus.onChannel subscriptions. With 3 overlays
		// subscribing independently a single event triggered up to 9 callbacks
		// and ~150 invalidates/sec under load. The scheduler collapses bursts
		// into one debounced invalidate.
		this.renderScheduler = new RenderScheduler(
			runEventBusAsRenderScheduler(["run:state", "worker:lifecycle", "ui:invalidate"]),
			() => this.invalidate(),
			{
				debounceMs: 75,
				fallbackMs: 750,
				events: ["run:state", "worker:lifecycle", "ui:invalidate"],
			},
		);
	}

	private buildSignature(runs: WidgetRun[]): string {
		const liveSig = [...listLiveAgents()]
			.map(
				(h) =>
					`${h.agentId}:${h.status}:${h.activity.turnCount}:${h.activity.toolUses}:${[...h.activity.activeTools.values()].join(",")}:${h.activity.responseText.slice(-30)}`,
			)
			.join("|");

		const hasRunning =
			runs.some((entry) => entry.agents.some((a) => a.status === "running")) ||
			[...listLiveAgents()].some((h) => h.status === "running");
		const animation = hasRunning ? `:spin=${spinnerBucket()}` : "";

		return (
			runs
				.map(
					(entry) =>
						entry.snapshot?.signature ??
						`${entry.run.runId}:${entry.run.status}:${entry.run.updatedAt}:` +
							entry.agents
								.map((a) => {
									const recentOutput = a.progress?.recentOutput.at(-1) ?? "";
									const progress = [
										a.progress?.currentTool ?? "",
										a.progress?.toolCount ?? 0,
										a.progress?.tokens ?? 0,
										a.progress?.turns ?? 0,
										a.progress?.lastActivityAt ?? "",
										recentOutput,
									].join(":");
									return `${a.status}:${a.startedAt}:${a.completedAt ?? ""}:${a.toolUses ?? 0}:${progress}`;
								})
								.join(","),
				)
				.join("|") + `|live:${liveSig}${animation}`
		);
	}

	private colorize(lines: string[], width: number): string[] {
		return renderLines(
			lines.map((line, index) => colorWidgetLine(line, index, this.theme)),
			width,
		);
	}

	invalidate(): void {
		this.cacheSignature = "";
		this.cachedBaseLines = [];
		this.cachedLines = [];
	}

	/** Poke the host TUI to repaint immediately (defensive: no-op if unavailable). */
	requestRepaint(): void {
		requestRenderTarget(this.tui);
	}

	dispose(): void {
		this.unsubscribeTheme();
		this.renderScheduler.dispose();
		if (activeResizeTarget === this) activeResizeTarget = undefined;
	}

	render(width: number): string[] {
		const runs = activeWidgetRuns(this.model.cwd, this.model.manifestCache, this.model.snapshotCache, this.model.preloadManifests);
		const signature = `${this.buildSignature(runs)}:${this.model.notificationCount ?? 0}`;
		const runningGlyph = spinnerFrame("widget-header");

		if (this.cacheSignature !== signature || width !== this.cachedWidth || this.cachedTheme !== this.theme) {
			this.cachedBaseLines = buildWidgetLines(
				this.model.cwd,
				0,
				this.model.maxLines,
				runs,
				this.model.notificationCount ?? 0,
				width,
			).map((line, index) => {
				if (index === 0 && line.length > 0) return `${runningGlyph}${line.slice(1)}`;
				return line;
			});
			this.cachedLines = this.colorize(this.cachedBaseLines, width);
			this.cachedWidth = width;
			this.cachedTheme = this.theme;
			this.cacheSignature = signature;
		}

		if (runs.length === 0) {
			this.invalidate();
			this.peakHeight = 0; // all tasks done → release reserved height, widget disappears
			// P0-6: render from snapshots only — never read disk on every render tick.
			// When the snapshot cache is provided but hasn't populated yet, paint a
			// single "(loading…)" line so the pre-load frame is well-formed instead
			// of an empty panel. Without a cache (legacy/tests) keep the empty result.
			if (this.model.snapshotCache) return ["(loading…)"];
			return [];
		}

		const updatedHeader = `${runningGlyph}${this.cachedBaseLines[0]?.slice(1) ?? ""}`;
		this.cachedLines[0] = truncate(colorWidgetLine(updatedHeader, 0, this.theme), width);
		const out = this.cachedLines.map((line) => truncate(line, width));
		// Lock height to the peak seen this cycle: pad with blank rows so agent
		// spawn/complete never changes the widget height (only content changes).
		// Resets to 0 once all runs leave the display-active set (runs.length===0).
		this.peakHeight = Math.max(this.peakHeight, out.length);
		while (out.length < this.peakHeight) out.push("");
		return out;
	}
}

// ── Re-export listLiveAgents for buildSignature ───────────────────────

import { listLiveAgents } from "../../runtime/live-agent-manager.ts";

// ── Public API ────────────────────────────────────────────────────────

export function updateCrewWidget(
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui" | "sessionManager">,
	state: CrewWidgetState,
	config?: CrewUiConfig,
	manifestCache?: ManifestCache,
	snapshotCache?: RunSnapshotCache,
	preloadedManifests?: TeamRunManifest[],
): void {
	if (!ctx.hasUI) return;
	state.frame += 1;
	const maxLines = config?.widgetMaxLines ?? MAX_LINES_DEFAULT;

	let workspaceId = ctx.sessionManager?.getSessionId?.();
	if (!workspaceId && manifestCache) {
		const runs = manifestCache.list(20);
		const active = runs.find((r) => r.status === "running" || r.status === "queued");
		if (active?.ownerSessionId) workspaceId = active.ownerSessionId;
	}

	const runs = activeWidgetRuns(ctx.cwd, manifestCache, snapshotCache, preloadedManifests, workspaceId);
	const lines = buildWidgetLines(ctx.cwd, state.frame, maxLines, runs, state.notificationCount ?? 0, getRenderWidth());
	const placement = config?.widgetPlacement ?? DEFAULT_UI.widgetPlacement;

	ctx.ui.setStatus(STATUS_KEY, lines.length ? statusSummary(runs) : undefined);

	const shouldClearLegacy = state.legacyCleared !== true || state.lastPlacement !== placement;
	if (shouldClearLegacy) {
		setExtensionWidget(ctx, LEGACY_WIDGET_KEY, undefined, { placement });
		state.legacyCleared = true;
	}

	if (!lines.length) {
		if (state.lastVisibility !== "hidden" || state.lastPlacement !== placement) {
			setExtensionWidget(ctx, WIDGET_KEY, undefined, { placement });
			state.lastVisibility = "hidden";
			state.lastPlacement = placement;
			state.lastKey = WIDGET_KEY;
			state.lastMaxLines = maxLines;
			state.lastCwd = ctx.cwd;
			state.model = undefined;
		}
		requestRender(ctx);
		return;
	}

	const needsWidgetInstall =
		state.lastVisibility !== "visible" ||
		state.lastPlacement !== placement ||
		state.lastKey !== WIDGET_KEY ||
		state.lastMaxLines !== maxLines ||
		state.lastCwd !== ctx.cwd ||
		!state.model;

	if (!state.model)
		state.model = {
			cwd: ctx.cwd,
			frame: state.frame,
			maxLines,
			notificationCount: state.notificationCount ?? 0,
			manifestCache,
			snapshotCache,
			preloadManifests: preloadedManifests,
		};
	else {
		state.model.cwd = ctx.cwd;
		state.model.frame = state.frame;
		state.model.maxLines = maxLines;
		state.model.notificationCount = state.notificationCount ?? 0;
		state.model.manifestCache = manifestCache;
		state.model.snapshotCache = snapshotCache;
		state.model.preloadManifests = preloadedManifests;
	}

	if (needsWidgetInstall) {
		const model = state.model;
		setExtensionWidget(ctx, WIDGET_KEY, ((_tui: unknown, theme: unknown) => new CrewWidgetComponent(model, theme, _tui)) as never, {
			placement,
			persist: true,
		});
		state.lastVisibility = "visible";
		state.lastPlacement = placement;
		state.lastKey = WIDGET_KEY;
		state.lastMaxLines = maxLines;
		state.lastCwd = ctx.cwd;
	}

	requestRender(ctx);
}

export function stopCrewWidget(
	ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined,
	state: CrewWidgetState,
	config?: CrewUiConfig,
): void {
	if (state.interval) clearInterval(state.interval);
	state.interval = undefined;
	if (ctx?.hasUI) {
		const placement = config?.widgetPlacement ?? DEFAULT_UI.widgetPlacement;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		setExtensionWidget(ctx, LEGACY_WIDGET_KEY, undefined, { placement });
		setExtensionWidget(ctx, WIDGET_KEY, undefined, { placement });
		state.lastVisibility = "hidden";
		state.lastPlacement = placement;
		state.lastKey = WIDGET_KEY;
		state.model = undefined;
		state.legacyCleared = true;
		requestRender(ctx);
	}
}
