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
import { isFooterDockSinkActive, setFooterDockProvider } from "../dock-footer.ts";
import { panelRowsFromRuns } from "../inline-panel/panel-rows.ts";
import { panelDisplayState, setPanelRowsProvider, subscribePanelChange } from "../inline-panel/panel-store.ts";
import { requestRender, requestRenderTarget, setExtensionWidget } from "../pi-ui-compat.ts";
import type { OverlaySchedulerHandle } from "../shared-overlay-scheduler.ts";
import { registerOverlayScheduler } from "../shared-overlay-scheduler.ts";
import type { RunSnapshotCache } from "../snapshot-types.ts";
import { spinnerBucket, spinnerFrame } from "../spinner.ts";
import type { CrewTheme } from "../theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "../theme-adapter.ts";
import { buildTaskListLines } from "./task-list.ts";
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
/** The run's plan progress, painted ABOVE the editor (task-list.ts). */
const TASKS_WIDGET_KEY = "pi-crew-tasks";
const STATUS_KEY = "pi-crew";

/**
 * C4 — short-TTL safety net for the buildSignature() result cache. Combined
 * with invalidate-on-write (onInvalidate clears the cache on every real
 * event), this prevents redundant O(runs×agents) signature recomputation
 * during a burst of host-driven renders within one state snapshot while
 * ensuring the signature is always recomputed after genuine data changes.
 */
const SIGNATURE_CACHE_TTL_MS = 100;

// ── Terminal resize handling (T-2) ────────────────────────────────────
// On a terminal resize the widget's cached render width goes stale until the
// next invalidate; a mid-run resize could briefly paint a frame at the old
// width. We register ONE debounced process-level listener (guarded so it never
// accumulates across widget reinstalls) that busts the active widget's cache
// and pokes Pi to repaint at the new width. The listener references the
// module-level `activeResizeTargets` set (every mounted widget) rather than
// specific instances, so replaced widgets do not leak listeners.
let resizeListenerInstalled = false;
/** All mounted widgets (dock + task list) — every one gets resize-busted. */
const activeResizeTargets = new Set<{ invalidate(): void; requestRepaint(): void }>();
let resizeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * F-1: the resize callback is stored at module level so
 * `uninstallResizeListener()` can remove the exact same reference via
 * `process.off` (requires the identical function reference).
 */
const onResize = (): void => {
	if (resizeTimer) clearTimeout(resizeTimer);
	// Debounce (~120ms) so a drag-resize doesn't thrash renders.
	resizeTimer = setTimeout(() => {
		resizeTimer = undefined;
		for (const target of activeResizeTargets) {
			target.invalidate();
			target.requestRepaint();
		}
	}, 120);
};

/**
 * F-1: install the single, guarded terminal-resize listener (exported for
 * testability). The stdout "resize" listener is only registered when it can
 * ALSO be removed later (off()/removeListener()); otherwise it is skipped so
 * it can never leak across widget reinstalls (UI-7).
 */
export function installResizeListener(): void {
	if (resizeListenerInstalled) return;
	resizeListenerInstalled = true;
	process.on("SIGWINCH", onResize);
	// Windows has no SIGWINCH; Node emits "resize" on stdout instead.
	// Guard (UI-7): only register when removal is possible too. Older runtimes
	// or mock stdouts that expose only `on` would otherwise add a listener that
	// uninstallResizeListener() can never address → leak on every reinstall.
	if (
		typeof process.stdout?.on === "function" &&
		(typeof process.stdout?.off === "function" || typeof process.stdout?.removeListener === "function")
	) {
		process.stdout.on("resize", onResize);
	}
}

/**
 * F-1: remove the process-level resize listeners so they don't outlive the
 * extension session. Safe to call when no listener is installed (no-op).
 * Re-installs automatically when a new widget mounts via `installResizeListener()`.
 */
