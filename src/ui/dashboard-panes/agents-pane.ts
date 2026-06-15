import type { RunDashboardOptions } from "../run-dashboard.ts";
import { iconForStatus } from "../status-colors.ts";
import type { RunUiSnapshot } from "../snapshot-types.ts";
import { spinnerFrame } from "../spinner.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { formatCost } from "../../state/usage.ts";
import { listLiveAgents, listLiveAgentsByWorkspace, type LiveAgentHandle } from "../../runtime/live-agent-manager.ts";

/**
 * Returns true if this agent did real work (LLM call, tool use, or non-trivial duration).
 * Scaffold-only agents (no tokens, no tools, no turns) are skipped in the agents pane —
 * they represent pipeline infrastructure steps, not actual agent execution.
 */
function isRealAgent(agent: CrewAgentRecord, liveHandle?: LiveAgentHandle): boolean {
	if (agent.runtime === "live-session" || agent.runtime === "child-process") return true;
	// Scaffold agents with real work done are still worth showing
	const tokens = (agent.usage?.input ?? 0) + (agent.usage?.output ?? 0) + (agent.usage?.cacheRead ?? 0) + (agent.usage?.cacheWrite ?? 0);
	if (tokens > 0) return true;
	const turns = (agent.usage as { turns?: number } | undefined)?.turns;
	if (turns != null && turns > 0) return true;
	if ((agent.progress?.toolCount ?? 0) > 0) return true;
	// If it's still running and has been alive for > 30s, it might be real
	if (liveHandle) {
		const ms = Date.now() - liveHandle.activity.startedAtMs;
		if (ms > 30_000) return true;
	}
	return false;
}

const TOOL_LABELS: Record<string, string> = {
	read: "reading",
	bash: "cmd",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding",
	ls: "listing",
};

function describeActivity(handle: LiveAgentHandle): string {
	const act = handle.activity;
	if (act.activeTools.size > 0) {
		const tools = [...new Set([...act.activeTools.values()])].map(t => TOOL_LABELS[t] ?? t);
		return tools.join(", ") + "…";
	}
	if (act.responseText?.trim()) {
		const line = act.responseText.split("\n").find((l) => l.trim())?.trim() ?? "";
		return line.length > 40 ? line.slice(0, 40) + "…" : line;
	}
	return "thinking…";
}

export function renderAgentsPane(snapshot: RunUiSnapshot | undefined, options: RunDashboardOptions = {}): string[] {
	if (!snapshot) return ["(snapshot unavailable)"];
	if (!snapshot.agents.length) return ["(no agents)"];
	// Filter live agents by workspaceId for session isolation
	const allLive = options.workspaceId
		? listLiveAgentsByWorkspace(options.workspaceId)
		: listLiveAgents();
	const liveForRun = allLive.filter(h => h.runId === snapshot.runId);
	const { completed, total } = snapshot.progress;

	const lines: string[] = [];

	const realAgents = snapshot.agents.filter(a => isRealAgent(a, liveForRun.find(h => h.taskId === a.taskId)));
	const lineCount = Math.min(realAgents.length, 12);
	const label = realAgents.length !== snapshot.agents.length
		? `${realAgents.length} real agents (${snapshot.agents.length} total)`
		: `${realAgents.length} agents`;

	lines.push(`${completed}/${total} tasks · ${label}`);

	for (const agent of realAgents.slice(0, 12)) {
		const liveHandle = liveForRun.find(h => h.taskId === agent.taskId);
		const icon = iconForStatus(agent.status, { runningGlyph: spinnerFrame(agent.taskId) });
		const role = `${agent.role}`;

		// Compact activity line
		const activity = liveHandle ? describeActivity(liveHandle)
			: agent.progress?.currentTool ? `${TOOL_LABELS[agent.progress.currentTool] ?? agent.progress.currentTool}…`
			: agent.status === "running" ? "thinking…"
			: agent.status === "queued" ? "queued"
			: agent.status === "failed" ? (agent.error ?? "failed")
			: "done";

		// Stats: tokens + cost + duration
		const stats: string[] = [];
		const tokenTotal = (agent.usage?.input ?? 0) + (agent.usage?.output ?? 0) + (agent.usage?.cacheRead ?? 0) + (agent.usage?.cacheWrite ?? 0);
		if (tokenTotal > 0) {
			const tok = tokenTotal >= 1000 ? `${(tokenTotal / 1000).toFixed(1)}k` : `${tokenTotal}`;
			stats.push(tok);
		}
		// Per-agent cost (Round 17 BS-1): the data is already on task.usage.cost;
		// surface it live so the user sees $ burn per agent during a run.
		if (agent.usage?.cost && agent.usage.cost > 0) {
			stats.push(formatCost(agent.usage.cost));
		}
		if (liveHandle) {
			const ms = (liveHandle.activity.completedAtMs ?? Date.now()) - liveHandle.activity.startedAtMs;
			stats.push(`${(ms / 1000).toFixed(1)}s`);
			if (options.showModel !== false && liveHandle.modelName && liveHandle.modelName !== "default") {
				stats.push(liveHandle.modelName);
			}
		} else if (agent.startedAt) {
			const ms = Date.now() - new Date(agent.startedAt).getTime();
			if (Number.isFinite(ms)) stats.push(`${(ms / 1000).toFixed(1)}s`);
		}

		const statsStr = stats.length ? ` · ${stats.join(" ")}` : "";
		lines.push(`  ${icon} ${agent.taskId} ${role}${statsStr}`);
		lines.push(`    ${activity}`);
	}

	if (snapshot.agents.length > 12) {
		lines.push(`  … +${snapshot.agents.length - 12} more`);
	}

	return lines;
}
