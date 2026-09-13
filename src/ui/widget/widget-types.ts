/**
 * Widget type definitions.
 */

import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import type { ManifestCache } from "../../runtime/manifest-cache.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "../snapshot-types.ts";

export interface WidgetRun {
	run: TeamRunManifest;
	agents: CrewAgentRecord[];
	snapshot?: RunUiSnapshot;
}

export interface CrewWidgetModel {
	cwd: string;
	frame: number;
	maxLines: number;
	notificationCount?: number;
	manifestCache?: ManifestCache;
	snapshotCache?: RunSnapshotCache;
	preloadManifests?: TeamRunManifest[];
	/** P3 (#9): workspace/session ID for filtering runs by ownerSessionId
	 * on every render, not just the first frame. */
	workspaceId?: string;
	/** Per-agent row layout; defaults to the historical two-line tree. */
	rowStyle?: import("./widget-renderer.ts").WidgetRowStyle;
	/** True when the crew-vibes footer owns the schedules segment — the dock
	 * path renders through the footer's meter line, so the widget itself must
	 * not paint the `⏰ …` line (would duplicate). Slot mode keeps painting
	 * it. Maintained by updateCrewWidget on every update. */
	dockedInFooter?: boolean;
}

export interface CrewWidgetState {
	frame: number;
	lastPlacement?: string;
	lastVisibility?: "hidden" | "visible";
	/** Whether the aboveEditor task-list widget (pi-crew-tasks) is mounted. */
	lastTasksVisibility?: "hidden" | "visible";
	lastKey?: string;
	lastMaxLines?: number;
	lastCwd?: string;
	legacyCleared?: boolean;
	/** Tier C live-fix #1 (2026-09-13): TRUE when the widget component is
	 * currently installed in a PI WIDGET SLOT (aboveEditor/belowEditor). Used
	 * to clear the slot when the crew-vibes footer sink activates LATER —
	 * without it, the slot install from the first update (sink inactive at
	 * that moment) survived alongside the footer dock and the widget painted
	 * TWICE (duplicate schedules line, caught live via herdr pane.read). */
	slotInstalled?: boolean;
	model?: CrewWidgetModel;
	notificationCount?: number;
	/**
	 * Non-serializable dock host used when `widgetPlacement` is `"bottom"`:
	 * the dock renders through the crew-vibes footer instead of a pi widget
	 * slot. Kept off `model` so serialization/persistence of the rest of the
	 * state stays unaffected.
	 */
	footerDock?: { render(width: number): string[]; dispose(): void };
}
