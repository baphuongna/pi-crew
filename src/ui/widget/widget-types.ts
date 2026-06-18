/**
 * Widget type definitions.
 */

import type { TeamRunManifest } from "../../state/types.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import type { ManifestCache } from "../../runtime/manifest-cache.ts";
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
}

export interface CrewWidgetState {
	frame: number;
	interval?: ReturnType<typeof setInterval>;
	lastPlacement?: string;
	lastVisibility?: "hidden" | "visible";
	lastKey?: string;
	lastMaxLines?: number;
	lastCwd?: string;
	legacyCleared?: boolean;
	model?: CrewWidgetModel;
	notificationCount?: number;
}
