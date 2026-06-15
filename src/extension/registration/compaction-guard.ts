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
/** Run statuses that mean the run is still in-flight and may need resuming. */
const IN_FLIGHT_RUN_STATUSES = new Set(["queued", "planning", "running"]);

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

/**
 * Collect in-flight (non-terminal) crew runs that must be resumable after
 * compaction. These are runs the agent was actively working on or awaiting.
 */
function collectInFlightRuns(cwd: string): TeamRunManifest[] {
	return listRecentRuns(cwd, MAX_ARTIFACT_INDEX_RUNS).filter((run) =>
		IN_FLIGHT_RUN_STATUSES.has(run.status),
	);
}

/**
 * Build an explicit resume directive that survives compaction. This is the
 * core of O10 (compaction resilience): after compaction, the agent MUST know
 * what crew tasks were in-flight and how to continue them.
 */
function formatResumeDirective(runs: TeamRunManifest[]): string {
	if (!runs.length) return "";
	const lines = [
		"",
		"# pi-crew in-flight task resume directive (CRITICAL — do not drop)",
		"The following pi-crew runs were in progress when the context was compacted.",
		"After compaction, you MUST continue these tasks — do NOT consider them finished.",
	];
	for (const run of runs) {
		const wf = run.workflow ? `, workflow=${run.workflow}` : "";
		lines.push(
			`- runId=${run.runId} (status=${run.status}, team=${run.team}${wf}): ${run.goal}`,
		);
	}
	lines.push("");
	lines.push("To resume: call the `team` tool with action='status' to check progress, then");
	lines.push("action='wait' (to join a still-running task) or action='summary' / action='get'");
	lines.push("to retrieve results. If a task was mid-execution and the worker is still alive,");
	lines.push("it continues independently — just re-attach. Do not restart completed work.");
	return lines.join("\n");
}

/** Combined customInstructions injected into proactive compaction summaries. */
function buildCompactionInstructions(cwd: string): string {
	const artifactIndex = collectCrewArtifactIndex(cwd);
	const inFlight = collectInFlightRuns(cwd);
	const parts = [
		"Prioritize keeping pi-crew run state, task results, artifact references, run IDs, and next actions. Keep completed-task detail concise.",
	];
	if (artifactIndex.length > 0) parts.push(formatCrewArtifactIndex(artifactIndex));
	if (inFlight.length > 0) parts.push(formatResumeDirective(inFlight));
	return parts.join("\n");
}

export function registerCompactionGuard(pi: ExtensionAPI, options: RegisterCompactionGuardOptions): void {
	let pendingCompactReason: string | null = null;
	let compactionInProgress = false;

	const startCompact = (ctx: ExtensionContext, reason: string): void => {
		if (compactionInProgress) return;
		compactionInProgress = true;
		const customInstructions = buildCompactionInstructions(ctx.cwd);
		// Append a durable resume entry so it appears in the post-compaction
		// context regardless of how summarization treats customInstructions.
		const inFlight = collectInFlightRuns(ctx.cwd);
		if (inFlight.length > 0) {
			pi.appendEntry("crew:resume-directive", {
				reason,
				createdAt: new Date().toISOString(),
				runs: inFlight.map((r) => ({
					runId: r.runId,
					status: r.status,
					team: r.team,
					workflow: r.workflow,
					goal: r.goal,
				})),
			});
		}
		ctx.compact({
			customInstructions,
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

	// Allow compaction to proceed. pi-crew state is preserved via the
	// customInstructions + resume-directive entry appended in startCompact,
	// and re-injected post-compaction by the session_compact handler below.
	pi.on("session_before_compact", async (_event, _ctx) => {
		return;
	});

	// O10: After ANY compaction (proactive OR reactive/Pi-triggered), detect
	// in-flight crew runs and inject a continuation hint so the agent resumes
	// rather than abandoning the task. This covers the case where Pi
	// auto-compacts without going through our proactive startCompact path.
	pi.on("session_compact", (_event, ctx) => {
		try {
			const inFlight = collectInFlightRuns(ctx.cwd);
			if (inFlight.length === 0) return;
			// Re-append the resume directive into the fresh post-compaction
			// context. This entry is now the most recent and will be visible.
			pi.appendEntry("crew:resume-directive", {
				reason: "post-compaction-continuation",
				createdAt: new Date().toISOString(),
				runs: inFlight.map((r) => ({
					runId: r.runId,
					status: r.status,
					team: r.team,
					workflow: r.workflow,
					goal: r.goal,
				})),
			});
			ctx.ui.notify(
				`Context compacted. ${inFlight.length} pi-crew run(s) still in-flight — use team status to continue.`,
				"info",
			);
		} catch {
			// best-effort: never block compaction completion
		}
	});

	// Proactive compaction with dynamic threshold.
	pi.on("turn_end", (_event, ctx) => {
		if (compactionInProgress) return;
		const hasActiveForeground = options.foregroundControllers.size > 0 || options.foregroundTeamRunControllers.size > 0;
		const ratio = usageRatio(ctx);
		// If deferred compaction is pending and foreground just ended, check if still needed
		if (!hasActiveForeground && pendingCompactReason) {
			pendingCompactReason = null;
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