export function uninstallResizeListener(): void {
	if (!resizeListenerInstalled) return;
	resizeListenerInstalled = false;
	if (resizeTimer) {
		clearTimeout(resizeTimer);
		resizeTimer = undefined;
	}
	activeResizeTargets.clear();
	process.off("SIGWINCH", onResize);
	// Windows has no SIGWINCH; Node emits "resize" on stdout instead.
	// Remove via whichever API is present. The listener was only registered
	// when removal was possible (UI-7), so at most one of these applies; both
	// are no-ops if no listener was ever added.
	if (typeof process.stdout?.off === "function") {
		process.stdout.off("resize", onResize);
	} else if (typeof process.stdout?.removeListener === "function") {
		process.stdout.removeListener("resize", onResize);
	}
}

import type { CrewComponent } from "../component.ts";

// ── Widget Component ──────────────────────────────────────────────────────

// PR-G3 (UI-3): extend the shared CrewComponent contract (render +
// invalidate). Structurally identical to the previous declaration — no
// behavior change.
interface WidgetComponent extends CrewComponent {}

class CrewWidgetComponent implements WidgetComponent {
	private readonly model: CrewWidgetModel;
	private theme: CrewTheme;
	/** Which surface this instance paints: the agent dock, or the task list. */
	private readonly variant: "dock" | "tasks";
	private cacheSignature = "";
	/** C4 — invalidate-on-write cache for the buildSignature() result. */
	private cachedBuildSignature = "";
	private cachedBuildSignatureAt = 0;
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private cachedBaseLines: string[] = [];
	private cachedTheme: CrewTheme;
	private readonly tui: unknown;
	private readonly unsubscribeTheme: () => void;
	private readonly unsubscribePanel: () => void;
	private readonly schedulerHandle: OverlaySchedulerHandle;

