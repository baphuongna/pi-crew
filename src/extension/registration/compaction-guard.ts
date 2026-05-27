import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listRecentRuns } from "../run-index.ts";
import type { ArtifactDescriptor, TeamRunManifest } from "../../state/types.ts";

export interface RegisterCompactionGuardOptions {
	foregroundControllers: Map<string | symbol, AbortController>;
	foregroundTeamRunControllers: Map<string | symbol, AbortController>;
}

const TRIGGER_RATIO = 0.75;
const HARD_RATIO = 0.95;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const MAX_ARTIFACT_INDEX_RUNS = 10;
const MAX_ARTIFACT_INDEX_ITEMS = 80;

function contextWindow(ctx: { model?: { contextWindow?: number } }): number {
	const value = ctx.model?.contextWindow;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}

function usageRatio(ctx: { getContextUsage(): { tokens: number | null } | undefined; model?: { contextWindow?: number } }): number | undefined {
	const tokens = ctx.getContextUsage()?.tokens;
	if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return undefined;
	return tokens / contextWindow(ctx);
}

interface CrewArtifactIndexEntry {
	runId: string;
	status: TeamRunManifest["status"];
	team: string;
	workflow?: string;
	goal: string;
	artifact: Pick<ArtifactDescriptor, "kind" | "path" | "producer" | "sizeBytes" | "createdAt">;
}

function collectCrewArtifactIndex(cwd: string): CrewArtifactIndexEntry[] {
	const entries: CrewArtifactIndexEntry[] = [];
	for (const run of listRecentRuns(cwd, MAX_ARTIFACT_INDEX_RUNS)) {
		for (const artifact of run.artifacts) {
			entries.push({
				runId: run.runId,
				status: run.status,
				team: run.team,
				workflow: run.workflow,
				goal: run.goal,
				artifact: {
					kind: artifact.kind,
					path: artifact.path,
					producer: artifact.producer,
					sizeBytes: artifact.sizeBytes,
					createdAt: artifact.createdAt,
				},
			});
			if (entries.length >= MAX_ARTIFACT_INDEX_ITEMS) return entries;
		}
	}
	return entries;
}

function formatCrewArtifactIndex(entries: CrewArtifactIndexEntry[]): string {
	if (!entries.length) return "";
	const lines = ["", "# pi-crew artifact index", "Preserve these run artifact references in the compaction summary:"];
	for (const entry of entries) {
		lines.push(`- ${entry.artifact.kind}: ${entry.artifact.path} (run=${entry.runId}, status=${entry.status}, team=${entry.team}, workflow=${entry.workflow ?? "none"}, producer=${entry.artifact.producer})`);
	}
	return lines.join("\n");
}

export function registerCompactionGuard(pi: ExtensionAPI, options: RegisterCompactionGuardOptions): void {
	let pendingCompactReason: string | null = null;
	let compactionInProgress = false;

	const startCompact = (ctx: ExtensionContext, reason: string): void => {
		if (compactionInProgress) return;
		compactionInProgress = true;
		const artifactIndex = collectCrewArtifactIndex(ctx.cwd);
		if (artifactIndex.length > 0) {
			pi.appendEntry("crew:artifact-index", {
				reason,
				createdAt: new Date().toISOString(),
				artifacts: artifactIndex,
			});
		}
		ctx.compact({
			customInstructions: `Prioritize keeping pi-crew run state, task results, artifact references, run IDs, and next actions. Keep completed-task detail concise.${formatCrewArtifactIndex(artifactIndex)}`,
			onComplete: () => {
				compactionInProgress = false;
				ctx.ui.notify(reason === "deferred" ? "Deferred compaction completed" : "Auto-compacted context during team run", "info");
			},
			onError: (error) => {
				compactionInProgress = false;
				ctx.ui.notify(`${reason === "deferred" ? "Deferred" : "Auto"} compaction failed: ${error.message}`, "error");
			},
		});
	};

	// Phase 1.2: Always allow compaction to proceed.
	// Previously this deferred compaction during foreground runs, but that prevented
	// context-mode's PreCompact hook from running (which needs compaction to build resume snapshots).
	// pi-crew state is preserved via customInstructions and artifactIndex appended above.
	pi.on("session_before_compact", async (_event, ctx) => {
		// Always allow compaction - context-mode needs it for resume snapshots
		return;
	});

	// Phase 2.1: Proactive compaction with dynamic threshold.
	// Only trigger compaction when context usage >=75%, or when deferred from a previous high-usage turn.
	pi.on("turn_end", (_event, ctx) => {
		if (compactionInProgress) return;
		const hasActiveForeground = options.foregroundControllers.size > 0 || options.foregroundTeamRunControllers.size > 0;
		const ratio = usageRatio(ctx);
		// If deferred compaction is pending and foreground just ended, check if still needed
		if (!hasActiveForeground && pendingCompactReason) {
			pendingCompactReason = null;
			// Only compact if ratio still >= TRIGGER_RATIO, otherwise skip
			if (ratio === undefined || ratio < TRIGGER_RATIO) return;
			startCompact(ctx, "deferred");
			return;
		}
		if (ratio === undefined || ratio < TRIGGER_RATIO) return;
		// During foreground run: defer unless context is critically full
		if (hasActiveForeground) {
			if (ratio >= HARD_RATIO) {
				startCompact(ctx, "critical");
			} else {
				pendingCompactReason = "threshold-during-foreground-run";
			}
			return;
		}
		startCompact(ctx, "threshold");
	});
}
