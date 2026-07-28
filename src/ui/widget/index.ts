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
import type { OverlaySchedulerHandle } from "../shared-overlay-scheduler.ts";
import { registerOverlayScheduler } from "../shared-overlay-scheduler.ts";
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
// and pokes Pi to repaint at the new width. The listener references a
// module-level `activeResizeTarget` (the most-recently-mounted widget) rather
// than a specific instance, so replaced widgets do not leak listeners.
let resizeListenerInstalled = false;
let activeResizeTarget: { invalidate(): void; requestRepaint(): void } | undefined;
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
		activeResizeTarget?.invalidate();
		activeResizeTarget?.requestRepaint();
	}, 120);
};

function installResizeListener(): void {
	if (resizeListenerInstalled) return;
	resizeListenerInstalled = true;
	process.on("SIGWINCH", onResize);
	// Windows has no SIGWINCH; Node emits "resize" on stdout instead.
	if (typeof process.stdout?.on === "function") process.stdout.on("resize", onResize);
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
	activeResizeTarget = undefined;
	process.off("SIGWINCH", onResize);
	// Windows has no SIGWINCH; Node emits "resize" on stdout instead.
	if (typeof process.stdout?.off === "function") process.stdout.off("resize", onResize);
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
	/** C4 — invalidate-on-write cache for the buildSignature() result. */
	private cachedBuildSignature = "";
	private cachedBuildSignatureAt = 0;
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private cachedBaseLines: string[] = [];
	private cachedTheme: CrewTheme;
	private readonly tui: unknown;
	private readonly unsubscribeTheme: () => void;
	private readonly schedulerHandle: OverlaySchedulerHandle;

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
		this.schedulerHandle.dispose();
		if (activeResizeTarget === this) activeResizeTarget = undefined;
	}

	render(width: number): string[] {
		const runs = activeWidgetRuns(this.model.cwd, this.model.manifestCache, this.model.snapshotCache, this.model.preloadManifests);
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
			// P0-6: render from snapshots only — never read disk on every render tick.
			// When the snapshot cache is provided but hasn't populated yet, paint a
			// single "(loading…)" line so the pre-load frame is well-formed instead
			// of an empty panel. Without a cache (legacy/tests) keep the empty result.
			if (this.model.snapshotCache) return ["(loading…)"];
			return [];
		}

		const updatedHeader = `${runningGlyph}${this.cachedBaseLines[0]?.slice(1) ?? ""}`;
		this.cachedLines[0] = truncate(colorWidgetLine(updatedHeader, 0, this.theme), width);
		return this.cachedLines.map((line) => truncate(line, width));
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
	// F-1: remove the process-level SIGWINCH/resize listener when the widget is
	// stopped. The listener is guarded so re-mounting a widget re-installs it.
	uninstallResizeListener();
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
