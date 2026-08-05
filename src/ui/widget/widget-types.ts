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
}
