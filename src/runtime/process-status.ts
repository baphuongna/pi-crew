import type { TeamRunManifest } from "../state/types.ts";
import type { CrewAgentRecord } from "./crew-agent-runtime.ts";

export { hasAsyncStartMarker } from "./async-marker.ts";

export interface ProcessLiveness {
	pid?: number;
	alive: boolean;
	detail: string;
}

/**
 * How long (ms) a foreground team run with status "running" but no active agents
 * survives before being flagged as orphaned. Reduced from 10min to 2min to
 * improve UX: stuck foreground runs (e.g. planner with 0 tool calls) no longer
 * linger for 10min before the dashboard shows them as stale.
 */
const ORPHANED_ACTIVE_RUN_MS = 2 * 60 * 1000;
/** How long a completed run stays visible in the widget after completion. */
const COMPLETED_VISIBILITY_GRACE_MS = 8_000;
/** Errors (failed/cancelled) linger far longer so a failed run leaves a visible
 * trace in the crew widget for ~10 min (F-5). Successful completions vanish
 * quickly to keep the widget quiet. */
const ERROR_VISIBILITY_GRACE_MS = 10 * 60 * 1000;
/** Maximum age (ms) for an active run before it's considered stale.
 * After this time, PID-only liveness is unreliable due to PID recycling. */
const STALE_ACTIVE_RUN_MS = 30 * 60 * 1000;
/** Window (ms) during which an active run whose agents are all
 * completed/queued-without-evidence still counts as display-active: the
 * runner just wrote the manifest (task transition) and the next worker has
 * not recorded progress yet. Without this the dock flickers off between
 * phases of a healthy run. */
const SPAWN_GAP_VISIBILITY_MS = 60 * 1000;

export function checkProcessLiveness(pid: number | undefined): ProcessLiveness {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
		return { pid, alive: false, detail: "no pid recorded" };
	}
	try {
		process.kill(pid, 0);
		return { pid, alive: true, detail: "process is alive" };
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "EPERM")
			return {
				pid,
				alive: true,
				detail: "process exists but permission is denied",
			};
		if (nodeError.code === "ESRCH") return { pid, alive: false, detail: "process does not exist" };
		const message = error instanceof Error ? error.message : String(error);
		return { pid, alive: false, detail: message };
	}
}

export function isActiveRunStatus(status: string): boolean {
	return status === "queued" || status === "planning" || status === "running" || status === "waiting";
}

export function isFinishedRunStatus(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

/**
 * Secondary threshold: runs that have been "running" for more than this without
 * any active agents (all queued, no progress) are also considered orphaned.
 * This catches foreground team runs where the planner got stuck with 0 tool calls.
 */
const ORPHANED_NO_PROGRESS_MS = 5 * 60 * 1000;

export function isLikelyOrphanedActiveRun(
	run: TeamRunManifest,
	agents: CrewAgentRecord[] = [],
	now = Date.now(),
	staleMs = ORPHANED_ACTIVE_RUN_MS,
): boolean {
	if (!isActiveRunStatus(run.status)) return false;
	if (run.async?.pid !== undefined) return false;
	const updatedAt = new Date(run.updatedAt).getTime();
	if (!Number.isFinite(updatedAt)) return false;

	// Primary check: run hasn't been updated in a while
	if (now - updatedAt >= staleMs) {
		if (agents.length === 0) return run.summary === "Creating workflow prompts and placeholder results.";
		return agents.every((agent) => agent.status === "queued" && !agent.completedAt && !agent.progress);
	}

	// Secondary check: run has been running without any progress for too long
	if (now - updatedAt >= ORPHANED_NO_PROGRESS_MS) {
		// If no agent is "running" or has made progress, the run is likely stuck
		const hasActiveAgent = agents.some((agent) => agent.status === "running" || agent.progress || agent.toolUses);
		if (!hasActiveAgent && agents.length > 0) {
			return true;
		}
	}

	return false;
}

function hasDurableActiveAgentEvidence(agent: CrewAgentRecord): boolean {
	if (agent.status === "running") {
		// Running agents are actively executing — trust them.
		// Activity evidence is only required for queued agents (zombie prevention).
		return true;
	}
	if (agent.status === "queued") {
		// Queued agents need actual activity evidence to distinguish from zombies:
		// spawned-but-never-executed agents should not appear as active.
		return Boolean(
			(agent.progress && (agent.progress.toolCount > 0 || agent.progress.recentOutput.length > 0)) ||
				(agent.jsonEvents && agent.jsonEvents > 0) ||
				(agent.toolUses && agent.toolUses > 0),
		);
	}
	return false;
}

export function hasStaleAsyncProcess(run: TeamRunManifest, now = Date.now()): boolean {
	if (!isActiveRunStatus(run.status) || !run.async) return false;
	const pidAlive = checkProcessLiveness(run.async.pid).alive;
	if (!pidAlive) return true;
	// PID is alive, but check if the run is suspiciously old.
	// PID recycling means a stale PID could point to an unrelated process.
	const updatedAt = new Date(run.updatedAt).getTime();
	const age = now - updatedAt;
	if (Number.isFinite(updatedAt) && age > STALE_ACTIVE_RUN_MS) {
		// Additional evidence: if no agent has recent activity, treat as stale.
		// The real process would have updated the manifest within 30 minutes.
		return true;
	}
	return false;
}

export function isDisplayActiveRun(run: TeamRunManifest, agents: CrewAgentRecord[] = [], now = Date.now()): boolean {
	if (hasStaleAsyncProcess(run, now) || isLikelyOrphanedActiveRun(run, agents, now)) return false;
	// Hard filter: if an active-status run hasn't been updated in > STALE_ACTIVE_RUN_MS
	// and has no async PID tracking, it's a ghost from a crashed process.
	if (isActiveRunStatus(run.status) && !run.async) {
		const updatedAt = new Date(run.updatedAt).getTime();
		if (Number.isFinite(updatedAt) && now - updatedAt > STALE_ACTIVE_RUN_MS) return false;
	}
	// Grace period: show completed runs for a few seconds so users see the result.
	if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
		const grace = run.status === "completed" ? COMPLETED_VISIBILITY_GRACE_MS : ERROR_VISIBILITY_GRACE_MS;
		const lastAgentActivity = agents.reduce<number>((max, agent) => {
			const ts = agent.completedAt ?? agent.startedAt;
			const parsed = ts ? new Date(ts).getTime() : 0;
			return Number.isFinite(parsed) && parsed > max ? parsed : max;
		}, new Date(run.updatedAt).getTime());
		if (Number.isFinite(lastAgentActivity) && now - lastAgentActivity < grace) return true;
		return false;
	}
	if (!isActiveRunStatus(run.status)) return false;
	// Keep the always-visible widget quiet until a worker actually exists.
	// Empty active manifests can be created briefly at startup, by old fixture/scaffold
	// runs, or from cross-cwd registry history; showing them causes noisy 0/0 rows and
	// needless spinner redraws. The full dashboard can still list historical runs.
	if (agents.length === 0) return false;
	if (agents.some(hasDurableActiveAgentEvidence)) return true;
	// Spawn gap between phases: an active run whose manifest was JUST written
	// and whose next agents are queued/waiting without evidence yet stays
	// visible — the runner is alive and about to spawn them. Stale manifests
	// (zombies) fall through and stay hidden.
	if (agents.some((agent) => agent.status === "queued" || agent.status === "waiting")) {
		const updatedAt = new Date(run.updatedAt).getTime();
		if (Number.isFinite(updatedAt) && now - updatedAt < SPAWN_GAP_VISIBILITY_MS) return true;
	}
	return false;
}