	constructor(model: CrewWidgetModel, themeLike: unknown, tui?: unknown, variant: "dock" | "tasks" = "dock") {
		this.model = model;
		this.variant = variant;
		this.theme = asCrewTheme(themeLike);
		this.cachedTheme = this.theme;
		this.tui = tui;
		// Register as the active resize target and ensure the single, guarded
		// terminal-resize listener is installed. On a resize the cached width
		// goes stale; busting the cache + requesting a repaint refreshes the
		// widget at the new width without waiting for the next event tick (T-2).
		activeResizeTargets.add(this);
		installResizeListener();
		this.unsubscribeTheme = subscribeThemeChange(themeLike, () => this.invalidate());
		// Cursor movement is a keypress, not a run event, so it never reaches the
		// shared scheduler. Repaint directly instead of waiting for the next host
		// tick — a lagging cursor reads as a dropped keystroke.
		this.unsubscribePanel = subscribePanelChange(() => {
			this.invalidate();
			this.requestRepaint();
		});
		// 1.10 (UI-P1-1): route run:state / worker:lifecycle / ui:invalidate
		// through a RenderScheduler (debounce + fallback) instead of three
		// direct runEventBus.onChannel subscriptions. With 3 overlays
		// subscribing independently a single event triggered up to 9 callbacks
		// and ~150 invalidates/sec under load. The scheduler collapses bursts
		// into one debounced invalidate.
		this.schedulerHandle = registerOverlayScheduler(
			() => this.invalidate(),
			() => {
				// C4 invalidate-on-write: drop the cached buildSignature()
				// result immediately when a real event arrives (run:state /
				// worker:lifecycle / ui:invalidate). The prior blind-TTL
				// attempt (reverted in 619a0cd) held a stale signature
				// within the window and skipped re-render on genuine state
				// changes. Clearing here + in invalidate() guarantees the
				// next render tick always recomputes from fresh data.
				this.cachedBuildSignature = "";
				this.cachedBuildSignatureAt = 0;
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

		const sig =
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
				.join("|") + `|live:${liveSig}${animation}`;
		return sig;
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
		this.cachedBuildSignature = "";
		this.cachedBuildSignatureAt = 0;
	}

	/** Poke the host TUI to repaint immediately (defensive: no-op if unavailable). */
	requestRepaint(): void {
		requestRenderTarget(this.tui);
	}

	dispose(): void {
		this.unsubscribeTheme();
		this.unsubscribePanel();
		this.schedulerHandle.dispose();
		activeResizeTargets.delete(this);
	}

	render(width: number): string[] {
		const runs = activeWidgetRuns(
			this.model.cwd,
			this.model.manifestCache,
			this.model.snapshotCache,
			this.model.preloadManifests,
			this.model.workspaceId,
		);
		// C4: invalidate-on-write signature cache. buildSignature() is
		// O(runs×agents) string work called on every ~160ms host-driven render
		// tick. Within one state snapshot (no event arrived → cache not cleared
		// by onInvalidate) the result is identical, so we reuse the cached value
		// to skip redundant recomputation. A short TTL acts as a safety net for
		// the unlikely case where a real event is missed.
		const now = Date.now();
		let sigBase: string;
		if (this.cachedBuildSignature !== "" && now - this.cachedBuildSignatureAt < SIGNATURE_CACHE_TTL_MS) {
			sigBase = this.cachedBuildSignature;
		} else {
			sigBase = this.buildSignature(runs);
			this.cachedBuildSignature = sigBase;
			this.cachedBuildSignatureAt = now;
		}
		const signature = `${sigBase}:${this.model.notificationCount ?? 0}`;
		const runningGlyph = spinnerFrame("widget-header");

		// Task-list variant: the run's plan above the editor (task-list.ts).
		// No panel state, no spinner glyph — the list changes only on task
		// transitions, which the run signature already covers.
		if (this.variant === "tasks") {
			if (this.cacheSignature !== signature || width !== this.cachedWidth || this.cachedTheme !== this.theme) {
				this.cachedBaseLines = buildTaskListLines(runs, width);
				this.cachedLines = this.colorize(this.cachedBaseLines, width);
				this.cachedWidth = width;
				this.cachedTheme = this.theme;
				this.cacheSignature = signature;
			}
			if (runs.length === 0) {
				this.invalidate();
				return [];
			}
			return this.cachedLines.map((line) => truncate(line, width));
		}

		// Panel cursor/pane state is part of the rendered output, so it belongs in
		// the cache key — otherwise moving the cursor would not repaint.
		const panel = panelDisplayState();
		const signatureWithPanel = `${signature}|panel:${panel.selectedTaskId ?? ""}/${panel.viewedTaskId ?? ""}/${panel.focused ? 1 : 0}`;

		// The spinner-frame swap only belongs on the LEGACY header, whose line 0
		// already starts with a glyph position (`<frame> Crew agents …`). The
		// compact dock's line 0 is the HINT text ("agents (N) — ↓ to select"):
		// swapping would visibly eat its first character on every frame.
		const compactDock = this.model.rowStyle === "compact";
		if (this.cacheSignature !== signatureWithPanel || width !== this.cachedWidth || this.cachedTheme !== this.theme) {
			this.cachedBaseLines = buildWidgetLines(
				this.model.cwd,
				0,
				this.model.maxLines,
				runs,
				this.model.notificationCount ?? 0,
				width,
				{ rowStyle: this.model.rowStyle, ...panel },
			).map((line, index) => {
				if (!compactDock && index === 0 && line.length > 0) return `${runningGlyph}${line.slice(1)}`;
				return line;
			});
			this.cachedLines = this.colorize(this.cachedBaseLines, width);
			this.cachedWidth = width;
			this.cachedTheme = this.theme;
			this.cacheSignature = signatureWithPanel;
		}

		if (runs.length === 0) {
			this.invalidate();
			// P0-6: render from snapshots only — never read disk on every render tick.
			// When the snapshot cache is provided but hasn't populated yet, paint a
			// single "(loading…)" line so the pre-load frame is well-formed instead
			// of an empty panel. Without a cache (legacy/tests) keep the empty result.
			if (this.model.snapshotCache) return ["(loading…)"];
			return [];
		}

		if (!compactDock) {
			const updatedHeader = `${runningGlyph}${this.cachedBaseLines[0]?.slice(1) ?? ""}`;
			this.cachedLines[0] = truncate(colorWidgetLine(updatedHeader, 0, this.theme), width);
		}
		return this.cachedLines.map((line) => truncate(line, width));
	}
}

// ── Footer dock host (widgetPlacement: "bottom") ──────────────────────

/**
 * Dock host for `widgetPlacement: "bottom"`. Keeps a single CrewWidgetComponent
 * (theme-less → raw lines, no ANSI) per session and feeds its render output to
 * the crew-vibes footer through the dock-footer registry. The footer colors the
 * lines with ITS OWN theme so the dock matches the footer context. All caching,
 * event wiring (panel changes, run events, resize) lives in the wrapped
 * component; the footer is re-rendered by pi on every host repaint.
 */
class FooterDockHost {
	private component: CrewWidgetComponent | undefined;
	private readonly model: CrewWidgetModel;

	constructor(model: CrewWidgetModel) {
		this.model = model;
	}

	render(width: number): string[] {
		if (!this.component) this.component = new CrewWidgetComponent(this.model, undefined, undefined);
		return this.component.render(width);
	}

	dispose(): void {
		this.component?.dispose();
		this.component = undefined;
	}
}

// ── Re-export listLiveAgents for buildSignature ───────────────────────

import { listLiveAgents } from "../../runtime/live-session/live-agent-manager.ts";

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
	const rowStyle = config?.widgetRowStyle ?? DEFAULT_UI.widgetRowStyle;
	// The inline panel navigates the same run list the widget paints, and this is
	// the only place already holding the manifest/snapshot caches — so the row
	// projection is registered here instead of re-reading state on every keypress.
	setPanelRowsProvider(() => panelRowsFromRuns(activeWidgetRuns(ctx.cwd, manifestCache, snapshotCache, preloadedManifests, workspaceId)));
	const lines = buildWidgetLines(ctx.cwd, state.frame, maxLines, runs, state.notificationCount ?? 0, getRenderWidth(), {
		rowStyle,
		...panelDisplayState(),
	});
	const placement = config?.widgetPlacement ?? DEFAULT_UI.widgetPlacement;
	// `bottom` is not a pi widget slot: the dock then renders inside the
	// crew-vibes footer (dock-footer registry). pi's slot calls always use a
	// real slot so legacy-clear/installs stay on maps pi understands.
	const bottomMode = placement === "bottom";
	const dockInFooter = bottomMode && isFooterDockSinkActive();
	const piPlacement: "aboveEditor" | "belowEditor" = bottomMode ? "belowEditor" : placement;

	ctx.ui.setStatus(STATUS_KEY, lines.length ? statusSummary(runs) : undefined);

	const shouldClearLegacy = state.legacyCleared !== true || state.lastPlacement !== placement;
	if (shouldClearLegacy) {
		setExtensionWidget(ctx, LEGACY_WIDGET_KEY, undefined, { placement: piPlacement });
		state.legacyCleared = true;
	}

	if (!lines.length) {
		if (state.lastVisibility !== "hidden" || state.lastPlacement !== placement) {
			setExtensionWidget(ctx, WIDGET_KEY, undefined, { placement: piPlacement });
			setExtensionWidget(ctx, TASKS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
			state.lastTasksVisibility = "hidden";
			state.footerDock?.dispose();
			state.footerDock = undefined;
			setFooterDockProvider(undefined);
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
			workspaceId,
			rowStyle,
		};
	else {
		state.model.cwd = ctx.cwd;
		state.model.frame = state.frame;
		state.model.maxLines = maxLines;
		state.model.notificationCount = state.notificationCount ?? 0;
		state.model.manifestCache = manifestCache;
		state.model.snapshotCache = snapshotCache;
		state.model.preloadManifests = preloadedManifests;
		state.model.workspaceId = workspaceId;
		state.model.rowStyle = rowStyle;
	}

	if (dockInFooter) {
		// Keep pi's widget slot free: the crew-vibes footer paints the dock at
		// the very bottom, below the quota/meter lines. A widget-slot install
		// from a PREVIOUS placement (or a sink that was just enabled) must be
		// removed first.
		if (needsWidgetInstall && state.lastKey === WIDGET_KEY) {
			setExtensionWidget(ctx, WIDGET_KEY, undefined, { placement: piPlacement });
		}
		if (!state.footerDock) state.footerDock = new FooterDockHost(state.model);
		setFooterDockProvider((width) => state.footerDock!.render(width));
	} else {
		// Widget-slot path (aboveEditor/belowEditor, or no footer sink for
		// "bottom"): ensure any stale footer dock is detached first.
		if (state.footerDock) {
			state.footerDock.dispose();
			state.footerDock = undefined;
		}
		setFooterDockProvider(undefined);
	}

	if (needsWidgetInstall && !dockInFooter) {
		const model = state.model;
		setExtensionWidget(ctx, WIDGET_KEY, ((_tui: unknown, theme: unknown) => new CrewWidgetComponent(model, theme, _tui)) as never, {
			placement: piPlacement,
			persist: true,
		});
		state.lastVisibility = "visible";
		state.lastPlacement = placement;
		state.lastKey = WIDGET_KEY;
		state.lastMaxLines = maxLines;
		state.lastCwd = ctx.cwd;
	} else if (dockInFooter) {
		state.lastVisibility = "visible";
		state.lastPlacement = placement;
		state.lastKey = WIDGET_KEY;
		state.lastMaxLines = maxLines;
		state.lastCwd = ctx.cwd;
	}

	// Task list (aboveEditor): the run's plan progress — Claude Code / droid
	// style, independent of the dock's placement (so it also shows when the
	// dock renders in the crew-vibes footer). Installed once while any
	// display-active run exists; the component paints nothing until a run
	// carries a tasks slice.
	const tasksVisible = runs.length > 0 && Boolean(state.model);
	if (tasksVisible && state.lastTasksVisibility !== "visible") {
		const model = state.model;
		setExtensionWidget(
			ctx,
			TASKS_WIDGET_KEY,
			((_tui: unknown, theme: unknown) => new CrewWidgetComponent(model, theme, _tui, "tasks")) as never,
			{ placement: "aboveEditor" },
		);
		state.lastTasksVisibility = "visible";
	} else if (!tasksVisible && state.lastTasksVisibility === "visible") {
		setExtensionWidget(ctx, TASKS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		state.lastTasksVisibility = "hidden";
	}

	requestRender(ctx);
}

export function stopCrewWidget(
	ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined,
	state: CrewWidgetState,
	config?: CrewUiConfig,
): void {
	// F-1: remove the process-level SIGWINCH/resize listener when the widget is
	// stopped. The listener is guarded so re-mounting a widget re-installs it.
	uninstallResizeListener();
	if (ctx?.hasUI) {
		const placement = config?.widgetPlacement ?? DEFAULT_UI.widgetPlacement;
		const piPlacement: "aboveEditor" | "belowEditor" = placement === "bottom" ? "belowEditor" : placement;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		setExtensionWidget(ctx, LEGACY_WIDGET_KEY, undefined, { placement: piPlacement });
		setExtensionWidget(ctx, WIDGET_KEY, undefined, { placement: piPlacement });
		setExtensionWidget(ctx, TASKS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		state.lastTasksVisibility = "hidden";
		state.footerDock?.dispose();
		state.footerDock = undefined;
		setFooterDockProvider(undefined);
		state.lastVisibility = "hidden";
		state.lastPlacement = placement;
		state.lastKey = WIDGET_KEY;
		state.model = undefined;
		state.legacyCleared = true;
		requestRender(ctx);
	}
}
