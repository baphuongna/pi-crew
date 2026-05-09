import type { CrewAgentRecord } from "./crew-agent-runtime.ts";
import type { TeamRunManifest } from "../state/types.ts";
export { hasAsyncStartMarker } from "./async-marker.ts";

export interface ProcessLiveness {
	pid?: number;
	alive: boolean;
	detail: string;
}

const ORPHANED_ACTIVE_RUN_MS = 10 * 60 * 1000;
/** How long a completed run stays visible in the widget after completion. */
const COMPLETED_VISIBILITY_GRACE_MS = 8000;

export function checkProcessLiveness(pid: number | undefined): ProcessLiveness {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
		return { pid, alive: false, detail: "no pid recorded" };
	}
	try {
		process.kill(pid, 0);
		return { pid, alive: true, detail: "process is alive" };
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "EPERM") return { pid, alive: true, detail: "process exists but permission is denied" };
		if (nodeError.code === "ESRCH") return { pid, alive: false, detail: "process does not exist" };
		const message = error instanceof Error ? error.message : String(error);
		return { pid, alive: false, detail: message };
	}
}

export function isActiveRunStatus(status: string): boolean {
	return status === "queued" || status === "planning" || status === "running" || status === "waiting";
}

export function isLikelyOrphanedActiveRun(run: TeamRunManifest, agents: CrewAgentRecord[] = [], now = Date.now(), staleMs = ORPHANED_ACTIVE_RUN_MS): boolean {
	if (!isActiveRunStatus(run.status)) return false;
	if (run.async?.pid !== undefined) return false;
	const updatedAt = new Date(run.updatedAt).getTime();
	if (!Number.isFinite(updatedAt) || now - updatedAt < staleMs) return false;
	if (agents.length === 0) return run.summary === "Creating workflow prompts and placeholder results.";
	return agents.every((agent) => agent.status === "queued" && !agent.completedAt && !agent.progress);
}

function hasDurableActiveAgentEvidence(agent: CrewAgentRecord): boolean {
	if (agent.status !== "running" && agent.status !== "queued") return false;
	return Boolean(agent.statusPath || agent.eventsPath || agent.outputPath || agent.progress || agent.toolUses || agent.jsonEvents);
}

export function hasStaleAsyncProcess(run: TeamRunManifest): boolean {
	if (!isActiveRunStatus(run.status) || !run.async) return false;
	return !checkProcessLiveness(run.async.pid).alive;
}

export function isDisplayActiveRun(run: TeamRunManifest, agents: CrewAgentRecord[] = [], now = Date.now()): boolean {
	if (hasStaleAsyncProcess(run) || isLikelyOrphanedActiveRun(run, agents, now)) return false;
	// Grace period: show completed runs for a few seconds so users see the result.
	if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
		const lastAgentActivity = agents.reduce<number>((max, agent) => {
			const ts = agent.completedAt ?? agent.startedAt;
			const parsed = ts ? new Date(ts).getTime() : 0;
			return Number.isFinite(parsed) && parsed > max ? parsed : max;
		}, new Date(run.updatedAt).getTime());
		if (Number.isFinite(lastAgentActivity) && now - lastAgentActivity < COMPLETED_VISIBILITY_GRACE_MS) return true;
		return false;
	}
	if (!isActiveRunStatus(run.status)) return false;
	// Keep the always-visible widget quiet until a worker actually exists.
	// Empty active manifests can be created briefly at startup, by old fixture/scaffold
	// runs, or from cross-cwd registry history; showing them causes noisy 0/0 rows and
	// needless spinner redraws. The full dashboard can still list historical runs.
	if (agents.length === 0) return false;
	return agents.some(hasDurableActiveAgentEvidence);
}
