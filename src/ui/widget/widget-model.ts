/**
 * Widget data model — fetching, filtering, and caching.
 *
 * Extracted from crew-widget.ts.
 */

import { listRecentRuns } from "../../extension/run-index.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { evictStaleLiveAgentHandles } from "../../runtime/live-session/live-agent-manager.ts";
import type { ManifestCache } from "../../runtime/manifest-cache.ts";
import { isDisplayActiveRun } from "../../runtime/process-status.ts";
import { reconcileAllStaleRuns } from "../../runtime/recovery/crash-recovery.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { ACTIVE, RAIL, shortId } from "../rail.ts";
import type { RunSnapshotCache } from "../snapshot-types.ts";
import type { WidgetRun } from "./widget-types.ts";

let lastStaleReconcileAt = 0;
const STALE_RECONCILE_INTERVAL_MS = 60_000;

/** The dock/status-bar identity word (kept next to its only two painters). */
const IDLE_WORD = "CREW";

function agentsFor(run: TeamRunManifest): CrewAgentRecord[] {
	try {
		return readCrewAgents(run);
	} catch {
		return [];
	}
}

/**
 * Get active widget runs for display.
 */
export function activeWidgetRuns(
	cwd: string,
	manifestCache?: ManifestCache,
	snapshotCache?: RunSnapshotCache,
	preloadedManifests?: TeamRunManifest[],
	workspaceId?: string,
): WidgetRun[] {
	evictStaleLiveAgentHandles();

	const now = Date.now();
	if (now - lastStaleReconcileAt > STALE_RECONCILE_INTERVAL_MS && manifestCache) {
		lastStaleReconcileAt = now;
		try {
			reconcileAllStaleRuns(cwd, manifestCache, Date.now(), workspaceId);
		} catch {
			/* non-critical */
		}
	}

	let runs = preloadedManifests ?? (manifestCache ? manifestCache.list(20) : listRecentRuns(cwd, 20));
	if (workspaceId) {
		runs = runs.filter((run) => !run.ownerSessionId || run.ownerSessionId === workspaceId);
	}

	return runs
		.map((run) => {
			try {
				const snapshot = snapshotCache?.get(run.runId);
				if (snapshot) {
					return {
						run: snapshot.manifest,
						agents: snapshot.agents,
						snapshot,
					};
				}
				// P0-6: render from snapshots only — never read disk on every
				// render tick. When the snapshot cache is provided but hasn't
				// populated yet (first frame after `updateCrewWidget`), drop the
				// run from the result so the widget paints "(loading…)" instead
				// of calling `agentsFor(run) → readCrewAgents`. Legacy callers
				// (no snapshotCache) keep the disk-read fallback for tests/dev.
				if (snapshotCache) return null;
				return { run, agents: agentsFor(run) };
			} catch {
				if (snapshotCache) return null;
				return { run, agents: agentsFor(run) };
			}
		})
		.filter((item): item is WidgetRun => item !== null && isDisplayActiveRun(item.run, item.agents));
}

/**
 * Build a status summary string for the status bar (RAIL design system §2.B):
 *
 *   `┃ CREW ▸ 2r · 2q · 3/5 done · <model>`
 *
 * The rail glyph + identity word are the same ones the dock paints, so the
 * footer and the dock read as one surface. The multi-run case appends a
 * `N runs` segment (the `r`/`q` counts are AGENT counts, never run counts).
 */
export function statusSummary(runs: WidgetRun[]): string {
	const agents = runs.flatMap((item) => item.agents);
	const runningAgents = agents.filter((a) => a.status === "running").length;
	const queuedAgents = agents.filter((a) => a.status === "queued" || a.status === "waiting").length;
	const completedAgents = agents.filter((a) => a.status === "completed").length;
	const totalAgents = agents.length;
	const totalRuns = runs.length;
	const model = agents
		.find((a) => a.model)
		?.model?.split("/")
		.at(-1);
	// Zero counts are noise on a one-line status row (live 2026-09-16: after a run
	// finished the bar read `┃ CREW ▸ 0r · 3/3 done · MiniMax-M3`). Same rule the
	// dock header follows — a zero segment never prints.
	const parts: string[] = [];
	if (runningAgents > 0) parts.push(`${runningAgents}r`);
	if (queuedAgents > 0) parts.push(`${queuedAgents}q`);
	if (totalAgents > 0) parts.push(`${completedAgents}/${totalAgents} done`);
	if (totalRuns > 1) parts.push(`${totalRuns} runs`);
	if (model) parts.push(model);
	if (parts.length === 0) parts.push("idle");
	return `${RAIL.body} ${IDLE_WORD} ${ACTIVE} ${parts.join(" · ")}`;
}

/**
 * Build the short run label (team/workflow) — collapsed to ONE word when both
 * halves agree (`fast-fix/fast-fix` is what every built-in team produced in
 * live data), and guarded: a manifest read off disk may miss either half, and
 * a literal `undefined` must never reach a rendered line.
 */
export function shortRunLabel(run: TeamRunManifest): string {
	const team = (run.team ?? "").trim();
	const workflow = (run.workflow ?? "").trim();
	if (team && workflow && team !== workflow) return `${team}/${workflow}`;
	return team || workflow || shortId(run.runId);
}
