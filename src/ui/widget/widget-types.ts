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
}

export interface CrewWidgetState {
	frame: number;
	lastPlacement?: string;
	lastVisibility?: "hidden" | "visible";
	lastKey?: string;
	lastMaxLines?: number;
	lastCwd?: string;
	legacyCleared?: boolean;
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
