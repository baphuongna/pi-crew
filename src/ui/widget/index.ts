/**
 * Crew widget — public API and component.
 *
 * Re-exports from widget submodules. The main component class and
 * update/stop functions live here.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewUiConfig } from "../../config/config.ts";
import type { ManifestCache } from "../../runtime/manifest-cache.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "../snapshot-types.ts";
import type { CrewTheme } from "../theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "../theme-adapter.ts";
import { truncate } from "../../utils/visual.ts";
import { requestRender, setExtensionWidget } from "../pi-ui-compat.ts";
import { spinnerBucket, spinnerFrame } from "../spinner.ts";
import { runEventBus } from "../run-event-bus.ts";
import { DEFAULT_UI } from "../../config/defaults.ts";
import { activeWidgetRuns, statusSummary } from "./widget-model.ts";
import { buildWidgetLines, colorWidgetLine, renderLines } from "./widget-renderer.ts";
import type { CrewWidgetModel, CrewWidgetState, WidgetRun } from "./widget-types.ts";

// Re-export types and helpers for backward compatibility
export type { WidgetRun, CrewWidgetModel, CrewWidgetState } from "./widget-types.ts";
export { activeWidgetRuns, statusSummary } from "./widget-model.ts";
export { buildWidgetLines as buildCrewWidgetLines, widgetHeader } from "./widget-renderer.ts";
export { notificationBadge } from "./widget-formatters.ts";

// ── Constants ─────────────────────────────────────────────────────────

const MAX_LINES_DEFAULT = DEFAULT_UI.widgetMaxLines;
const LEGACY_WIDGET_KEY = "pi-crew";
const WIDGET_KEY = "pi-crew-active";
const STATUS_KEY = "pi-crew";

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
	private readonly unsubscribeTheme: () => void;
	private readonly unsubscribeEventBus: () => void;

	constructor(model: CrewWidgetModel, themeLike: unknown) {
		this.model = model;
		this.theme = asCrewTheme(themeLike);
		this.cachedTheme = this.theme;
		this.unsubscribeTheme = subscribeThemeChange(themeLike, () => this.invalidate());
		this.unsubscribeEventBus = runEventBus.onAny(() => this.invalidate());
	}

	private buildSignature(runs: WidgetRun[]): string {
		const liveSig = [...listLiveAgents()].map((h) =>
			`${h.agentId}:${h.status}:${h.activity.turnCount}:${h.activity.toolUses}:${[...h.activity.activeTools.values()].join(",")}:${h.activity.responseText.slice(-30)}`
		).join("|");

		const hasRunning = runs.some((entry) => entry.agents.some((a) => a.status === "running"))
			|| [...listLiveAgents()].some((h) => h.status === "running");
		const animation = hasRunning ? `:spin=${spinnerBucket()}` : "";

		return runs
			.map((entry) => entry.snapshot?.signature ?? `${entry.run.runId}:${entry.run.status}:${entry.run.updatedAt}:` +
				entry.agents.map((a) => {
					const recentOutput = a.progress?.recentOutput.at(-1) ?? "";
					const progress = [a.progress?.currentTool ?? "", a.progress?.toolCount ?? 0, a.progress?.tokens ?? 0, a.progress?.turns ?? 0, a.progress?.lastActivityAt ?? "", recentOutput].join(":");
					return `${a.status}:${a.startedAt}:${a.completedAt ?? ""}:${a.toolUses ?? 0}:${progress}`;
				}).join(","))
			.join("|") + `|live:${liveSig}${animation}`;
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

	dispose(): void {
		this.unsubscribeTheme();
		this.unsubscribeEventBus();
	}

	render(width: number): string[] {
		const runs = activeWidgetRuns(this.model.cwd, this.model.manifestCache, this.model.snapshotCache, this.model.preloadManifests);
		const signature = `${this.buildSignature(runs)}:${this.model.notificationCount ?? 0}`;
		const runningGlyph = spinnerFrame("widget-header");

		if (this.cacheSignature !== signature || width !== this.cachedWidth || this.cachedTheme !== this.theme) {
			this.cachedBaseLines = buildWidgetLines(this.model.cwd, 0, this.model.maxLines, runs, this.model.notificationCount ?? 0).map((line, index) => {
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
	const lines = buildWidgetLines(ctx.cwd, state.frame, maxLines, runs, state.notificationCount ?? 0);
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

	const needsWidgetInstall = state.lastVisibility !== "visible" || state.lastPlacement !== placement || state.lastKey !== WIDGET_KEY || state.lastMaxLines !== maxLines || state.lastCwd !== ctx.cwd || !state.model;

	if (!state.model) state.model = { cwd: ctx.cwd, frame: state.frame, maxLines, notificationCount: state.notificationCount ?? 0, manifestCache, snapshotCache, preloadManifests: preloadedManifests };
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
		setExtensionWidget(
			ctx,
			WIDGET_KEY,
			((_tui: unknown, theme: unknown) => new CrewWidgetComponent(model, theme)) as never,
			{ placement, persist: true },
		);
		state.lastVisibility = "visible";
		state.lastPlacement = placement;
		state.lastKey = WIDGET_KEY;
		state.lastMaxLines = maxLines;
		state.lastCwd = ctx.cwd;
	}

	requestRender(ctx);
}

export function stopCrewWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, state: CrewWidgetState, config?: CrewUiConfig): void {
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
